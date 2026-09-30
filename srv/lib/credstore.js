'use strict';

/**
 * SAP Credential Store reader.
 *
 * Milestone 1 of the BTP port: prove we can source the HMAC `SHARED_LINK_SECRET`
 * and the CloudFront private key from a bound Credential Store service at runtime
 * — instead of from `.env` like the Python prototype (`src/token_redirect.py::_secret`).
 *
 * Credential Store has no official npm SDK. Access is its REST API plus a namespace
 * header. Newer instances are provisioned with `authentication.type: mtls`, so the
 * binding ships a client `certificate` + `key` (X.509) that we present via mutual TLS.
 * Older Basic-auth instances expose `username`/`password` instead — we support both.
 * Responses come back as a compact JWE encrypted to the binding's client key pair;
 * we decrypt with `encryption.client_private_key` (RSA-OAEP-256 / A256GCM).
 *
 * Local / hybrid / test fallback: if no `credstore` binding is present, fall back to
 * `process.env.SHARED_LINK_SECRET` (+ `CLOUDFRONT_PRIVATE_KEY` / `_PATH`) so that
 * `cds watch` and vitest run with no BTP services bound. The secret VALUE must stay
 * byte-identical to the Python side (`.env`) or every existing token breaks — see the
 * cross-side interop contract in CLAUDE.md.
 */

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');

const NAMESPACE = process.env.CREDSTORE_NAMESPACE || 'gpc-document-delivery';

let _xsenv;
function xsenv() {
  if (_xsenv === undefined) {
    try {
      _xsenv = require('@sap/xsenv');
    } catch {
      _xsenv = null;
    }
  }
  return _xsenv;
}

/** Returns the bound credstore credentials, or null when unbound (local/test). */
function binding() {
  const env = xsenv();
  if (!env) return null;
  try {
    const { credstore } = env.getServices({ credstore: { label: 'credstore' } });
    return credstore || null;
  } catch {
    return null; // not bound — caller falls back to env
  }
}

/**
 * GET over mutual TLS (client cert + key) using the built-in https module, so we
 * don't pull in undici/axios just to present a client certificate. Returns the raw
 * text body (the Credential Store responds with a compact JWE).
 */
function httpsGet(urlStr, { cert, key, headers }) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'GET',
        cert,
        key,
        headers,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          body += d;
        });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Fetch and decrypt one entry from the Credential Store REST API.
 * `kind` is 'password' or 'key'. Returns the parsed entry object.
 *
 * Auth: mTLS when the binding carries a `certificate` + `key` (the current default),
 * else Basic auth via `username`/`password` (legacy instances).
 */
