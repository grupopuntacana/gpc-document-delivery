'use strict';

const crypto = require('crypto');
const cds = require('@sap/cds');

const buckets = require('./lib/buckets');
const opentext = require('./lib/opentext');
const token = require('./lib/token');

const LOG = cds.log('ingest');

// Match the portal's short-lived token (demo used 7 days).
const TOKEN_TTL_DAYS = Number(process.env.PORTAL_TOKEN_TTL_DAYS || 7);

// Hard ceiling on a single upload's decoded size. The file rides in the JSON body as base64
// (≈ +33% on the wire), so this must sit comfortably under the CAP body_parser limit in
// package.json (30mb wire ≈ ~22mb decoded). Bound it deliberately rather than relying on
// whatever the parser happens to allow; override with OPENTEXT_MAX_UPLOAD_BYTES.
const MAX_UPLOAD_BYTES = Number(process.env.OPENTEXT_MAX_UPLOAD_BYTES || 20 * 1024 * 1024);

/**
 * Django-style dedup, mirroring demo/server.py: keep the original filename; on a collision
 * append an 8-hex-char UUID suffix before the extension ('invoice.pdf' → 'invoice_a3f2b1c8.pdf').
 * One-shot, no retry loop.
 *
 * Best-effort and TOCTOU by design (read folder → pick name → upload): two simultaneous
 * uploads of the same name can both see "no collision" and both store it. The Python
 * reference has the same shape; acceptable for the single-writer ingest seed. Hardening to a
 * create-node conflict + retry is deferred with the multi-tenant ingest auth model (ADR 0005).
 */
async function uniqueName(folderId, fileName) {
  const existing = new Set(await opentext.listFolderChildNames(folderId));
  if (!existing.has(fileName)) return fileName;
  const dot = fileName.lastIndexOf('.');
  const root = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : '';
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  const renamed = `${root}_${suffix}${ext}`;
  LOG.info(`filename conflict: ${fileName} -> ${renamed}`);
  return renamed;
}

module.exports = class IngestService extends cds.ApplicationService {
  init() {
    this.on('uploadDocument', async (req) => {
      const {
        bucket, fileName, contentType, contentBase64,
      } = req.data;
      if (!fileName) return req.reject(400, 'fileName is required');
      if (!contentBase64) return req.reject(400, 'contentBase64 is required');

      // Resolve the target folder BEFORE touching OpenText: an unknown bucket must cost
      // nothing. There is no fallback folder — the registry is the only source of truth
      // for where a document lands.
      let folderNode;
      try {
        ({ folderNode } = buckets.resolveBucket(bucket));
      } catch (err) {
        // A caller naming a bucket we don't have is a 400; a broken deployed config is
        // ours, not theirs — surface it as a 500 rather than blaming the request.
        if (err.code === 'UNKNOWN_BUCKET') return req.reject(400, err.message);
        LOG.error('bucket registry misconfigured:', err.message);
        return req.reject(500, 'bucket registry is misconfigured');
      }

      // Buffer.from(.,'base64') silently drops invalid chars, so an all-whitespace/symbol
      // string decodes to zero bytes — hence "empty or undecodable" (we don't distinguish).
      const buffer = Buffer.from(contentBase64, 'base64');
      if (buffer.length === 0) return req.reject(400, 'empty or undecodable content');
      if (buffer.length > MAX_UPLOAD_BYTES) {
        return req.reject(413, `file too large: ${buffer.length} bytes (max ${MAX_UPLOAD_BYTES})`);
      }

      try {
        // Sanitize before dedup/storage/response so the returned name == the stored name and
        // can't break the multipart framing (shared rule with the download path).
        const name = await uniqueName(folderNode, opentext.sanitizeFileName(fileName));
        const nodeId = await opentext.uploadDocument(
          folderNode,
          buffer,
          name,
          contentType || 'application/octet-stream',
        );
        const tok = await token.makeToken(nodeId, { ttlDays: TOKEN_TTL_DAYS });
        LOG.info(
          `uploaded "${fileName}" as "${name}" -> node ${nodeId} `
            + `in bucket "${bucket}" (folder ${folderNode}, ${buffer.length} bytes)`,
        );
        return { nodeId, name, token: tok };
      } catch (err) {
        const reason = opentext.describeError(err);
        LOG.error('upload failed:', reason);
        LOG.error(err.stack || err);
        return req.reject(502, `OpenText upload failed: ${reason}`);
      }
    });

    return super.init();
  }
};
