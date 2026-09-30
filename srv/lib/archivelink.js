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
 * URL (`seckey.js`). Signing switches on when a certificate is configured. The key pair lives in
 * the Credential Store, one entry each, so it rotates in one place with no redeploy:
 *
 *   ArchiveLinkSigningCert      the certificate registered on the repository (public, PEM)
 *   ArchiveLinkSigningKey       its private key
 *   (locally: ARCHIVELINK_SIGNING_CERT[_PATH] and ARCHIVELINK_SIGNING_KEY[_PATH])
 *   ARCHIVELINK_AUTH_ID         the id it is registered under; default `CN=<cert CN>`
 *   ARCHIVELINK_SIGNING_DIGEST  sha1 (protocol default) | sha256
 *
 * With no certificate configured requests go out unsigned, which is what a repository without
 * security expects. Authentication the destination itself carries is applied by the SAP Cloud
 * SDK as usual.
 *
 * Endpoint path and protocol constants live HERE, never in env (CLAUDE.md rule) — only the
 * destination name (base URL + credentials) is configurable.
 */

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

// Own agent pair, same reason as opentext.js: the Cloud Connector proxy pins a keep-alive
// socket to the first on-premise host it served, so a pool is never shared across hosts.
const agents = opentext.makeAgents();

// Signer memo, same expiry-stamped promise pattern as the CloudFront key: a burst shares one
// Credential Store read, a rotated key is picked up within the TTL, and a rejection is dropped
// so the next call retries. Set ARCHIVELINK_SIGNER_TTL_MS=0 to disable (tests).
const SIGNER_TTL_MS = Number(process.env.ARCHIVELINK_SIGNER_TTL_MS ?? 10 * 60 * 1000);
let _signerPromise = null;
let _signerExpires = 0;

/**
 * The parsed signer (`seckey.createSigner`), or null when no certificate is configured.
 * @returns {Promise<?ReturnType<typeof seckey.createSigner>>}
 */
function getSigner() {
  const now = Date.now();
  if (_signerPromise && now < _signerExpires) return _signerPromise;
  _signerExpires = now + SIGNER_TTL_MS;
  _signerPromise = (async () => {
    // Both halves come from the Credential Store: read them together (one round trip of wait,
    // not two). The key's error is held back until we know a certificate exists, so "no
    // certificate = signing off" still works without a key.
    const [certPem, keyRead] = await Promise.all([
      credstore.getArchiveLinkSigningCert(),
      credstore.getArchiveLinkSigningKey().then((keyPem) => ({ keyPem }), (error) => ({ error })),
    ]);
    if (!certPem) return null;
    if (keyRead.error) throw keyRead.error;
    return seckey.createSigner({
      keyPem: keyRead.keyPem,
      certPem,
      authId: process.env.ARCHIVELINK_AUTH_ID, // optional; defaults to CN=<certificate CN>
      digest: process.env.ARCHIVELINK_SIGNING_DIGEST || 'sha1',
    });
  })();
  _signerPromise.catch(() => {
    _signerPromise = null;
    _signerExpires = 0;
  });
  return _signerPromise;
}

/** Drop the memoized signer (tests / a key rotation without a restart). */
function clearSignerCache() {
  _signerPromise = null;
  _signerExpires = 0;
}

/**
 * The Content Server `get` URL for one component, signed when a `signer` is given. Inputs are
 * pre-validated by archives.js.
 */
function getUrl(contRep, archDocId, compId, signer = null) {
  const q = [
    'get',
    `pVersion=${PROTOCOL_VERSION}`,
    `contRep=${seckey.encodeParam(contRep)}`,
    `docId=${seckey.encodeParam(archDocId)}`,
    `compId=${seckey.encodeParam(compId)}`,
  ];
  if (signer) {
    // Already encoded by seckey (the same strings it signed): append as they are.
    const sig = seckey.readParams({ contRep, docId: archDocId }, signer);
    q.push(...Object.entries(sig).map(([k, v]) => `${k}=${v}`));
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
  // The server echoes the component's MIME type (PDF for print lists). There is no filename to
  // recover a type from, so a missing header falls back to application/octet-stream.
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
