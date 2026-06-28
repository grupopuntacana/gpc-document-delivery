'use strict';

/**
 * Write one entry into the bound SAP Credential Store.
 *
 * The Credential Store has no cockpit editor; writes go through its REST API, and the
 * request body must be a JWE **encrypted to the store's public key** (the mirror of the
 * JWE-decrypt that `srv/lib/credstore.js` does on reads). This helper does that
 * encryption + POST, reusing the same binding so the auth (mTLS or Basic) matches.
 *
 * Usage:
 *   cf create-service-key document-delivery-credstore cli
 *   export CREDSTORE_CREDS="$(cf service-key document-delivery-credstore cli | tail -n +2)"
 *   node scripts/credstore-put.js key      CloudFrontPrivateKey "$(cat cloudfront_private_key.pem)"
 *   node scripts/credstore-put.js password AWS_ACCESS_KEY_ID     'AKIA...'
 *   node scripts/credstore-put.js password AWS_SECRET_ACCESS_KEY '...'
 *
 * Namespace defaults to gpc-document-delivery (override with CREDSTORE_NAMESPACE) —
 * it MUST match what credstore.js reads with.
 */

const crypto = require('crypto');
const https = require('https');

const NAMESPACE = process.env.CREDSTORE_NAMESPACE || 'gpc-document-delivery';

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error('usage: node scripts/credstore-put.js <password|key> <name> <value>');
  console.error('  (set CREDSTORE_CREDS to the `credentials` JSON from `cf service-key`)');
  process.exit(1);
}

function loadCreds() {
  const raw = process.env.CREDSTORE_CREDS;
  if (!raw) usage('CREDSTORE_CREDS is not set');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    usage(`CREDSTORE_CREDS is not valid JSON: ${e.message}`);
  }
  // `cf service-key` wraps the binding under `credentials`; accept either shape.
  const creds = parsed.credentials || parsed;
  if (!creds.url || !creds.encryption) usage('binding missing url/encryption — check CREDSTORE_CREDS');
  return creds;
}

/** The store's public key for encrypting write payloads (sibling of client_private_key). */
function serverPublicKey(creds) {
  const enc = creds.encryption;
  const b64 = enc.server_public_key || enc.serverPublicKey;
  if (!b64) {
    usage(
      `binding has no encryption.server_public_key — keys present: ${Object.keys(enc).join(', ')}`,
    );
  }
  return crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
}

/** POST a body over mTLS (client cert+key) or Basic auth, returning {status, body}. */
function httpsPost(urlStr, body, { cert, key, headers }) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'POST',
        cert,
        key,
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let b = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          b += d;
        });
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const [kind, name, ...rest] = process.argv.slice(2);
  const value = rest.join(' ');
  if (!kind || !name || !value) usage('missing args');
  if (kind !== 'password' && kind !== 'key') usage(`kind must be password|key, got "${kind}"`);

  const creds = loadCreds();
  const { CompactEncrypt } = await import('jose');

  // A `key` entry stores base64-encoded material; credstore.js base64-decodes it on read.
  // A `password` entry stores the raw string.
  const entry = kind === 'key'
    ? { name, value: Buffer.from(value, 'utf8').toString('base64'), format: 'pem' }
    : { name, value };

  // The store requires an `iat` (issued-at) header — epoch *seconds*, and rejected if
  // missing or older than 2 minutes (replay guard). Algorithms are fixed by the service:
  // RSA-OAEP-256 + A256GCM.
  const jwe = await new CompactEncrypt(Buffer.from(JSON.stringify(entry), 'utf8'))
    .setProtectedHeader({
      alg: 'RSA-OAEP-256',
      enc: 'A256GCM',
      iat: Math.floor(Date.now() / 1000),
    })
    .encrypt(serverPublicKey(creds));

  const url = `${creds.url}/${kind}`;
  const headers = {
    'sapcp-credstore-namespace': NAMESPACE,
    'Content-Type': 'application/jose',
    Accept: 'application/json;charset=UTF-8',
  };

  let res;
  if (creds.certificate && creds.key) {
    res = await httpsPost(url, jwe, { cert: creds.certificate, key: creds.key, headers });
  } else {
    const auth = Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
    const r = await fetch(url, {
      method: 'POST',
      headers: { ...headers, Authorization: `Basic ${auth}` },
      body: jwe,
    });
    res = { status: r.status, body: await r.text() };
  }

  if (res.status < 200 || res.status >= 300) {
    console.error(`FAILED: ${kind}/${name} -> HTTP ${res.status}\n${res.body}`);
    process.exit(1);
  }
  console.log(`OK: wrote ${kind} "${name}" to namespace "${NAMESPACE}"`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
