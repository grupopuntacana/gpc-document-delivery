'use strict';

/**
 * Bucket registry — `bucket → OpenText folder` (task 0005, ADR 0005 "doc-type → folder
 * mapping"). A bucket is an **opaque namespace**, never a context concept: the registry
 * knows where a document lands, not what it means (commons DoD-4).
 *
 * Config only — no OpenText calls. Entries come from `OPENTEXT_BUCKETS`, a JSON map:
 *
 *   OPENTEXT_BUCKETS='{"invoices":{"folderNode":52480},"statements":{"folderNode":52481}}'
 *
 * Env rather than a checked-in map so each BTP space points its buckets at its own
 * pre-provisioned folder nodes without a redeploy (matching the other `OPENTEXT_*`
 * tunables). Parsed lazily and memoized: a malformed config fails the request that needs
 * it, not the boot.
 *
 * Three errors, deliberately distinct — the handler maps them to different statuses:
 *   - `BUCKET_REQUIRED`       the caller omitted the field → 400 ("bucket is required")
 *   - `UNKNOWN_BUCKET`        the caller named a bucket we don't have → 400
 *   - `BUCKET_CONFIG_INVALID` the deployed config is broken → 500 (not the caller's fault)
 */

const BUCKETS_ENV = 'OPENTEXT_BUCKETS';

// The bucket name is caller-supplied and echoed into the 400; `bucket` carries no length
// facet in the .cds, so bound how much of it can be reflected back.
const MAX_NAME_IN_ERROR = 64;

let _registry;

function configError(message) {
  const err = new Error(message);
  err.code = 'BUCKET_CONFIG_INVALID';
  return err;
}

function bucketRequired() {
  const err = new Error('bucket is required');
  err.code = 'BUCKET_REQUIRED';
  return err;
}

function unknownBucket(name) {
  // Deliberately does NOT list the configured buckets: the message reaches an
  // authenticated caller as a 400, and enumerating other apps' namespaces would
  // undercut the isolation 0007 adds.
  const err = new Error(`unknown bucket: ${JSON.stringify(name.slice(0, MAX_NAME_IN_ERROR))}`);
  err.code = 'UNKNOWN_BUCKET';
  return err;
}

/**
 * Parse + validate `OPENTEXT_BUCKETS` once. Validation is eager over every entry so a
 * typo in an unused bucket still surfaces on the first upload, not weeks later.
 */
function registry() {
  if (_registry) return _registry;

  const raw = process.env[BUCKETS_ENV];
  if (!raw || !raw.trim()) {
    _registry = new Map();
    return _registry;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw configError(`${BUCKETS_ENV} is not valid JSON: ${e.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw configError(`${BUCKETS_ENV} must be a JSON object of bucket -> { folderNode }`);
  }

  _registry = new Map(Object.entries(parsed).map(([name, entry]) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw configError(`${BUCKETS_ENV}: bucket "${name}" must be an object with a folderNode`);
    }
    // 0006 will accept `{ parentNode, folderName }` here and self-provision the folder;
    // keep that branch behind resolveBucket() so the handler contract doesn't move.
    //
    // Type-check before coercing: Number(true) === 1 and Number([5816]) === 5816 would both
    // sail through the isInteger check below and silently route documents to the wrong node.
    const configured = entry.folderNode;
    const isNumeric = typeof configured === 'number'
      || (typeof configured === 'string' && /^\d+$/.test(configured.trim()));
    const folderNode = isNumeric ? Number(configured) : NaN;
    if (!Number.isInteger(folderNode) || folderNode <= 0) {
      throw configError(
        `${BUCKETS_ENV}: bucket "${name}" has an invalid folderNode: ${JSON.stringify(entry.folderNode)}`,
      );
    }
    return [name, { folderNode }];
  }));
  return _registry;
}

/**
 * Resolve a bucket name to its OpenText target folder.
 *
 * @param {string} name bucket name as supplied by the caller (opaque namespace)
 * @returns {{folderNode: number}} a fresh object — mutating it cannot corrupt the registry
 * @throws  `BUCKET_REQUIRED` when absent/empty, `UNKNOWN_BUCKET` when unconfigured,
 *          `BUCKET_CONFIG_INVALID` on bad config
 */
function resolveBucket(name) {
  // Map lookup (not a plain object) so 'constructor'/'__proto__' are ordinary misses.
  if (typeof name !== 'string' || !name.trim()) throw bucketRequired();
  const entry = registry().get(name);
  if (!entry) throw unknownBucket(name);
  return { ...entry };
}

/** Clear the memoized config (tests / a config change without a restart). */
function clearRegistryCache() {
  _registry = undefined;
}

// 0007 adds the writer ACL here — `allowedWriters` per entry plus a `mayWrite(azp, bucket)`
// predicate the handler calls before resolveBucket(). Kept out of this slice on purpose:
// every authenticated caller may currently name any configured bucket.

module.exports = {
  resolveBucket,
  clearRegistryCache,
};
