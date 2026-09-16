'use strict';

/**
 * Bucket registry — `bucket → OpenText folder` (task 0005, ADR 0005 "doc-type → folder
 * mapping"). A bucket is an **opaque namespace**, never a context concept: the registry
 * knows where a document lands, not what it means (commons DoD-4).
 *
 * Entries come from `OPENTEXT_BUCKETS`, a JSON map. A bucket names its target folder one
 * of two ways — exactly one, never both:
 *
 *   OPENTEXT_BUCKETS='{
 *     "invoices":   {"folderNode": 52480,
 *                    "allowedWriters": ["invoice-app-azp"],
 *                    "allowedReaders": ["notifier-app-azp"]},
 *     "statements": {"parentNode": 5816, "folderName": "statements",
 *                    "allowedWriters": ["app-b-client-id"]}
 *   }'
 *
 * Each bucket has TWO per-app ACLs (ADR 0008), mirroring S3's split of `s3:PutObject` from
 * `s3:GetObject`, orthogonal to how the bucket names its folder:
 *   - `allowedWriters` — the OAuth `azp` values allowed to ingest/claim into the bucket.
 *   - `allowedReaders` — the `azp` values allowed to read back and re-mint delivery links.
 * A writer implies read; a reader does NOT imply write. This is what lets a document uploaded
 * by app X be delivered by app Y (X a writer, Y a reader of the same bucket). A bucket with no
 * `allowedWriters` accepts **no** writers, and one with no `allowedReaders` grants read only to
 * its writers — there is no wildcard and no open-by-default: one app cannot touch another's.
 *
 * `folderNode` points at a folder an operator created by hand. `parentNode` + `folderName`
 * lets the bucket create its own folder on first use (task 0006) — no OpenText click-ops
 * per new bucket. Folder *names* are config, never derived from a request body (DoD-4).
 *
 * Env rather than a checked-in map so each BTP space points its buckets at its own
 * folder nodes without a redeploy (matching the other `OPENTEXT_*` tunables). Parsed
 * lazily and memoized: a malformed config fails the request that needs it, not the boot.
 *
 * Four errors, deliberately distinct — the handler maps them to different statuses:
 *   - `BUCKET_REQUIRED`         the caller omitted the field → 400 ("bucket is required")
 *   - `UNKNOWN_BUCKET`          the caller named a bucket we don't have → 400
 *   - `BUCKET_CONFIG_INVALID`   the deployed config is broken → 500 (not the caller's fault)
 *   - `FOLDER_PROVISION_FAILED` OpenText refused to resolve/create the folder → 502
 */

const opentext = require('./opentext');

const BUCKETS_ENV = 'OPENTEXT_BUCKETS';

// The bucket name is caller-supplied and echoed into the 400; `bucket` carries no length
// facet in the .cds, so bound how much of it can be reflected back.
const MAX_NAME_IN_ERROR = 64;

let _registry;

// bucket -> Promise<number> for self-provisioned entries. The *promise* is cached, not the
// id, so a concurrent burst on a cold bucket shares one find-or-create instead of racing
// two creates. No TTL: if someone deletes the folder in OpenText by hand, the memoized id
// points at a dead node until the process restarts. Acceptable for this slice.
let _folderPromises = new Map();

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
  // Deliberately does NOT list the configured buckets: enumerating other apps' namespaces
  // would undercut the write isolation. Note the ingest handler denies an unknown bucket
  // with a 403 before this message is ever reached; it surfaces only to a caller authorized
  // for some other bucket, and through resolveBucket's own unit tests.
  const err = new Error(`unknown bucket: ${JSON.stringify(name.slice(0, MAX_NAME_IN_ERROR))}`);
  err.code = 'UNKNOWN_BUCKET';
  return err;
}

/**
 * Validate a configured node id. Type-check before coercing: `Number(true) === 1` and
 * `Number([5816]) === 5816` would both sail through the isInteger check and silently route
 * documents to the wrong node.
 */
