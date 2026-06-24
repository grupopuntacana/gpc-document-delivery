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
        const docs = await opentext.listFolder(FOLDER_ID);
        const rows = await Promise.all(
          docs.map(async (d) => ({
            nodeId: d.nodeId,
            displayName: d.name,
            category: d.category,
            subtitle: d.subtitle,
            sizeBytes: d.sizeBytes,
            token: await token.makeToken(d.nodeId, { ttlDays: TOKEN_TTL_DAYS }),
          }))
        );
        LOG.info(`documents: ${rows.length} from folder ${FOLDER_ID}`);
        return rows;
      } catch (err) {
        LOG.error('documents listing failed:', err.message);
        return req.reject(502, `OpenText listing failed: ${err.message}`);
      }
    });

    return super.init();
  }
};