async function fetchEntry(creds, kind, name) {
  const { compactDecrypt } = await import('jose');

  const url = `${creds.url}/${kind}?name=${encodeURIComponent(name)}`;
  const headers = {
    'sapcp-credstore-namespace': NAMESPACE,
    Accept: 'application/json;charset=UTF-8',
  };

  let status;
  let jwe;
  if (creds.certificate && creds.key) {
    // mTLS: present the binding's client certificate.
    ({ status, body: jwe } = await httpsGet(url, {
      cert: creds.certificate,
      key: creds.key,
      headers,
    }));
  } else {
    // Legacy Basic auth.
    const auth = Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
    const res = await fetch(url, {
      method: 'GET',
      headers: { ...headers, Authorization: `Basic ${auth}` },
    });
    status = res.status;
    jwe = await res.text();
  }
  if (status < 200 || status >= 300) {
    // `status` rides on the error so a caller can tell "entry absent" (404) from a real failure.
    throw Object.assign(new Error(`Credential Store ${kind}/${name} -> HTTP ${status}`), { status });
  }

  // Response body is a compact JWE encrypted to our client key.
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(creds.encryption.client_private_key, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const { plaintext } = await compactDecrypt(jwe, privateKey);
  return JSON.parse(Buffer.from(plaintext).toString('utf8'));
}

// In-memory single-flight cache for the HMAC secret. The secret is process-stable
// (the same value across every app instance), so a per-instance memo is correct and
// far cheaper than a Credential Store round trip per token — listing N documents mints
// N tokens, each of which needs the secret. We cache the in-flight *promise* (not just
// the resolved value) so a concurrent burst (Promise.all over the listing) collapses to
// ONE fetch instead of N. A short TTL lets a rotated secret be picked up without a
// restart; set CREDSTORE_SECRET_TTL_MS=0 to disable caching (tests).
const SECRET_TTL_MS = Number(process.env.CREDSTORE_SECRET_TTL_MS ?? 10 * 60 * 1000);
let _secretPromise = null;
let _secretExpires = 0;

/** Uncached read of the secret (credstore binding, else env fallback). */
async function readSharedLinkSecret() {
  const creds = binding();
  if (creds) {
    const entry = await fetchEntry(creds, 'password', 'SHARED_LINK_SECRET');
    return entry.value;
  }
  const fromEnv = process.env.SHARED_LINK_SECRET;
  if (!fromEnv) {
    throw new Error(
      'SHARED_LINK_SECRET unavailable: no credstore binding and env var unset. '
        + 'Bind the Credential Store, or set SHARED_LINK_SECRET for local/hybrid runs.',
    );
  }
  return fromEnv;
}

/**
 * The HMAC secret used to verify sharing tokens. Cached in-memory (single-flight,
 * TTL `CREDSTORE_SECRET_TTL_MS`) so repeated token mint/verify don't re-hit the store.
 * @returns {Promise<string>} the raw secret string (UTF-8), never logged.
 */
async function getSharedLinkSecret() {
  const now = Date.now();
  if (_secretPromise && now < _secretExpires) return _secretPromise;
  _secretExpires = now + SECRET_TTL_MS;
  _secretPromise = readSharedLinkSecret();
  // On failure, drop the cached rejection so the next call retries instead of
  // serving a stuck error for the whole TTL window.
  _secretPromise.catch(() => {
    _secretPromise = null;
    _secretExpires = 0;
  });
  return _secretPromise;
}

/** Clear the cached secret (tests / forced refresh after a known rotation). */
function clearSecretCache() {
  _secretPromise = null;
  _secretExpires = 0;
}

// The seam tests mock: the binding lookup and the REST read (see test/selftest.test.js).
const deps = { binding, fetchEntry };

/** A Credential Store `key` entry as PEM. Entries carry the material base64-encoded in `value`. */
async function readPemEntry(creds, entryName) {
  const entry = await deps.fetchEntry(creds, 'key', entryName);
  const raw = Buffer.from(entry.value, 'base64').toString('utf8');
  return raw.includes('-----BEGIN') ? raw : entry.value;
}

/** The `<envName>` / `<envName>_PATH` fallback for local/hybrid/test runs; null when unset. */
function pemFromEnv(envName) {
  if (process.env[envName]) return process.env[envName];
  if (process.env[`${envName}_PATH`]) return fs.readFileSync(process.env[`${envName}_PATH`], 'utf8');
  return null;
}

/**
 * Read a PEM private key: Credential Store `key` entry `entryName` when bound, else the env
 * fallback. A key that should exist and doesn't is an error.
 */
async function getPemKey(entryName, envName, label) {
  const creds = deps.binding();
  if (creds) return readPemEntry(creds, entryName);
  const pem = pemFromEnv(envName);
  if (pem) return pem;
  throw new Error(`${label} unavailable: no credstore binding and no ${envName}[_PATH].`);
}

/**
 * The CloudFront signing private key (PEM).
 * @returns {Promise<string>} PEM-encoded RSA private key.
 */
function getCloudFrontPrivateKey() {
  return getPemKey('CloudFrontPrivateKey', 'CLOUDFRONT_PRIVATE_KEY', 'CloudFront private key');
}

/**
 * The ArchiveLink `secKey` signing private key (PEM) — ADR 0009. Its certificate is the sibling
 * entry, `getArchiveLinkSigningCert`.
 * @returns {Promise<string>} PEM-encoded RSA or DSA private key.
 */
function getArchiveLinkSigningKey() {
  return getPemKey('ArchiveLinkSigningKey', 'ARCHIVELINK_SIGNING_KEY', 'ArchiveLink signing key');
}

/**
 * The certificate registered on the ArchiveLink repository for `secKey`-signed reads (PEM), or
 * null when none is configured — which is how signing is switched off (ADR 0009).
 *
 * It lives beside its private key: Credential Store `key` entry `ArchiveLinkSigningCert`. The
 * certificate is public, but the two are one pair and rotate together, so they are stored and
 * replaced in one place, with no redeploy. `ARCHIVELINK_SIGNING_CERT` / `_PATH` is the fallback
 * for local/hybrid runs, and for a bound store that has no entry yet.
 * @returns {Promise<?string>}
 */
async function getArchiveLinkSigningCert() {
  const creds = deps.binding();
  if (creds) {
    try {
      return await readPemEntry(creds, 'ArchiveLinkSigningCert');
    } catch (err) {
      // Absent is a legal state (signing off / env fallback); anything else is a real failure.
      if (err.status !== 404) throw err;
    }
  }
  return pemFromEnv('ARCHIVELINK_SIGNING_CERT');
}

// In-memory single-flight cache for the AWS S3 credentials. Like the HMAC secret these
// are process-stable, so a per-instance memo avoids a Credential Store round trip on
// every cache miss. Cache the in-flight *promise* so a concurrent burst collapses to one
// pair of fetches. Short TTL picks up a rotation without a restart;
// set CREDSTORE_AWS_TTL_MS=0 to disable (tests).
const AWS_TTL_MS = Number(
  process.env.CREDSTORE_AWS_TTL_MS != null ? process.env.CREDSTORE_AWS_TTL_MS : 10 * 60 * 1000,
);
let _awsPromise = null;
let _awsExpires = 0;

/** Uncached read of the AWS S3 credentials (credstore binding, else env fallback). */
async function readAwsCredentials() {
  const creds = binding();
  if (creds) {
    const [id, secret] = await Promise.all([
      fetchEntry(creds, 'password', 'AWS_ACCESS_KEY_ID'),
      fetchEntry(creds, 'password', 'AWS_SECRET_ACCESS_KEY'),
    ]);
    return { accessKeyId: id.value, secretAccessKey: secret.value };
  }
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      'AWS credentials unavailable: no credstore binding and AWS_ACCESS_KEY_ID/'
        + 'AWS_SECRET_ACCESS_KEY unset. Bind the Credential Store, or set them for local/hybrid runs.',
    );
  }
  return { accessKeyId, secretAccessKey };
}