function nodeId(bucket, field, configured) {
  const isNumeric = typeof configured === 'number'
    || (typeof configured === 'string' && /^\d+$/.test(configured.trim()));
  const n = isNumeric ? Number(configured) : NaN;
  if (!Number.isInteger(n) || n <= 0) {
    throw configError(
      `${BUCKETS_ENV}: bucket "${bucket}" has an invalid ${field}: ${JSON.stringify(configured)}`,
    );
  }
  return n;
}

/**
 * Validate one of a bucket's ACLs (`allowedWriters` or `allowedReaders`) into a Set of azp
 * values. Absent or `[]` is legal config and leaves that ACL empty — never open.
 *
 * A non-array or a blank entry is a config error rather than a lenient read: an ACL an
 * operator believes grants access but doesn't is the failure this guards against.
 *
 * @param {string} bucket bucket name (for the error message)
 * @param {string} field the ACL field name — 'allowedWriters' | 'allowedReaders'
 * @param {*} configured the raw value from the parsed config
 */
function aclSet(bucket, field, configured) {
  if (configured === undefined) return new Set();
  if (!Array.isArray(configured)) {
    throw configError(
      `${BUCKETS_ENV}: bucket "${bucket}" has an invalid ${field} `
        + `(must be an array of azp strings): ${JSON.stringify(configured)}`,
    );
  }
  return new Set(configured.map((azp) => {
    const trimmed = typeof azp === 'string' ? azp.trim() : '';
    if (!trimmed) {
      throw configError(
        `${BUCKETS_ENV}: bucket "${bucket}" has an invalid ${field} entry: ${JSON.stringify(azp)}`,
      );
    }
    return trimmed;
  }));
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
    throw configError(`${BUCKETS_ENV} must be a JSON object of bucket -> { folderNode | parentNode + folderName }`);
  }

  _registry = new Map(Object.entries(parsed).map(([name, entry]) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw configError(`${BUCKETS_ENV}: bucket "${name}" must be an object naming its target folder`);
    }
    // A bucket points at its folder exactly one way. Accepting both would need a silent
    // precedence rule, and a bucket routing somewhere other than the obvious reading of
    // its config is a latent routing bug — so reject the ambiguity outright.
    const hasFolderNode = entry.folderNode !== undefined;
    const hasSelfProvision = entry.parentNode !== undefined || entry.folderName !== undefined;
    if (hasFolderNode && hasSelfProvision) {
      throw configError(
        `${BUCKETS_ENV}: bucket "${name}" must specify either folderNode or `
          + 'parentNode + folderName, not both',
      );
    }
    if (!hasFolderNode && !hasSelfProvision) {
      throw configError(
        `${BUCKETS_ENV}: bucket "${name}" must specify a folderNode or parentNode + folderName`,
      );
    }

    const allowedWriters = aclSet(name, 'allowedWriters', entry.allowedWriters);
    const allowedReaders = aclSet(name, 'allowedReaders', entry.allowedReaders);

    if (hasFolderNode) {
      return [name, {
        folderNode: nodeId(name, 'folderNode', entry.folderNode), allowedWriters, allowedReaders,
      }];
    }

    const folderName = typeof entry.folderName === 'string' ? entry.folderName.trim() : '';
    if (!folderName) {
      throw configError(
        `${BUCKETS_ENV}: bucket "${name}" has an invalid folderName: ${JSON.stringify(entry.folderName)}`,
      );
    }
    return [name, {
      parentNode: nodeId(name, 'parentNode', entry.parentNode), folderName, allowedWriters, allowedReaders,
    }];
  }));
  return _registry;
}

/**
 * Resolve a bucket name to its OpenText target folder id.
 *
 * Both rejection paths that blame the caller (`BUCKET_REQUIRED`, `UNKNOWN_BUCKET`) are
 * decided by a synchronous Map lookup, BEFORE any I/O — naming a bucket we don't have
 * still costs zero OpenText calls. Only a self-provisioned bucket's first resolution
 * touches the network, and that result is memoized for the process lifetime.
 *
 * @param {string} name bucket name as supplied by the caller (opaque namespace)
 * @returns {Promise<{folderNode: number}>} a fresh object — mutating it cannot corrupt state
 * @throws  `BUCKET_REQUIRED` when absent/empty, `UNKNOWN_BUCKET` when unconfigured,
 *          `BUCKET_CONFIG_INVALID` on bad config, `FOLDER_PROVISION_FAILED` when OpenText
 *          would not resolve or create the folder
 */
