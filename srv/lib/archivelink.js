'use strict';

/**
 * ArchiveLink content fetcher — reads an S/4-archived document from its content repository
 * over the **SAP Content Server HTTP protocol** (ADR 0009), through a BTP destination (Cloud
 * Connector tunnel for an on-premise archive server such as OpenText Archive Center).
 *
 *   GET {destination}/archive?get&pVersion=0045&contRep=C1&docId=<ARC_DOC_ID>&compId=data
 *
 * The protocol is the one S/4 itself speaks to the repository (OAC0), so any compliant archive
 * server works; which one a repository points at is config (`archives.js` → destination).
 *
 * **Signed URLs.** A repository that enforces security (C1 does — an unsigned read answers
 * `401 ICS:3003 … parameter secKey`) needs `accessMode`/`authId`/`expiration`/`secKey` on the
 * URL (`seckey.js`). Signing switches on when a certificate is configured:
 *
 *   ARCHIVELINK_SIGNING_CERT[_PATH]  the certificate registered on the repository (public, PEM)
 *   ArchiveLinkSigningKey            its private key — Credential Store, or
 *                                    ARCHIVELINK_SIGNING_KEY[_PATH] locally
 *   ARCHIVELINK_AUTH_ID              the id it is registered under; default `CN=<cert CN>`
 *   ARCHIVELINK_SIGNING_DIGEST       sha1 (protocol default) | sha256
 *
 * With no certificate configured requests go out unsigned, which is what a repository without
 * security expects. Authentication the destination itself carries is applied by the SAP Cloud
 * SDK as usual.
 *
 * Endpoint path and protocol constants live HERE, never in env (CLAUDE.md rule) — only the
 * destination name (base URL + credentials) is configurable.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');

const LOG = require('@sap/cds').log('archivelink');
const credstore = require('./credstore');
const opentext = require('./opentext');
const seckey = require('./seckey');

const deps = {
  executeHttpRequest: require('@sap-cloud-sdk/http-client').executeHttpRequest,
};

// OpenText Archive Center (and the SAP Content Server) serve the protocol under /archive.
const ARCHIVE_PATH = '/archive';
// 0045 is the protocol version every ArchiveLink-certified server supports.
const PROTOCOL_VERSION = '0045';

// Fresh socket per call, same reason as opentext.js: the Cloud Connector proxy pins a
// keep-alive socket to the first on-premise host it served.
const agents = {
  httpAgent: new http.Agent({ keepAlive: false }),
  httpsAgent: new https.Agent({ keepAlive: false }),
};

// A signed URL only has to outlive one request through the tunnel.
const SIGNATURE_TTL_SECONDS = 300;

let _signerPromise = null;

/** The configured certificate (PEM), or null when signing is off. */
function signingCert() {
  if (process.env.ARCHIVELINK_SIGNING_CERT) return process.env.ARCHIVELINK_SIGNING_CERT;
  if (process.env.ARCHIVELINK_SIGNING_CERT_PATH) {
    return fs.readFileSync(process.env.ARCHIVELINK_SIGNING_CERT_PATH, 'utf8');
  }
  return null;
}

/**
 * Resolve (once) the signer, or null when no certificate is configured. The promise is cached
 * so a burst shares one Credential Store read; a rejection is dropped so the next call retries.
 * @returns {Promise<?{keyPem:string, certPem:string, authId:string, digest:string}>}
 */
function getSigner() {
  if (_signerPromise) return _signerPromise;
  _signerPromise = (async () => {
    const certPem = signingCert();
    if (!certPem) return null;
    const keyPem = await credstore.getArchiveLinkSigningKey();
    // `subject` is "CN=name" lines; the archive registers a certificate under an authId that
    // conventionally is its subject (S/4 uses `CN=<SID>`).
    const cn = /CN=([^\n,]+)/.exec(new crypto.X509Certificate(certPem).subject);
    const authId = process.env.ARCHIVELINK_AUTH_ID || (cn ? `CN=${cn[1].trim()}` : '');
    if (!authId) throw new Error('ARCHIVELINK_AUTH_ID is required: the certificate has no CN');
    return {
      keyPem, certPem, authId, digest: process.env.ARCHIVELINK_SIGNING_DIGEST || 'sha1',
    };
  })();
  _signerPromise.catch(() => {
    _signerPromise = null;
  });
  return _signerPromise;
}

/** Drop the memoized signer (tests / a key rotation without a restart). */
function clearSignerCache() {
  _signerPromise = null;
}

/**
 * The Content Server `get` URL for one component, signed when a `signer` is given. Inputs are
 * pre-validated by archives.js.
 */
function getUrl(contRep, archDocId, compId, signer = null) {
  const q = [
    'get',
    `pVersion=${PROTOCOL_VERSION}`,
    `contRep=${encodeURIComponent(contRep)}`,
    `docId=${encodeURIComponent(archDocId)}`,
    `compId=${encodeURIComponent(compId)}`,
  ];
  if (signer) {
    const sig = seckey.readParams(
      { contRep, docId: archDocId },
      { ...signer, ttlSeconds: SIGNATURE_TTL_SECONDS },
    );
    q.push(...Object.entries(sig).map(([k, v]) => `${k}=${encodeURIComponent(v)}`));
  }
  return `${ARCHIVE_PATH}?${q.join('&')}`;
}

/**
 * Download one archived document's bytes.
 * @param {{contRep:string, archDocId:string, destination:string, compId:string}} loc
 * @returns {Promise<{buffer:Buffer, contentType:string}>}
 */
async function downloadDocument({
  contRep, archDocId, destination, compId,
}) {
  const res = await deps.executeHttpRequest(
    { destinationName: destination },
    {
      method: 'GET',
      url: getUrl(contRep, archDocId, compId, await getSigner()),
      responseType: 'arraybuffer',
      ...agents,
    },
    { fetchCsrfToken: false },
  );
  const headers = res.headers || {};
  // ArchiveLink document class (TOA01 RESERVE) is PDF for print lists; the server echoes the
  // component's MIME type. Recover it from nothing only as a last resort.
  const contentType = opentext.resolveContentType(headers['content-type'], null);
  LOG.debug(`fetched ${contRep}/${archDocId} bytes=${res.data?.length ?? 0} type=${contentType}`);
  return { buffer: Buffer.from(res.data), contentType };
}

module.exports = {
  downloadDocument,
  // exported for unit tests
  deps,
  getUrl,
  getSigner,
  clearSignerCache,
  ARCHIVE_PATH,
  PROTOCOL_VERSION,
};
