'use strict';

/**
 * SAP Credential Store reader.
 *
 * Milestone 1 of the BTP port: prove we can source the HMAC `SHARED_LINK_SECRET`
 * and the CloudFront private key from a bound Credential Store service at runtime
 * — instead of from `.env` like the Python prototype (`src/token_redirect.py::_secret`).
 *
 * Credential Store has no official npm SDK. Access is its REST API, authenticated
 * with the bound instance's `username`/`password` (Basic) plus a namespace header.
 * Responses come back as a compact JWE encrypted to the binding's client key pair;
 * we decrypt with `encryption.client_private_key` (RSA-OAEP-256 / A256GCM).
 *
 * Local / hybrid / test fallback: if no `credstore` binding is present, fall back to
 * `process.env.SHARED_LINK_SECRET` (+ `CLOUDFRONT_PRIVATE_KEY` / `_PATH`) so that
 * `cds watch` and vitest run with no BTP services bound. The secret VALUE must stay
 * byte-identical to the Python side (`.env`) or every existing token breaks — see the
 * cross-side interop contract in CLAUDE.md.
 */

const crypto = require('crypto');
const fs = require('fs');

const NAMESPACE = process.env.CREDSTORE_NAMESPACE || 'gpc-document-delivery';

let _xsenv;
function xsenv() {
  if (_xsenv === undefined) {
    try {
      _xsenv = require('@sap/xsenv');
    } catch {
      _xsenv = null;
    }
  }
  return _xsenv;
}

/** Returns the bound credstore credentials, or null when unbound (local/test). */
function binding() {
  const env = xsenv();
  if (!env) return null;
  try {
    const { credstore } = env.getServices({ credstore: { label: 'credstore' } });
    return credstore || null;
  } catch {
    return null; // not bound — caller falls back to env
  }
}

/**
 * Fetch and decrypt one entry from the Credential Store REST API.
 * `kind` is 'password' or 'key'. Returns the parsed entry object.
 */
async function fetchEntry(creds, kind, name) {
  const { compactDecrypt } = await import('jose');

  const url = `${creds.url}/${kind}?name=${encodeURIComponent(name)}`;
  const auth = Buffer.from(`${creds.username}:${creds.password}`).toString('base64');

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Basic ${auth}`,
      'sapcp-credstore-namespace': NAMESPACE,
      Accept: 'application/json;charset=UTF-8',
    },
  });
  if (!res.ok) {
    throw new Error(`Credential Store ${kind}/${name} -> HTTP ${res.status}`);
  }

  // Response body is a compact JWE encrypted to our client key.
  const jwe = await res.text();
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(creds.encryption.client_private_key, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const { plaintext } = await compactDecrypt(jwe, privateKey);
  return JSON.parse(Buffer.from(plaintext).toString('utf8'));
}

/**
 * The HMAC secret used to verify sharing tokens.
 * @returns {Promise<string>} the raw secret string (UTF-8), never logged.
 */
async function getSharedLinkSecret() {
  const creds = binding();
  if (creds) {
    const entry = await fetchEntry(creds, 'password', 'SHARED_LINK_SECRET');
    return entry.value;
  }
  const fromEnv = process.env.SHARED_LINK_SECRET;
  if (!fromEnv) {
    throw new Error(
      'SHARED_LINK_SECRET unavailable: no credstore binding and env var unset. ' +
        'Bind the Credential Store, or set SHARED_LINK_SECRET for local/hybrid runs.'
    );
  }
  return fromEnv;
}

/**
 * The CloudFront signing private key (PEM).
 * @returns {Promise<string>} PEM-encoded RSA private key.
 */
async function getCloudFrontPrivateKey() {
  const creds = binding();
  if (creds) {
    const entry = await fetchEntry(creds, 'key', 'CloudFrontPrivateKey');
    // Credential Store 'key' entries carry the material in `value` (base64) — normalize to PEM.
    const raw = Buffer.from(entry.value, 'base64').toString('utf8');
    return raw.includes('-----BEGIN') ? raw : entry.value;
  }
  if (process.env.CLOUDFRONT_PRIVATE_KEY) return process.env.CLOUDFRONT_PRIVATE_KEY;
  if (process.env.CLOUDFRONT_PRIVATE_KEY_PATH) {
    return fs.readFileSync(process.env.CLOUDFRONT_PRIVATE_KEY_PATH, 'utf8');
  }
  throw new Error(
    'CloudFront private key unavailable: no credstore binding and no CLOUDFRONT_PRIVATE_KEY[_PATH].'
  );
}

/** Diagnostic: are we reading from a live Credential Store binding (true) or env fallback (false)? */
function isBound() {
  return binding() !== null;
}

module.exports = {
  getSharedLinkSecret,
  getCloudFrontPrivateKey,
  isBound,
  NAMESPACE,
};