async function resolveBucket(name) {
  // Map lookup (not a plain object) so 'constructor'/'__proto__' are ordinary misses.
  if (typeof name !== 'string' || !name.trim()) throw bucketRequired();
  const entry = registry().get(name);
  if (!entry) throw unknownBucket(name);
  if (entry.folderNode) return { folderNode: entry.folderNode };

  let pending = _folderPromises.get(name);
  if (!pending) {
    // Tag every failure — a refused create, a dead tunnel, a same-named non-folder — so the
    // handler answers 502 (upstream) instead of 500 (our config). The original error rides
    // along as `cause` for describeError.
    pending = opentext.findOrCreateFolder(entry.parentNode, entry.folderName)
      .catch((cause) => {
        const err = new Error(
          `could not resolve folder "${entry.folderName}" under node ${entry.parentNode}`,
          { cause },
        );
        err.code = 'FOLDER_PROVISION_FAILED';
        throw err;
      });
    _folderPromises.set(name, pending);
    // Drop a cached rejection so the next upload retries instead of serving a stuck error
    // (same shape as opentext.js getTicket).
    pending.catch(() => _folderPromises.delete(name));
  }
  return { folderNode: await pending };
}

/** Clear the memoized config and resolved folders (tests / a config change without a restart). */
function clearRegistryCache() {
  _registry = undefined;
  _folderPromises = new Map();
}

/**
 * May this caller write this bucket? A synchronous registry lookup, never a folder
 * resolution — so a denied write costs zero OpenText calls even on a self-provisioned bucket.
 *
 * Fails closed: an empty azp, an unknown bucket and an empty ACL are all `false`. Total
 * rather than throwing, so the handler decides the 400-vs-403 question in one place. The
 * match is exact and case-sensitive.
 *
 * @param {string} azp the caller's OAuth authorized party, derived from its token
 * @param {string} bucket bucket name as supplied by the caller
 * @returns {boolean}
 * @throws `BUCKET_CONFIG_INVALID` when the deployed registry is broken
 */
function mayWrite(azp, bucket) {
  if (typeof azp !== 'string' || !azp.trim()) return false;
  if (typeof bucket !== 'string' || !bucket.trim()) return false;
  const entry = registry().get(bucket);
  if (!entry) return false;
  return entry.allowedWriters.has(azp.trim());
}

/**
 * May this caller MINT a delivery link for a document in this bucket (ADR 0008)? A bucket has
 * TWO ACLs, mirroring S3's split of `s3:PutObject` from `s3:GetObject`:
 *   - `allowedWriters` — apps that ingest/claim into the bucket (the S3 "owner"/PutObject).
 *   - `allowedReaders` — apps that may read back and re-mint links (S3 GetObject).
 * A writer implies read (it owns what it wrote), so read authority is `readers ∪ writers`.
 *
 * This is what lets a document uploaded by app X be delivered by app Y: X is a writer, Y is a
 * reader of the same bucket, and the ownership row (`ownerAzp`) stays X for audit/revoke while
 * the read gate is bucket membership, not ownership. A reader is NOT a writer — it can mint
 * links but cannot ingest or claim (`mayWrite` stays writers-only).
 *
 * Same failure-closed, total, synchronous contract as `mayWrite`.
 *
 * @param {string} azp the caller's OAuth authorized party, derived from its token
 * @param {string} bucket bucket name
 * @returns {boolean}
 * @throws `BUCKET_CONFIG_INVALID` when the deployed registry is broken
 */
function mayRead(azp, bucket) {
  if (typeof azp !== 'string' || !azp.trim()) return false;
  if (typeof bucket !== 'string' || !bucket.trim()) return false;
  const entry = registry().get(bucket);
  if (!entry) return false;
  const a = azp.trim();
  return entry.allowedReaders.has(a) || entry.allowedWriters.has(a);
}

module.exports = {
  resolveBucket,
  mayWrite,
  mayRead,
  clearRegistryCache,
};
