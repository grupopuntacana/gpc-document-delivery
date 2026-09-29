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
 * Out of scope for v1: **signed URLs** (`accessMode`/`authId`/`expiration`/`secKey`). A
 * repository configured to require signatures answers 401/403 here; that surfaces as a 502 with
 * the upstream reason, and signing (a BTP certificate registered on the repository) becomes a
 * follow-up task. Authentication the destination itself carries (e.g. BasicAuthentication) is
 * applied by the SAP Cloud SDK as usual.
 *
 * Endpoint path and protocol constants live HERE, never in env (CLAUDE.md rule) — only the
 * destination name (base URL + credentials) is configurable.
 */

const http = require('http');
const https = require('https');

const LOG = require('@sap/cds').log('archivelink');
const opentext = require('./opentext');

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

/** The Content Server `get` URL for one component. Inputs are pre-validated by archives.js. */
function getUrl(contRep, archDocId, compId) {
  const q = [
    'get',
    `pVersion=${PROTOCOL_VERSION}`,
    `contRep=${encodeURIComponent(contRep)}`,
    `docId=${encodeURIComponent(archDocId)}`,
    `compId=${encodeURIComponent(compId)}`,
  ].join('&');
  return `${ARCHIVE_PATH}?${q}`;
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
      url: getUrl(contRep, archDocId, compId),
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
  ARCHIVE_PATH,
  PROTOCOL_VERSION,
};
