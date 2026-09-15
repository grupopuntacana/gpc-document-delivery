'use strict';

/**
 * Opaque document reference — the durable claim-check a consumer stores in place of the
 * private OpenText `nodeId` (ADR 0006, task 0008).
 *
 * `newDocId()` is 128 bits of CSPRNG randomness, base64url-encoded: opaque, unguessable, and
 * carrying NO structure a caller could parse or forge. It is not an HMAC — the `Documents` row
 * is the integrity check (a `docId` not in the table is simply rejected), so there is nothing
 * to verify here, only to generate.
 */

const crypto = require('crypto');

// 16 bytes = 128 bits. base64url (no padding) → a 22-char URL-safe token that drops cleanly
// into an action argument and a log line without escaping.
const DOCID_BYTES = 16;

/**
 * Mint a fresh opaque document reference.
 * @returns {string} 128-bit URL-safe random token, no structure
 */
function newDocId() {
  return crypto.randomBytes(DOCID_BYTES).toString('base64url');
}

module.exports = { newDocId };
