'use strict';

const cds = require('@sap/cds');

const opentext = require('./lib/opentext');
const { resolveToken, InvalidToken } = require('./lib/token');

const LOG = cds.log('invoice');

/**
 * Anonymous customer-facing document route — the load-bearing piece, ported from
 * demo/server.py `open_invoice`.
 *
 * `GET /invoice/:token` -> verify token -> download the PDF from OpenText (over the
 * Destination Service) -> stream the bytes back. The token is the credential, so this
 * route is intentionally unauthenticated (it sits outside CAP's @requires services).
 *
 * Option A of the BTP port: serve the PDF directly. A later milestone swaps the body of
 * this handler for a 302 to a short-lived CloudFront signed URL (S3 write-through cache)
 * without changing the URL contract.
 */
cds.on('bootstrap', (app) => {
  app.get('/invoice/:token', async (req, res) => {
    const t0 = process.hrtime.bigint();
    let payload;
    try {
      payload = await resolveToken(req.params.token);
    } catch (err) {
      if (err instanceof InvalidToken) {
        LOG.warn(`invalid token: ${err.message}`);
        return res.status(403).send(`invalid token: ${err.message}`);
      }
      throw err;
    }
    try {
      const { buffer, contentType } = await opentext.downloadDocument(payload.nodeId);
      const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
      LOG.info(`served node=${payload.nodeId} bytes=${buffer.length} in ${ms} ms`);
      res.setHeader('Content-Type', contentType || 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="document-${payload.nodeId}.pdf"`);
      return res.send(buffer);
    } catch (err) {
      LOG.error(`fetch failed node=${payload.nodeId}: ${err.message}`);
      return res.status(502).send(`fetch failed: ${err.message}`);
    }
  });
});

module.exports = cds.server;
