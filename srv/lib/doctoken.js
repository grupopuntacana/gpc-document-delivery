'use strict';

/**
 * Document delivery token v2 — the credential of the anonymous `GET /doc/:token` route
 * (ADR 0009). Deliberately a SEPARATE module from `token.js`:
 *
 *   - `token.js` (v1, `/invoice/:token`) signs `{n:<nodeId>}` and is a byte-for-byte interop
 *     contract with the Python prototype and the Integration Suite port. It cannot carry an
 *     ArchiveLink locator (a 40-char string, not an integer), and it must not change.
 *   - v2 signs `{d:<docId>, e, v:2}`. The route resolves `docId` against the `Documents` row,
 *     so ONE token format serves every row source (`otcs`, `archivelink`, future ones), and
 *     revoking the row kills outstanding links immediately — the DB-backed token ADR 0001 and
 *     task 0004 asked for.
 *
 *   base64url_nopad(payload_json) "." base64url_nopad(hmac_sha256(K2, payload_json))
 *
 * Key separation: K2 = HMAC-SHA256(SHARED_LINK_SECRET, "gpc-document-delivery/doc-token/v2").
 * One secret to rotate, but a v1 signature can never validate as v2 (or vice versa), even if a
 * payload happened to parse on both routes.
 */

const crypto = require('crypto');
const credstore = require('./credstore');

const VERSION = 2;
const KEY_LABEL = 'gpc-document-delivery/doc-token/v2';

class InvalidDocToken extends Error {}

// The derived key, memoized against the secret it came from: a rotated SHARED_LINK_SECRET
// (credstore's own TTL cache returns the new value) yields a new key on the next call.
let _derived = { secret: null, key: null };

async function signingKey() {
  const secret = await credstore.getSharedLinkSecret();
  if (_derived.secret !== secret) {
    _derived = {
      secret,
      key: crypto.createHmac('sha256', Buffer.from(secret, 'utf8')).update(KEY_LABEL).digest(),
    };
  }
  return _derived.key;
}

/** Compact, sorted-keys JSON — deterministic, same canonical form as token.js. */
function canonicalPayload(docId, expiryEpoch) {
  return JSON.stringify({ d: String(docId), e: Math.trunc(expiryEpoch), v: VERSION });
}

/**
 * Mint a v2 token over a `docId`.
 * @param {string} docId the Documents row key
 * @param {{ttlSeconds:number, now?:number}} opts
 * @returns {Promise<{token:string, expiresAt:Date}>}
 */
async function makeDocToken(docId, { ttlSeconds, now = null }) {
  if (typeof docId !== 'string' || !docId) throw new TypeError('docId is required');
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) throw new TypeError('ttlSeconds must be > 0');
  const nowSec = now != null ? now : Math.floor(Date.now() / 1000);
  const expiry = nowSec + Math.trunc(ttlSeconds);
  const payload = Buffer.from(canonicalPayload(docId, expiry), 'utf8');
  const sig = crypto.createHmac('sha256', await signingKey()).update(payload).digest();
  return {
    token: `${payload.toString('base64url')}.${sig.toString('base64url')}`,
    expiresAt: new Date(expiry * 1000),
  };
}

/**
 * Verify signature, version and expiry; return the docId. Constant-time HMAC compare.
 * @returns {Promise<{docId:string, expiresAt:Date}>}
 * @throws {InvalidDocToken}
 */
async function resolveDocToken(token, { now = null } = {}) {
  if (typeof token !== 'string' || (token.match(/\./g) || []).length !== 1) {
    throw new InvalidDocToken('malformed token');
  }
  const [payloadB64, sigB64] = token.split('.');
  const payload = Buffer.from(payloadB64, 'base64url');
  const sigGiven = Buffer.from(sigB64, 'base64url');
  const sigExpected = crypto.createHmac('sha256', await signingKey()).update(payload).digest();
  if (sigGiven.length !== sigExpected.length || !crypto.timingSafeEqual(sigGiven, sigExpected)) {
    throw new InvalidDocToken('signature mismatch');
  }
  let data;
  try {
    data = JSON.parse(payload.toString('utf8'));
  } catch {
    throw new InvalidDocToken('bad payload');
  }
  const expiry = Number(data && data.e);
  if (data?.v !== VERSION || typeof data.d !== 'string' || !data.d || !Number.isFinite(expiry)) {
    throw new InvalidDocToken('bad payload');
  }
  const nowSec = now != null ? now : Math.floor(Date.now() / 1000);
  if (nowSec >= expiry) throw new InvalidDocToken('expired');
  return { docId: data.d, expiresAt: new Date(expiry * 1000) };
}

module.exports = {
  InvalidDocToken,
  makeDocToken,
  resolveDocToken,
};
