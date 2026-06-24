'use strict';

/**
 * OpenText (OTDS/OTCS) client over the BTP Destination Service.
 *
 * Milestone 1 of the BTP port: prove we can reach OpenText through a destination,
 * performing the OTDS-ticket auth dance the destination itself can't.
 *
 * Auth model (validated, CE 25.4 + OTDS federation — see CLAUDE.md):
 *   POST {OTDS}/otdsws/v1/authentication/credentials {user_name, password} -> {ticket}
 *   GET  {OTCS}/otcs/cs.exe/api/v2/nodes/<id>  header OTDSTicket: <ticket>
 * The OTDSTicket goes on EVERY OTCS call. OTCSTicket is diagnostic only in federated
 * mode and is NOT a valid standalone credential. Single retry on 401, no backoff.
 *
 * Connectivity + credentials live in two destinations (OTDS is on :8443, OTCS on :443):
 *   OpenText_OTDS  -> https://otion.grupopuntacana.com:8443  (BasicAuthentication: Admin/...)
 *   OpenText_OTCS  -> https://otion.grupopuntacana.com
 * The OTDS auth API wants the credentials in the JSON BODY, so we read them off the
 * BasicAuthentication destination and place them there.
 *
 * Endpoint paths are constants in THIS file — never in env (CLAUDE.md rule). Only the
 * destination names (i.e. base URLs + credentials) come from the environment.
 */

const http = require('http');
const https = require('https');

// Routed through an overridable `deps` object so unit tests can patch the
// transport without mocking SAP Cloud SDK internals (see test/selftest.test.js).
const deps = {
  executeHttpRequest: require('@sap-cloud-sdk/http-client').executeHttpRequest,
  getDestination: require('@sap-cloud-sdk/connectivity').getDestination,
};

// The SAP Connectivity Service proxy (Cloud Connector tunnel) PINS each
// keep-alive socket to the first on-premise host it serves. Our flow hits two
// different virtual hosts in sequence — OTDS (otds-dev) to authenticate, then
// OTCS (otcs-dev) — and the SAP Cloud SDK's default agent pools/reuses the
// socket, so the second host is sent over a socket pinned to the first. The
// proxy then rejects it with HTTP 403 "Access denied to resource ... on system
// otcs-dev" (which masquerades as a Cloud Connector access-control error).
// Forcing fresh, non-pooled connections gives each call its own socket, so no
// socket is ever reused across hosts. Validated in-container against the live
// tunnel: with keep-alive the OTCS call 403s, without it returns 200.
const noKeepAlive = {
  httpAgent: new http.Agent({ keepAlive: false }),
  httpsAgent: new https.Agent({ keepAlive: false }),
};

// --- endpoint paths (relative to each destination's base URL) ---
const OTDS_AUTH_PATH = '/otdsws/v1/authentication/credentials';
const OTCS_NODES_PATH = '/otcs/cs.exe/api/v2/nodes';

// OTCS node subtype for a document (validated CE 25.4, mirrors src/opentext_client.py).
const NODE_TYPE_DOCUMENT = 144;

// --- destination names (env-overridable for hybrid/test, defaults match the BTP cockpit) ---
const DEST_OTDS = process.env.OPENTEXT_OTDS_DESTINATION || 'OpenText_OTDS';
const DEST_OTCS = process.env.OPENTEXT_OTCS_DESTINATION || 'OpenText_OTCS';

/** Authenticate against OTDS and return the OTDS ticket. */
async function authenticate() {
  const dest = await deps.getDestination({ destinationName: DEST_OTDS });
  if (!dest) throw new Error(`Destination "${DEST_OTDS}" not found`);
  const res = await deps.executeHttpRequest(
    { destinationName: DEST_OTDS },
    {
      method: 'POST',
      url: OTDS_AUTH_PATH,
      headers: { 'Content-Type': 'application/json' },
      data: { user_name: dest.username, password: dest.password },
      ...noKeepAlive,
    }
  );
  const ticket = res.data && res.data.ticket;
  if (!ticket) throw new Error('OTDS authentication returned no ticket');
  return ticket;
}

/** Issue an OTCS request with the OTDSTicket header. `cfg` is an http-client request config. */
function otcsRequest(ticket, cfg) {
  return deps.executeHttpRequest(
    { destinationName: DEST_OTCS },
    { ...cfg, headers: { OTDSTicket: ticket, ...(cfg.headers || {}) }, ...noKeepAlive }
  );
}

/** GET an OTCS node, sending OTDSTicket on the request. */
function fetchNode(ticket, nodeId) {
  return otcsRequest(ticket, { method: 'GET', url: `${OTCS_NODES_PATH}/${nodeId}` });
}

