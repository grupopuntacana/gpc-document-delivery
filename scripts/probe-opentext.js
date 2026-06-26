'use strict';

/**
 * Local OpenText probe — iterate on the OTDS/OTCS auth dance against the REAL
 * OpenText, in-office, with NO deploy and NO Cloud Connector.
 *
 * It builds the SAP Cloud SDK `destinations` env var (which getDestination reads
 * when present) so srv/lib/opentext.js runs UNCHANGED, then calls each step and
 * prints the actual HTTP status + response body on failure (the deployed handler
 * hides this behind "status code 403").
 *
 * Creds are read from the Python prototype .env so nothing secret hits the CLI:
 *   ../python/opentext-cdn-prototype/.env  (OTCS_USERNAME / OTCS_PASSWORD / *_BASE_URL)
 *
 * Usage:
 *   node scripts/probe-opentext.js                 # NoAuth OTCS (Python parity: OTDSTicket only)
 *   OTCS_AUTH=basic node scripts/probe-opentext.js # BasicAuth (deployed dest adds Authorization)
 *   FOLDER_ID=2000 node scripts/probe-opentext.js  # also exercise listFolder
 */

const fs = require('fs');
const path = require('path');

function loadDotEnv(p) {
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const envPath = path.resolve(__dirname, '../../python/opentext-cdn-prototype/.env');
const e = loadDotEnv(envPath);
const user = process.env.OTCS_USERNAME || e.OTCS_USERNAME;
const pass = process.env.OTCS_PASSWORD || e.OTCS_PASSWORD;
const otdsUrl = e.OTDS_BASE_URL || 'https://otion.grupopuntacana.com:8443';
const otcsUrl = e.OTCS_BASE_URL || 'https://otion.grupopuntacana.com';

// Toggle: does OTCS get a Basic Authorization header (like the deployed BasicAuth
// destination) or NoAuth (only OTDSTicket, like the Python client)?
const otcsBasic = (process.env.OTCS_AUTH || '').toLowerCase() === 'basic';

const destinations = [
  // OTDS auth API needs the creds in the JSON body; opentext.js reads them off this
  // destination via getDestination().username/password, so it MUST carry them.
  {
    name: 'OpenText_OTDS',
    url: otdsUrl,
    username: user,
    password: pass,
    authentication: 'BasicAuthentication',
  },
  {
    name: 'OpenText_OTCS',
    url: otcsUrl,
    username: user,
    password: pass,
    authentication: otcsBasic ? 'BasicAuthentication' : 'NoAuthentication',
  },
];
process.env.destinations = JSON.stringify(destinations);

const ot = require('../srv/lib/opentext');

function dumpErr(label, err) {
  const r = err && err.response;
  console.error(`\n✗ ${label} FAILED`);
  console.error(`  status : ${(r && r.status) || err.status || '(none)'}`);
  if (r && r.headers) console.error(`  ct     : ${r.headers['content-type'] || ''}`);
  let body = r && r.data;
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (body && typeof body === 'object') body = JSON.stringify(body, null, 2);
  console.error(`  body   : ${String(body || err.message).slice(0, 1500)}`);
}

(async () => {
  console.log(`OTDS  : ${otdsUrl}`);
  console.log(`OTCS  : ${otcsUrl}  (OTCS auth = ${otcsBasic ? 'BasicAuthentication' : 'NoAuthentication'})`);
  console.log(`user  : ${user}\n`);

  let ticket;
  try {
    ticket = await ot.authenticate();
    console.log(`✓ OTDS authenticate → ticket ${String(ticket).slice(0, 8)}… (len ${String(ticket).length})`);
  } catch (err) {
    dumpErr('authenticate (OTDS POST)', err);
    process.exit(1);
  }

  try {
    const ping = await ot.pingNode(2000);
    console.log(`✓ OTCS pingNode(2000) → status ${ping.status}, title="${ping.nodeTitle}", ${ping.ms}ms`);
  } catch (err) {
    dumpErr('pingNode (OTCS GET /nodes/2000)', err);
    process.exit(2);
  }

  if (process.env.FOLDER_ID) {
    try {
      const docs = await ot.listFolder(Number(process.env.FOLDER_ID));
      console.log(`✓ listFolder(${process.env.FOLDER_ID}) → ${docs.length} document(s)`);
      docs.slice(0, 5).forEach((d) => console.log(`    - ${d.nodeId}  ${d.name}  (${d.category})`));
    } catch (err) {
      dumpErr(`listFolder(${process.env.FOLDER_ID})`, err);
      process.exit(3);
    }
  }

  console.log('\nAll probe steps passed.');
})();
