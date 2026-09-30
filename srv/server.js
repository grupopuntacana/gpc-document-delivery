'use strict';

const cds = require('@sap/cds');

const delivery = require('./lib/delivery');
const { resolveToken, InvalidToken } = require('./lib/token');
const { resolveDocToken, InvalidDocToken } = require('./lib/doctoken');

const LOG = cds.log('invoice');

// Option A vs B toggle. `stream` (default) serves the PDF bytes straight from OpenText;
// `cdn` returns a 302 to a short-lived CloudFront signed URL backed by an S3 cache.
// Flip via OPENTEXT_DELIVERY_MODE so both paths can be benchmarked with no code change.
const DELIVERY_MODE = process.env.OPENTEXT_DELIVERY_MODE === 'cdn' ? 'cdn' : 'stream';

/**
 * Serve one document — shared by both anonymous routes. `row` is source-typed (ADR 0009):
 * `{source:'otcs', nodeId}` or `{source:'archivelink', contRep, archDocId, ...}`.
 */
async function serve(row, res, t0) {
  let where = '(unknown)';
  try {
    where = delivery.label(row);
    if (DELIVERY_MODE === 'cdn') {
      // Option B: ensure the file is in the S3 cache and 302 to a CloudFront signed URL.
      // The browser follows the redirect to the CDN edge, so repeat fetches never touch the
      // system of record. Like the stream path, any file type is served correctly — the cache
      // bakes the real content-type and filename onto the object so CloudFront returns them.
      const url = await delivery.publishDocument(row);
      const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
      LOG.info(`redirect ${where} mode=cdn in ${ms} ms`);
      return res.redirect(302, url);
    }
    // Option A: stream the bytes straight from the system of record. The content-type and
    // filename come from upstream so any format (PDF, photo, office doc) is served correctly —
    // the browser renders it inline and a "Save As" gets the right name and extension.
    const { buffer, contentType, fileName } = await delivery.fetchDocument(row);
    const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
    LOG.info(`served ${where} bytes=${buffer.length} type=${contentType} mode=stream in ${ms} ms`);
    res.setHeader('Content-Type', contentType || 'application/octet-stream');
    // Inline only for allowlisted types (PDF, images); anything else downloads. nosniff stops a
    // browser from promoting a mislabelled body to HTML on this origin.
    res.setHeader('Content-Disposition', delivery.contentDisposition(contentType, fileName));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.send(buffer);
  } catch (err) {
    // The upstream reason (destination, tunnel host, response body) goes to the log only; an
    // anonymous caller learns nothing about the backend topology.
    const reason = delivery.describeError(err);
    LOG.error(`fetch failed ${where} mode=${DELIVERY_MODE}: ${reason}`);
    return res.status(502).type('text/plain').send('document temporarily unavailable');
  }
}

/**
 * Verify a token; on an invalid one answer 403 and return null. Anything else rethrows.
 */
async function verified(res, resolve, InvalidError) {
  try {
    return await resolve();
  } catch (err) {
    if (!(err instanceof InvalidError)) throw err;
    LOG.warn(`invalid token: ${err.message}`);
    res.status(403).send(`invalid token: ${err.message}`);
    return null;
  }
}

/**
 * Anonymous customer-facing document routes — the load-bearing piece, ported from
 * demo/server.py `open_invoice`, and generalized by ADR 0009.
 *
 *   GET /invoice/:token  v1 token (stateless, nodeId) — OpenText nodes only
 *   GET /doc/:token      v2 token (docId, DB-resolved) — any Documents row source
 *
 * The token is the credential, so these routes are intentionally unauthenticated (they sit
 * outside CAP's @requires services). Each verifies its token, then serves the bytes (Option A)
 * or 302s to a short-lived CloudFront signed URL (Option B).
 */
cds.on('bootstrap', (app) => {
  /**
   * v1 — `/invoice/:token`, the stateless HMAC token over an OpenText nodeId. Byte-compatible
   * with the Python prototype and the Integration Suite port; unchanged by ADR 0009.
   */
  app.get('/invoice/:token', async (req, res) => {
    const t0 = process.hrtime.bigint();
    const payload = await verified(res, () => resolveToken(req.params.token), InvalidToken);
    if (!payload) return undefined;
    return serve({ source: 'otcs', nodeId: payload.nodeId }, res, t0);
  });

  /**
   * v2 — `/doc/:token` (ADR 0009), the token over a `docId`. Resolved against the Documents
   * row on every request, so it serves any row source (OpenText node, S/4 ArchiveLink) and a
   * revoked row stops delivering immediately, not at token expiry.
   */
  app.get('/doc/:token', async (req, res) => {
    const t0 = process.hrtime.bigint();
    const payload = await verified(res, () => resolveDocToken(req.params.token), InvalidDocToken);
    if (!payload) return undefined;
    let row;
    try {
      row = await delivery.resolveDeliverable(payload.docId);
    } catch (err) {
      LOG.error(`doc lookup failed: ${err.message}`);
      return res.status(500).type('text/plain').send('lookup failed');
    }
    // A validly-signed token whose row is gone or revoked: same opaque answer for both.
    if (!row) {
      LOG.warn('doc token for a missing or revoked document');
      return res.status(404).type('text/plain').send('not found');
    }
    return serve(row, res, t0);
  });
});

module.exports = cds.server;
