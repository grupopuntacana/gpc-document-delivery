'use strict';

/**
 * ArchiveLink probe — discover what a content repository needs, against the REAL archive
 * server, using srv/lib/archivelink.js UNCHANGED (ADR 0009). Read-only: it only issues
 * `serverInfo`, `getCert` and `get`.
 *
 * Two ways to reach the server:
 *   in-office, no BTP:   ARCHIVE_URL=http://OTEMO.grupopuntacana.com:8082 node scripts/probe-archivelink.js
 *   through the tunnel:  npx cds bind --exec --profile hybrid -- node scripts/probe-archivelink.js
 *                        (uses the bound `OpenText_OTAC` destination + Cloud Connector)
 *
 * Inputs (env):
 *   CONTREP=C1                      repository to probe (default C1)
 *   ARCH_DOC_ID=<ARC_DOC_ID>        a real document id (TOA01) — enables the `get` steps
 *   ARCHIVELINK_SIGNING_CERT_PATH   + ARCHIVELINK_SIGNING_KEY_PATH → also try a SIGNED get
 *   ARCHIVELINK_AUTH_ID             authId the certificate is registered under (default CN=<cn>)
 *   OUT=bill.pdf                    write the fetched bytes here
 *
 * What each step tells you:
 *   1 serverInfo   reachable? which product/version? is the repository running?
 *   2 getCert      which certificates the repository trusts, their key type and permissions
 *   3 unsigned get 200 → no signing needed; 401 ICS:3003 → the repository requires secKey
 *   4 signed get   200 → our certificate is registered and enabled; 401 → not yet (or wrong authId)
 */

const crypto = require('crypto');
const fs = require('fs');

const DEST = process.env.ARCHIVELINK_DESTINATION || 'OpenText_OTAC';
const CONTREP = process.env.CONTREP || 'C1';
const ARCH_DOC_ID = process.env.ARCH_DOC_ID || '';

if (process.env.ARCHIVE_URL) {
  // The SAP Cloud SDK reads this env var before the Destination Service, so the library code
  // runs unchanged against a direct in-office URL.
  process.env.destinations = JSON.stringify([
    { name: DEST, url: process.env.ARCHIVE_URL, authentication: 'NoAuthentication' },
  ]);
}

const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
const archivelink = require('../srv/lib/archivelink');
const opentext = require('../srv/lib/opentext');

const say = (...a) => console.log(...a); // eslint-disable-line no-console

async function call(url, responseType = 'text') {
  try {
    const res = await executeHttpRequest(
      { destinationName: DEST },
      { method: 'GET', url, responseType },
      { fetchCsrfToken: false },
    );
    return { status: res.status, data: res.data, headers: res.headers || {} };
  } catch (err) {
    const r = err.response || (err.cause && err.cause.response) || {};
    return {
      status: r.status || 0,
      headers: r.headers || {},
      error: (r.headers && r.headers['x-errordescription']) || opentext.describeError(err),
    };
  }
}

function describeCert(hex) {
  try {
    const c = new crypto.X509Certificate(Buffer.from(hex, 'hex'));
    const key = c.publicKey;
    const bits = key.asymmetricKeyDetails && key.asymmetricKeyDetails.modulusLength;
    return `${c.subject.replace(/\n/g, ', ')} · ${key.asymmetricKeyType}${bits ? ` ${bits}` : ''}`
      + ` · valid to ${c.validTo}`;
  } catch (e) {
    return `(unparseable certificate: ${e.message})`;
  }
}

async function tryGet(label, signer) {
  const res = await call(archivelink.getUrl(CONTREP, ARCH_DOC_ID, 'data', signer), 'arraybuffer');
  if (res.status === 200) {
    const buf = Buffer.from(res.data);
    say(`   ${label}: 200 · ${buf.length} bytes · ${res.headers['content-type']}`);
    if (process.env.OUT) {
      fs.writeFileSync(process.env.OUT, buf);
      say(`   wrote ${process.env.OUT}`);
    }
  } else {
    say(`   ${label}: ${res.status} · ${res.error}`);
  }
  return res.status;
}

(async () => {
  say(`destination ${DEST}${process.env.ARCHIVE_URL ? ` → ${process.env.ARCHIVE_URL} (direct)` : ' (bound)'}`);

  say('\n1. serverInfo');
  const info = await call(`${archivelink.ARCHIVE_PATH}?serverInfo&pVersion=${archivelink.PROTOCOL_VERSION}&contRep=${CONTREP}&resultAs=ascii`);
  if (info.status !== 200) {
    say(`   ${info.status} · ${info.error}`);
    say('   → the server is not reachable through this destination; fix connectivity first.');
    process.exit(1);
  }
  say(`   ${String(info.data).trim().replace(/\r?\n/g, '\n   ')}`);

  say('\n2. getCert (certificates the repository trusts)');
  const certs = await call(`${archivelink.ARCHIVE_PATH}?getCert&pVersion=0046&contRep=${CONTREP}`);
  if (certs.status === 200) {
    const text = String(certs.data);
    const hexes = [...text.matchAll(/certificate="([0-9A-Fa-f]+)"/g)].map((m) => m[1]);
    const perms = [...text.matchAll(/permissions="([a-z]*)"/g)].map((m) => m[1]);
    hexes.forEach((h, i) => say(`   [${perms[i] || '?'}] ${describeCert(h)}`));
    if (!hexes.length) say('   (none listed)');
  } else {
    say(`   ${certs.status} · ${certs.error}`);
  }

  if (!ARCH_DOC_ID) {
    say('\nSet ARCH_DOC_ID=<a TOA01 ARC_DOC_ID> to test reading a document.');
    return;
  }

  say('\n3. unsigned get');
  const unsigned = await tryGet('unsigned', null);
  if (unsigned === 200) say('   → the repository does NOT require signed URLs.');
  if (unsigned === 401) say('   → the repository requires signed URLs (secKey).');

  say('\n4. signed get');
  const signer = await archivelink.getSigner().catch((e) => {
    say(`   signer unavailable: ${e.message}`);
    return null;
  });
  if (!signer) {
    say('   skipped — set ARCHIVELINK_SIGNING_CERT_PATH and ARCHIVELINK_SIGNING_KEY_PATH.');
    return;
  }
  say(`   authId ${signer.authId} · digest ${signer.digest}`);
  const signed = await tryGet('signed', signer);
  if (signed === 401) {
    say('   → the certificate is not registered/enabled on the repository under this authId yet.');
  }
})();
