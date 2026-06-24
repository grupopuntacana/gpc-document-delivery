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

// Routed through an overridable `deps` object so unit tests can patch the
// transport without mocking SAP Cloud SDK internals (see test/selftest.test.js).
const deps = {
  executeHttpRequest: require('@sap-cloud-sdk/http-client').executeHttpRequest,
  getDestination: require('@sap-cloud-sdk/connectivity').getDestination,
};

// --- endpoint paths (relative to each destination's base URL) ---
const OTDS_AUTH_PATH = '/otdsws/v1/authentication/credentials';
const OTCS_NODES_PATH = '/otcs/cs.exe/api/v2/nodes';

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
    }
  );
  const ticket = res.data && res.data.ticket;
  if (!ticket) throw new Error('OTDS authentication returned no ticket');
  return ticket;
}

/** GET an OTCS node, sending OTDSTicket on the request. */
function fetchNode(ticket, nodeId) {
  return deps.executeHttpRequest(
    { destinationName: DEST_OTCS },
    {
      method: 'GET',
      url: `${OTCS_NODES_PATH}/${nodeId}`,
      headers: { OTDSTicket: ticket },
    }
  );
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

  let ticket = await authenticate();
  let res;
  try {
    res = await fetchNode(ticket, nodeId);
  } catch (err) {
    if (status(err) === 401) {
      ticket = await authenticate(); // single retry
      res = await fetchNode(ticket, nodeId);
    } else {
      throw err;
    }
  }
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    nodeTitle: nodeTitle(res.data),
    ms: Math.round(elapsedMs()),
  };
}

/** Extract an HTTP status code from an http-client error shape. */
function status(err) {
  return (err && err.response && err.response.status) || (err && err.status) || 0;
}

module.exports = {
  pingNode,
  // exported for unit tests
  deps,
  authenticate,
  fetchNode,
  nodeTitle,
  DEST_OTDS,
  DEST_OTCS,
  OTDS_AUTH_PATH,
  OTCS_NODES_PATH,
};
