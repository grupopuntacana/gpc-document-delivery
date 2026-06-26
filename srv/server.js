'use strict';

const cds = require('@sap/cds');

const opentext = require('./lib/opentext');
const cdn = require('./lib/cdn');
const { resolveToken, InvalidToken } = require('./lib/token');

const LOG = cds.log('invoice');

// Option A vs B toggle. `stream` (default) serves the PDF bytes straight from OpenText;
// `cdn` returns a 302 to a short-lived CloudFront signed URL backed by an S3 cache.
// Flip via OPENTEXT_DELIVERY_MODE so both paths can be benchmarked with no code change.
const DELIVERY_MODE = process.env.OPENTEXT_DELIVERY_MODE === 'cdn' ? 'cdn' : 'stream';

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
      if (DELIVERY_MODE === 'cdn') {
        // Option B: ensure the PDF is in the S3 cache and 302 to a CloudFront signed URL.
        // The browser follows the redirect to the CDN edge, so repeat fetches never touch
        // OpenText. The URL contract (`/invoice/:token`) is unchanged.
        //
        // ⚠️ Unlike the stream path below, Option B is still PDF-only: cdn.js caches under a
        // `.pdf` S3 key with ContentType application/pdf. A non-PDF upload (photo, office doc)
        // would be mis-served in cdn mode. Generalizing it means threading downloadDocument's
        // contentType/fileName into PutObject + the signed URL — deferred until Option B ships.
        const url = await cdn.publish(payload.nodeId);
        const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
        LOG.info(`redirect node=${payload.nodeId} mode=cdn in ${ms} ms`);
        return res.redirect(302, url);
      }
      // Option A: stream the bytes straight from OpenText. The content-type and filename come
      // from OpenText so any uploaded format (PDF, photo, office doc) is served correctly —
      // the browser renders it inline and a "Save As" gets the right name and extension.
      const { buffer, contentType, fileName } = await opentext.downloadDocument(payload.nodeId);
      const name = opentext.downloadFileName(payload.nodeId, contentType, fileName);
      const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
      LOG.info(`served node=${payload.nodeId} bytes=${buffer.length} type=${contentType} mode=stream in ${ms} ms`);
      res.setHeader('Content-Type', contentType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${name}"`);
      return res.send(buffer);
    } catch (err) {
      const reason = opentext.describeError(err);
      LOG.error(`fetch failed node=${payload.nodeId} mode=${DELIVERY_MODE}: ${reason}`);
      return res.status(502).send(`fetch failed: ${reason}`);
    }
  });
});

module.exports = cds.server;
