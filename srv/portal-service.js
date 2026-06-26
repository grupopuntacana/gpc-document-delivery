'use strict';

const cds = require('@sap/cds');

const opentext = require('./lib/opentext');
const token = require('./lib/token');

const LOG = cds.log('portal');

// Which OpenText folder to list. Externalized param / env (mirrors the demo's
// OTCS_DEMO_FOLDER_ID); defaults to the Enterprise root (2000) if unset.
const FOLDER_ID = Number(process.env.OPENTEXT_FOLDER_ID || 2000);

// Listing tokens are short-lived (demo used 7 days).
const TOKEN_TTL_DAYS = Number(process.env.PORTAL_TOKEN_TTL_DAYS || 7);

module.exports = class PortalService extends cds.ApplicationService {
  init() {
    this.on('documents', async (req) => {
      try {
        // Per-phase timing so the logs reveal where a listing spends its time:
        //   listMs  = OpenText round trips (OTDS auth + OTCS folder list)
        //   tokenMs = token minting (secret fetch + HMAC) — should be ~0 once the
        //             secret cache is warm; if it isn't, the cache isn't taking effect.
        const t0 = process.hrtime.bigint();
        const docs = await opentext.listFolder(FOLDER_ID);
        const t1 = process.hrtime.bigint();
        const rows = await Promise.all(
          docs.map(async (d) => ({
            nodeId: d.nodeId,
            displayName: d.name,
            category: d.category,
            subtitle: d.subtitle,
            sizeBytes: d.sizeBytes,
            token: await token.makeToken(d.nodeId, { ttlDays: TOKEN_TTL_DAYS }),
          })),
        );
        const t2 = process.hrtime.bigint();
        const ms = (a, b) => Math.round(Number(b - a) / 1e6);
        LOG.info(`documents: ${rows.length} from folder ${FOLDER_ID}`);
        // Per-phase timing at debug — raise the `portal` logger to debug to see it
        // (see README "Debugging with logs"). listMs=OpenText, tokenMs=secret+HMAC.
        LOG.debug(
          `documents timing: listMs=${ms(t0, t1)} tokenMs=${ms(t1, t2)} totalMs=${ms(t0, t2)}`,
        );
        return rows;
      } catch (err) {
        LOG.error('documents listing failed:', err.message);
        return req.reject(502, `OpenText listing failed: ${err.message}`);
      }
    });

    return super.init();
  }
};
