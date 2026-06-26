'use strict';

/**
 * CloudFront signed-URL generation — CAP port of Python `src/cdn_publisher.py`
 * (`sign_cloudfront_url`, `_s3_key`, `_b64_for_url`).
 *
 * This is Layer 1 of Option B: **offline crypto only**. Signing needs the CloudFront
 * private key (RSA) but NO AWS SDK and NO AWS credentials — so it can ship and be
 * benchmarked independently of the S3 write-through cache (`cdn.js`, Layer 2).
 *
 * The signature MUST stay byte-identical to the Python signer for the same key + policy
 * + expiry: CloudFront verifies it against the public key in the trusted key group, and
 * task 0002 cross-checks the two signers. The recipe is AWS's "canned policy":
 *   - policy string is byte-exact (no whitespace, fixed key order)
 *   - RSA PKCS#1 v1.5 + SHA-1  (Node's `createSign('RSA-SHA1')` default padding)
 *   - AWS's URL-safe base64 alphabet: '+' -> '-', '=' -> '_', '/' -> '~'
 *
 * Non-secret config (domain / key-pair id / TTL) comes from env (mirrors the Python
 * `.env` / `mta.yaml` properties). The private key comes from the Credential Store via
 * `credstore.getCloudFrontPrivateKey()`, cached in-module (single-flight) like the
 * secret/ticket caches so a burst of signings doesn't re-hit the store.
 */

const crypto = require('crypto');
const credstore = require('./credstore');

// --- non-secret config (env-overridable; defaults match the Python prototype .env) ---
function cloudfrontDomain() {
  return process.env.CLOUDFRONT_DOMAIN || 'd3ef18l0vjlle9.cloudfront.net';
}
function keyPairId() {
  return process.env.CLOUDFRONT_KEY_PAIR_ID || 'KOZINHBBRK0NV';
}
function ttlSeconds() {
  const v = Number(process.env.SIGNED_URL_TTL_SECONDS);
  return Number.isFinite(v) && v > 0 ? v : 300;
}

/** S3 object key for a node — must match Python `_s3_key`. */
function s3Key(nodeId) {
  return `documents/${nodeId}.pdf`;
}

/**
 * AWS's URL-safe base64 alphabet for CloudFront signatures (NOT standard base64url).
 * Mirrors Python `_b64_for_url`: '+' -> '-', '=' -> '_', '/' -> '~'.
 */
function awsBase64(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/=/g, '_')
    .replace(/\//g, '~');
}

/**
 * Build the canned-policy string for a resource + expiry. Kept byte-exact (compact JSON,
 * fixed key order) — the bytes are what gets signed, so any drift breaks verification.
 */
function cannedPolicy(url, expiresEpoch) {
  return `{"Statement":[{"Resource":"${url}","Condition":{"DateLessThan":{"AWS:EpochTime":${expiresEpoch}}}}]}`;
}

/**
 * Sign a single URL with a canned policy. Pure function (key + url + expiry in, signed
 * URL out) so tests can exercise it against a throwaway key without any I/O.
 * @param {string} url            the resource URL to sign (no query yet)
 * @param {string} privateKeyPem  PEM-encoded RSA private key
 * @param {string} keyPairIdVal   CloudFront key-pair id
 * @param {number} expiresEpoch   absolute expiry, seconds since epoch
 */
function signCloudFrontUrl(url, privateKeyPem, keyPairIdVal, expiresEpoch) {
  const policy = cannedPolicy(url, expiresEpoch);
  // 'RSA-SHA1' = RSASSA-PKCS1-v1_5 over SHA-1 (PKCS#1 v1.5 is crypto's default padding),
  // exactly matching Python's `private_key.sign(policy, PKCS1v15(), SHA1())`.
  const signature = crypto.createSign('RSA-SHA1').update(policy).sign(privateKeyPem);
  const sig = awsBase64(signature);
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}Expires=${expiresEpoch}&Signature=${sig}&Key-Pair-Id=${keyPairIdVal}`;
}

// In-module single-flight cache for the signing key (PEM). The key is process-stable,
// so a per-instance memo avoids a Credential Store round trip per signing — a listing
// of N documents signs N URLs. Cache the in-flight *promise* so a concurrent burst
// collapses to ONE fetch. Short TTL lets a rotated key be picked up without a restart;
// set CLOUDFRONT_KEY_TTL_MS=0 to disable (tests).
const KEY_TTL_MS = Number(
  process.env.CLOUDFRONT_KEY_TTL_MS != null ? process.env.CLOUDFRONT_KEY_TTL_MS : 10 * 60 * 1000,
);
let _keyPromise = null;
let _keyExpires = 0;

function getSigningKey() {
  const now = Date.now();
  if (_keyPromise && now < _keyExpires) return _keyPromise;
  _keyExpires = now + KEY_TTL_MS;
  _keyPromise = credstore.getCloudFrontPrivateKey();
  // Drop a cached rejection so the next call retries instead of serving a stuck error.
  _keyPromise.catch(() => {
    _keyPromise = null;
    _keyExpires = 0;
  });
  return _keyPromise;
}

/** Clear the cached signing key (tests / forced refresh after a known rotation). */
function clearKeyCache() {
  _keyPromise = null;
  _keyExpires = 0;
}

/**
 * Produce a short-lived CloudFront signed URL for an OpenText node's cached PDF.
 * @param {number} nodeId
 * @param {number} [ttl]  override TTL in seconds (defaults to SIGNED_URL_TTL_SECONDS)
 * @returns {Promise<string>}
 */
async function signedUrlForNode(nodeId, ttl) {
  const url = `https://${cloudfrontDomain()}/${s3Key(nodeId)}`;
  const expiresEpoch = Math.floor(Date.now() / 1000) + (ttl != null ? ttl : ttlSeconds());
  const pem = await getSigningKey();
  return signCloudFrontUrl(url, pem, keyPairId(), expiresEpoch);
}

module.exports = {
  s3Key,
  signedUrlForNode,
  // exported for unit tests / Layer 2
  awsBase64,
  cannedPolicy,
  signCloudFrontUrl,
  clearKeyCache,
  cloudfrontDomain,
  keyPairId,
  ttlSeconds,
};
