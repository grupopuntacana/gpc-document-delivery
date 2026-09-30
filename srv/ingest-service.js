'use strict';

const crypto = require('crypto');
const cds = require('@sap/cds');

const buckets = require('./lib/buckets');
const opentext = require('./lib/opentext');
const token = require('./lib/token');
const { newDocId } = require('./lib/docref');

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

/**
 * Derive the caller's OAuth authorized party; '' when the token carries no claim.
 *
 * `authInfo.token.azp` is the only source. Not `req.user.attr` (absent on the
 * service-to-service path) and not `token.clientId`, which falls back to `audiences[0]`/`cid`
 * in xssec v4 — another claim standing in for the authorization key would widen it silently.
 *
 * @param {object} user `req.user`
 * @returns {string} the azp, trimmed, or '' when absent
 */
function callerAzp(user) {
  const azp = user?.authInfo?.token?.azp;
  return typeof azp === 'string' ? azp.trim() : '';
}

/**
 * Flatten control characters so a caller-supplied azp cannot forge a second log line.
 * Only for display: the ACL is matched against the raw value, never this one.
 *
 * @param {string} azp the caller's azp
 * @returns {string} the azp with CR/LF/tab collapsed to spaces
 */
function forLog(azp) {
  return azp.replace(/[\r\n\t]/g, ' ');
}

/**
 * The write-authorization decision. Takes no body — a spoofed field cannot reach it.
 *
 * An unknown bucket is denied rather than reported as unknown: a 400-vs-403 split would let a
 * caller enumerate other apps' namespaces one probe at a time.
 *
 * @param {object} user `req.user`
 * @param {string} bucket bucket named by the caller
 * @returns {{ok: boolean, azp: string, reason?: string}} `reason` is for the log, not the response
 */
function authorizeWrite(user, bucket) {
  const azp = callerAzp(user);
  if (!azp) return { ok: false, azp, reason: 'no azp claim on the caller token' };
  if (!buckets.mayWrite(azp, bucket)) {
    return { ok: false, azp, reason: `azp "${forLog(azp)}" may not write bucket "${bucket}"` };
  }
  return { ok: true, azp };
}

module.exports = class IngestService extends cds.ApplicationService {
  init() {
    // The ownership/revocation store (db/schema.cds). Not projected on this service — it is
    // an internal registry, never a queryable entity (DoD-5) — so reach it by its db name.
    const { Documents } = cds.entities('gpc.documentdelivery');

    this.on('uploadDocument', async (req) => {
      const {
        bucket, fileName, contentType, contentBase64,
      } = req.data;
      if (!fileName) return req.reject(400, 'fileName is required');
      if (!contentBase64) return req.reject(400, 'contentBase64 is required');
      // A malformed request, not an authorization question — and no name to confirm.
      if (!bucket || !bucket.trim()) return req.reject(400, 'bucket is required');

      // Before resolveBucket: resolving a self-provisioned bucket creates a folder in
      // OpenText, so a denied caller must never reach it.
      let auth;
      try {
        auth = authorizeWrite(req.user, bucket);
      } catch (err) {
        // A broken OPENTEXT_BUCKETS surfaces here first — still a 500, never a 403.
        LOG.error('bucket registry misconfigured:', err.message);
        return req.reject(500, 'bucket registry is misconfigured');
      }
      if (!auth.ok) {
        // The log distinguishes no-claim / unknown / not-yours; the response collapses all three.
        LOG.warn(`upload denied: ${auth.reason}`);
        return req.reject(403, 'not authorized to write this bucket');
      }
      const from = `azp "${forLog(auth.azp)}"`;

      // Resolve the target folder BEFORE reading the payload: an unknown bucket must cost
      // nothing (both caller-blaming rejections below are decided by a sync Map lookup, so
      // they still make zero OpenText calls). There is no fallback folder — the registry is
      // the only source of truth for where a document lands.
      let folderNode;
      try {
        ({ folderNode } = await buckets.resolveBucket(bucket));
      } catch (err) {
        // Unreachable since 0007: the guard above rejects an empty bucket and `mayWrite`
        // only grants a bucket the registry holds, so neither code can surface here. Kept as
        // belt-and-braces — an unknown bucket answers 403 at the gate, never 400.
        if (err.code === 'BUCKET_REQUIRED' || err.code === 'UNKNOWN_BUCKET') {
          LOG.warn(`upload rejected (${from}): ${err.message}`);
          return req.reject(400, err.message);
        }
        // A self-provisioned bucket whose folder OpenText won't resolve or create is an
        // upstream failure, not a bad config — same 502 the upload path gives (0006).
        if (err.code === 'FOLDER_PROVISION_FAILED') {
          const reason = opentext.describeError(err);
          LOG.error(`folder provisioning failed (${from}):`, reason);
          return req.reject(502, `OpenText folder provisioning failed: ${reason}`);
        }
        LOG.error(`bucket registry misconfigured (${from}):`, err.message);
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
        // Mint the opaque claim-check and persist the ownership/revocation row (ADR 0006).
        // The consumer stores `docId` in place of the nodeId; the nodeId stays in this row and
        // is never returned. `ownerId` is left null here — the customer dimension is task 0009.
        const docId = newDocId();
        await INSERT.into(Documents).entries({
          docId,
          source: 'otcs',
          nodeId,
          bucket,
          ownerAzp: auth.azp,
          revoked: false,
          createdAt: new Date().toISOString(),
        });
        // A short-lived token so a caller that wants an immediate link need not round-trip
        // linkFor; the durable re-mint handle is `docId`, not this token.
        const tok = await token.makeToken(nodeId, { ttlDays: TOKEN_TTL_DAYS });
        LOG.info(
          `uploaded "${fileName}" as "${name}" -> node ${nodeId} (docId ${docId}) `
            + `in bucket "${bucket}" (folder ${folderNode}, ${buffer.length} bytes, ${from})`,
        );
        return { docId, name, token: tok };
      } catch (err) {
        const reason = opentext.describeError(err);
        LOG.error(`upload failed (${from}):`, reason);
        LOG.error(err.stack || err);
        return req.reject(502, `OpenText upload failed: ${reason}`);
      }
    });

    return super.init();
  }
};

// Exposed for unit tests: mocked auth cannot produce an azp claim.
module.exports.authorizeWrite = authorizeWrite;