/**
 * Authenticate, run `fn(ticket)`, and retry exactly once on a 401 with a fresh
 * ticket (re-auth, no backoff — per project rule). Centralizes the auth dance so
 * every OTCS operation gets the same OTDSTicket-on-every-call + single-retry behavior.
 */
async function withTicket(fn) {
  let ticket = await authenticate();
  try {
    return await fn(ticket);
  } catch (err) {
    if (status(err) !== 401) throw err;
    ticket = await authenticate(); // single retry
    return fn(ticket);
  }
}

/** Pull the node title out of an OTCS v2 node response, defensively. */
function nodeTitle(data) {
  const props =
    data && data.results && data.results.data && data.results.data.properties;
  return (props && (props.name || props.title)) || null;
}

/**
 * Self-test: authenticate to OTDS, fetch a node from OTCS, return diagnostics.
 * Retries once on 401 (re-authenticate), per project rule — no exponential backoff.
 * Never returns ticket material.
 *
 * @param {number} nodeId  defaults to 2000 (the validated bootstrap node)
 * @returns {Promise<{ok:boolean,status:number,nodeTitle:?string,ms:number}>}
 */
async function pingNode(nodeId = 2000) {
  const started = process.hrtime.bigint();
  const elapsedMs = () => Number(process.hrtime.bigint() - started) / 1e6;
  const res = await withTicket((ticket) => fetchNode(ticket, nodeId));
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    nodeTitle: nodeTitle(res.data),
    ms: Math.round(elapsedMs()),
  };
}

/** Flatten an OTCS v2 list payload (`results[i].data.properties`) to an array of property dicts. */
function flattenChildren(payload) {
  const results = payload && payload.results;
  if (Array.isArray(results)) {
    return results.map((item) => {
      const data = (item && item.data) || item || {};
      return (data && data.properties) || data;
    });
  }
  return Array.isArray(payload && payload.data) ? payload.data : []; // v1 fallback
}

/**
 * List the document children of a folder, shaped for the portal listing.
 * Mirrors demo/server.py `_discover_documents`: keep only documents (type 144),
 * derive (category, subtitle) from the filename.
 * @returns {Promise<Array<{nodeId:number,name:string,sizeBytes:number,category:string,subtitle:string}>>}
 */
async function listFolder(folderId) {
  const res = await withTicket((ticket) =>
    otcsRequest(ticket, { method: 'GET', url: `${OTCS_NODES_PATH}/${folderId}/nodes` })
  );
  return flattenChildren(res.data)
    .filter((c) => Number(c && c.type) === NODE_TYPE_DOCUMENT)
    .map((c) => {
      const nodeId = Number(c.id);
      const name = c.name || `node-${nodeId}`;
      const { category, subtitle } = categorize(name);
      return { nodeId, name, sizeBytes: Number(c.size || 0), category, subtitle };
    });
}

/**
 * Download a document's bytes from OpenText.
 * @returns {Promise<{buffer:Buffer,contentType:string}>}
 */
async function downloadDocument(nodeId) {
  const res = await withTicket((ticket) =>
    otcsRequest(ticket, {
      method: 'GET',
      url: `${OTCS_NODES_PATH}/${nodeId}/content`,
      responseType: 'arraybuffer',
    })
  );
  const contentType =
    (res.headers &&
      (res.headers['content-type'] || res.headers['Content-Type'])) ||
    'application/pdf';
  return { buffer: Buffer.from(res.data), contentType };
}

const YEAR_PREFIX = /^\d{4}-\d{2}-/;

/**
 * Infer (category, subtitle) from a filename — demo heuristic only (mirrors
 * demo/server.py `_categorize`). In production the category comes from the SAP
 * domain row that holds the node_id, not from sniffing the name.
 */
function categorize(name) {
  const lower = String(name).toLowerCase();
  if (lower.startsWith('factura') || lower.startsWith('invoice') || YEAR_PREFIX.test(lower)) {
    return { category: 'invoice', subtitle: 'documento de cobro' };
  }
  if (lower.includes('consumo') || lower.includes('consumption')) {
    return { category: 'energy', subtitle: 'informe de consumo energético' };
  }
  return { category: 'other', subtitle: 'documento' };
}

/** Extract an HTTP status code from an http-client error shape. */
function status(err) {
  return (err && err.response && err.response.status) || (err && err.status) || 0;
}

module.exports = {
  pingNode,
  listFolder,
  downloadDocument,
  categorize,
  NODE_TYPE_DOCUMENT,
  // exported for unit tests
  deps,
  authenticate,
  fetchNode,
  nodeTitle,
  withTicket,
  DEST_OTDS,
  DEST_OTCS,
  OTDS_AUTH_PATH,
  OTCS_NODES_PATH,
};
