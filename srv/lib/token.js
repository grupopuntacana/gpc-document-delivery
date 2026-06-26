'use strict';

/**
 * Stateless signed sharing token — CAP port of Python `src/token_redirect.py`.
 *
 * The customer-facing URL `/invoice/{token}` is the stable contract. The token is:
 *
 *   base64url_nopad(payload_json) "." base64url_nopad(hmac_sha256(secret, payload_json))
 *
 * where payload_json is compact + sorted-keys JSON: {"c"?:<customer>,"e":<exp_epoch>,"n":<node_id>}
 *
 * This MUST stay byte-identical to the Python implementation — same secret, same JSON
 * separators (",", ":"), same sorted keys, same base64url-without-padding — or tokens
 * minted on one side won't verify on the other (CLAUDE.md cross-side interop contract).
 *
 * The HMAC secret comes from the Credential Store (`credstore.getSharedLinkSecret`),
 * falling back to `SHARED_LINK_SECRET` env locally.
 */

const crypto = require('crypto');
const credstore = require('./credstore');

class InvalidToken extends Error {}

function b64eRaw(buf) {
  return Buffer.from(buf).toString('base64url'); // base64url has no padding in Node
}

function b64dRaw(str) {
  return Buffer.from(str, 'base64url');
}

/**
 * Compact, sorted-keys JSON exactly as Python's
 * json.dumps(..., separators=(",",":"), sort_keys=True).
 */
function canonicalPayload(nodeId, expiryEpoch, customerId) {
  const obj = { e: Math.trunc(expiryEpoch), n: Math.trunc(nodeId) };
  if (customerId) obj.c = customerId;
  const sortedKeys = Object.keys(obj).sort();
  const parts = sortedKeys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(obj[k])}`);
  return `{${parts.join(',')}}`;
}

async function secretBytes() {
  const sec = await credstore.getSharedLinkSecret();
  return Buffer.from(sec, 'utf8');
}

/**
 * Mint a signed sharing token. TTL is in days for ergonomics (matches Python default 30;
 * the demo listing uses 7).
 * @returns {Promise<string>}
 */
async function makeToken(nodeId, { ttlDays = 30, customerId = null, now = null } = {}) {
  const nowSec = now != null ? now : Math.floor(Date.now() / 1000);
  const expiry = nowSec + ttlDays * 86400;
  const payloadJson = canonicalPayload(nodeId, expiry, customerId);
  const payloadBytes = Buffer.from(payloadJson, 'utf8');
  const sig = crypto.createHmac('sha256', await secretBytes()).update(payloadBytes).digest();
  return `${b64eRaw(payloadBytes)}.${b64eRaw(sig)}`;
}

/**
 * Verify signature + expiry; return the parsed payload. Constant-time HMAC compare.
 * @returns {Promise<{nodeId:number,expiresAt:Date,customerId:?string}>}
 * @throws {InvalidToken}
 */
async function resolveToken(token, { now = null } = {}) {
  if (typeof token !== 'string' || (token.match(/\./g) || []).length !== 1) {
    throw new InvalidToken('malformed token');
  }
  const [payloadB64, sigB64] = token.split('.');
  let payloadBytes;
  let sigGiven;
  try {
    payloadBytes = b64dRaw(payloadB64);
    sigGiven = b64dRaw(sigB64);
  } catch {
    throw new InvalidToken('bad base64');
  }
  const sigExpected = crypto
    .createHmac('sha256', await secretBytes())
    .update(payloadBytes)
    .digest();
  if (sigGiven.length !== sigExpected.length || !crypto.timingSafeEqual(sigGiven, sigExpected)) {
    throw new InvalidToken('signature mismatch');
  }
  let data;
  try {
    data = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    throw new InvalidToken('bad payload');
  }
  const nodeId = Number(data.n);
  const expiry = Number(data.e);
  if (!Number.isFinite(nodeId) || !Number.isFinite(expiry)) {
    throw new InvalidToken('bad payload');
  }
  const nowSec = now != null ? now : Math.floor(Date.now() / 1000);
  if (nowSec >= expiry) throw new InvalidToken('expired');
  return {
    nodeId,
    expiresAt: new Date(expiry * 1000),
    customerId: data.c != null ? data.c : null,
  };
}

module.exports = {
  InvalidToken,
  makeToken,
  resolveToken,
  // exported for unit tests
  canonicalPayload,
};
