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

const LOG = require('@sap/cds').log('opentext');

// Routed through an overridable `deps` object so unit tests can patch the
// transport without mocking SAP Cloud SDK internals (see test/selftest.test.js).
const deps = {
  executeHttpRequest: require('@sap-cloud-sdk/http-client').executeHttpRequest,
  getDestination: require('@sap-cloud-sdk/connectivity').getDestination,
};

// The SAP Connectivity Service proxy (Cloud Connector tunnel) PINS each
// keep-alive socket to the first on-premise host it serves. Our flow hits two
// different virtual hosts — OTDS (otds-dev) to authenticate, then OTCS (otcs-dev)
// — and the SAP Cloud SDK's default agent pools sockets ACROSS hosts, so a socket
// pinned to the first host gets reused for the second. The proxy then rejects it
// with HTTP 403 "Access denied to resource ... on system otcs-dev". The original
// fix disabled keep-alive entirely (a fresh socket per call), but that makes every
// call pay a full TLS handshake through the tunnel (~part of the measured callMs).
//
// Refinement: give each host its OWN agent pair. A socket in the OTCS pool was only
// ever connected to OTCS, so reusing it for the next OTCS call honors the proxy's
// pinning instead of violating it — keep-alive WITHIN a host, never across. This is
// the hypothesis under test, so it's behind an env toggle defaulting to the proven-
// safe behavior (keep-alive OFF). Set OPENTEXT_KEEP_ALIVE=true to enable; if the 403
// returns, flip it back and restage — no redeploy.
const KEEP_ALIVE = process.env.OPENTEXT_KEEP_ALIVE === 'true';

function makeAgents() {
  return {
    httpAgent: new http.Agent({ keepAlive: KEEP_ALIVE }),
    httpsAgent: new https.Agent({ keepAlive: KEEP_ALIVE }),
  };
}

// Dedicated per-host agents so a pooled socket is never shared across OTDS/OTCS.
const otdsAgents = makeAgents();
const otcsAgents = makeAgents();

// --- endpoint paths (relative to each destination's base URL) ---
const OTDS_AUTH_PATH = '/otdsws/v1/authentication/credentials';
const OTCS_NODES_PATH = '/otcs/cs.exe/api/v2/nodes';

// OTCS node subtype for a document (validated CE 25.4, mirrors src/opentext_client.py).
const NODE_TYPE_DOCUMENT = 144;

// The folder-list call dominates a listing (~1.9s, measured). By default OTCS v2
// returns every property plus per-node `actions`/permission expansions, which the
// server has to compute and serialize for each child. We consume only id/name/type/
// size, so we ask for just those via the `fields` query param to cut server-side work
// and payload. Env-overridable as an escape hatch: set OTCS_LIST_FIELDS='' to revert
// to the full (unfiltered) response without a code change if a tenant rejects the param.
const LIST_FIELDS = process.env.OTCS_LIST_FIELDS != null
  ? process.env.OTCS_LIST_FIELDS
  : 'properties{id,name,type,size}';

// --- destination names (env-overridable for hybrid/test, defaults match the BTP cockpit) ---
const DEST_OTDS = process.env.OPENTEXT_OTDS_DESTINATION || 'OpenText_OTDS';
const DEST_OTCS = process.env.OPENTEXT_OTCS_DESTINATION || 'OpenText_OTCS';

/** Authenticate against OTDS and return the OTDS ticket. */
async function authenticate() {
  const dest = await deps.getDestination({ destinationName: DEST_OTDS });
  if (!dest) throw new Error(`Destination "${DEST_OTDS}" not found`);
  // The OTDS auth endpoint doesn't support CSRF preflight (HEAD/OPTIONS) — disable the
  // SAP Cloud SDK's CSRF middleware for this call (it's a JSON-body auth, not form-based).
  const res = await deps.executeHttpRequest(
    { destinationName: DEST_OTDS },
    {
      method: 'POST',
      url: OTDS_AUTH_PATH,
      headers: { 'Content-Type': 'application/json' },
      data: { user_name: dest.username, password: dest.password },
      disableCsrfTokenFetch: true,
      ...otdsAgents,
    },
  );
  const ticket = res.data && res.data.ticket;
  if (!ticket) throw new Error('OTDS authentication returned no ticket');
  return ticket;
}

// In-memory single-flight cache for the OTDS ticket. The ticket is reusable across
// requests, so re-authenticating on every listing wastes a full OTDS round trip
// (~600ms, measured). We cache the in-flight *promise* so a concurrent burst shares
// one auth, and use a conservative TTL — staleness is self-correcting because
// `withTicket` re-auths once on a 401 (forceRefresh) and the OTDS ticket lifetime is
// far longer than this. Set OTDS_TICKET_TTL_MS=0 to disable (tests).
const TICKET_TTL_MS = Number(
  process.env.OTDS_TICKET_TTL_MS != null ? process.env.OTDS_TICKET_TTL_MS : 10 * 60 * 1000,
);
let _ticketPromise = null;
let _ticketExpires = 0;