/**
 * The AWS access key/secret for the S3 write-through cache. Cached in-memory
 * (single-flight, TTL `CREDSTORE_AWS_TTL_MS`) so repeated cache misses don't re-hit
 * the store. Only Layer 2 (`cdn.js`) needs these — signing (Layer 1) does not.
 * @returns {Promise<{accessKeyId:string,secretAccessKey:string}>}
 */
async function getAwsCredentials() {
  const now = Date.now();
  if (_awsPromise && now < _awsExpires) return _awsPromise;
  _awsExpires = now + AWS_TTL_MS;
  _awsPromise = readAwsCredentials();
  _awsPromise.catch(() => {
    _awsPromise = null;
    _awsExpires = 0;
  });
  return _awsPromise;
}

/** Clear the cached AWS credentials (tests / forced refresh after a known rotation). */
function clearAwsCache() {
  _awsPromise = null;
  _awsExpires = 0;
}

/**
 * Diagnostic: are we reading from a live Credential Store binding (true)
 * or env fallback (false)?
 */
function isBound() {
  return binding() !== null;
}

module.exports = {
  getSharedLinkSecret,
  getCloudFrontPrivateKey,
  getArchiveLinkSigningKey,
  getArchiveLinkSigningCert,
  getAwsCredentials,
  isBound,
  clearSecretCache,
  clearAwsCache,
  NAMESPACE,
  // exported for unit tests
  deps,
};