/** Cached OTDS ticket; `forceRefresh` re-authenticates and replaces the cache (post-401). */
function getTicket(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _ticketPromise && now < _ticketExpires) return _ticketPromise;
  _ticketExpires = now + TICKET_TTL_MS;
  _ticketPromise = authenticate();
  // Drop a cached rejection so the next call retries instead of serving a stuck error.
  _ticketPromise.catch(() => {
    _ticketPromise = null;
    _ticketExpires = 0;
  });
  return _ticketPromise;
}

/** Clear the cached ticket (tests / forced refresh). */
function clearTicketCache() {
  _ticketPromise = null;
  _ticketExpires = 0;
}

/** Issue an OTCS request with the OTDSTicket header. `cfg` is an http-client request config. */
function otcsRequest(ticket, cfg) {
  return deps.executeHttpRequest(
    { destinationName: DEST_OTCS },
    { ...cfg, headers: { OTDSTicket: ticket, ...(cfg.headers || {}) }, ...otcsAgents },
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
  // Timing split so logs separate the OTDS auth round trip (candidate for ticket
  // caching) from the actual OTCS operation. Both currently pay a fresh TLS
  // handshake because keep-alive is disabled (see noKeepAlive note above).
  const t0 = process.hrtime.bigint();
  let ticket = await getTicket(); // cached — authMs ~0 on a cache hit
  const t1 = process.hrtime.bigint();
  const ms = (a, b) => Math.round(Number(b - a) / 1e6);
  try {
    const out = await fn(ticket);
    // Per-phase timing at debug — raise the `opentext` logger to debug to see it
    // (see README "Debugging with logs"). authMs=0 means the OTDS ticket was cached.
    LOG.debug(`withTicket: authMs=${ms(t0, t1)} callMs=${ms(t1, process.hrtime.bigint())}`);
    return out;
  } catch (err) {
    if (status(err) !== 401) throw err;
    ticket = await getTicket(true); // stale ticket — force re-auth and retry once
    LOG.debug(`withTicket: re-auth after 401 (authMs=${ms(t0, t1)})`);
    return fn(ticket);
  }
}

/** Pull the node title out of an OTCS v2 node response, defensively. */
function nodeTitle(data) {
  const props = data && data.results && data.results.data && data.results.data.properties;
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
 * @returns {Promise<Array<{nodeId:number, name:string, sizeBytes:number,
 *   category:string, subtitle:string}>>}
 */
async function listFolder(folderId) {
  let url = `${OTCS_NODES_PATH}/${folderId}/nodes`;
  if (LIST_FIELDS) url += `?fields=${encodeURIComponent(LIST_FIELDS)}`;
  const res = await withTicket((ticket) => otcsRequest(ticket, { method: 'GET', url }));
  return flattenChildren(res.data)
    .filter((c) => Number(c && c.type) === NODE_TYPE_DOCUMENT)
    .map((c) => {
      const nodeId = Number(c.id);
      const name = c.name || `node-${nodeId}`;
      const { category, subtitle } = categorize(name);
      return {
        nodeId, name, sizeBytes: Number(c.size || 0), category, subtitle,
      };
    });
}

/**
 * Download a document's bytes from OpenText.
 * @returns {Promise<{buffer:Buffer,contentType:string}>}
 */
async function downloadDocument(nodeId) {
  const res = await withTicket((ticket) => otcsRequest(ticket, {
    method: 'GET',
    url: `${OTCS_NODES_PATH}/${nodeId}/content`,
    responseType: 'arraybuffer',
  }));
  const contentType = (res.headers
      && (res.headers['content-type'] || res.headers['Content-Type']))
    || 'application/pdf';
  return { buffer: Buffer.from(res.data), contentType };
}

/**
 * Fetch a node's display name (original filename). Mirrors Python `get_node_metadata`
 * used by `cdn_publisher.publish` to tag the S3 object with `original-filename`.
 * Best-effort: returns `${nodeId}.pdf` if the name can't be read.
 * @returns {Promise<string>}
 */
async function getNodeName(nodeId) {
  const res = await withTicket((ticket) => fetchNode(ticket, nodeId));
  return nodeTitle(res.data) || `${nodeId}.pdf`;
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
  getNodeName,
  categorize,
  NODE_TYPE_DOCUMENT,
  // exported for unit tests
  deps,
  authenticate,
  getTicket,
  clearTicketCache,
  fetchNode,
  nodeTitle,
  withTicket,
  DEST_OTDS,
  DEST_OTCS,
  OTDS_AUTH_PATH,
  OTCS_NODES_PATH,
};
