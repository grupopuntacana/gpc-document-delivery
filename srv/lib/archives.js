'use strict';

/**
 * ArchiveLink repository registry — `contRep → { allowedReaders, destination, compId }`
 * (ADR 0009). The ArchiveLink twin of `buckets.js`: where a bucket scopes the BTP-uploaded
 * OpenText nodes an app may deliver, a content repository scopes the S/4-archived documents
 * (TOA01 `ARCHIV_ID`) a caller may mint links for.
 *
 * Entries come from `ARCHIVELINK_REPOSITORIES`, a JSON map keyed by the 2-char repository id:
 *
 *   ARCHIVELINK_REPOSITORIES='{
 *     "C1": {"allowedReaders": ["s4-prd-azp"],
 *            "destination": "OpenText_OTAC",   // optional, see below
 *            "compId": "data"}                           // optional, see below
 *   }'
 *
 * - `allowedReaders` — the OAuth `azp` values allowed to mint delivery links for documents in
 *   this repository. There is no writer ACL: document-delivery never writes into an ArchiveLink
 *   repository, S/4 does. No wildcard, no open-by-default — an empty list grants nothing.
 * - `destination` — the BTP destination whose base URL speaks the SAP Content Server HTTP
 *   protocol for this repository. Defaults to `ARCHIVELINK_DESTINATION` (itself defaulting to
 *   `OpenText_OTAC`), so one archive server serving several repositories is one
 *   destination.
 * - `compId` — the component to fetch. ArchiveLink stores a document's content as component
 *   `data` for single-component documents (PDF print lists, ISU_BILL); override per repository
 *   only if the archive server says otherwise.
 *
 * Authorization is repository-level ON PURPOSE. `sapObject` / `objectId` / `docType` are
 * declared by the caller and never verified against TOA01, so gating on them would be
 * security theatre; the repository is the trust boundary, exactly like a bucket.
 *
 * Same shape as buckets.js: parsed lazily and memoized, eager validation of every entry, a
 * malformed config fails the request that needs it (`ARCHIVE_CONFIG_INVALID` → 500), never
 * the boot. `mayRead` is total and fails closed.
 */

const REPOS_ENV = 'ARCHIVELINK_REPOSITORIES';

const DEFAULT_DESTINATION = process.env.ARCHIVELINK_DESTINATION || 'OpenText_OTAC';
const DEFAULT_COMP_ID = 'data';

// TOA01 ARCHIV_ID is CHAR(2); ARC_DOC_ID is CHAR(40). Both are SAP-generated alphanumerics.
// Validating the shape (not just the length) is what keeps a caller-supplied value from
// smuggling `&` / `/` into the Content Server query string built from it.
const CONTREP_RE = /^[A-Z0-9]{2}$/;
const ARCH_DOC_ID_RE = /^[A-Za-z0-9]{1,40}$/;
const COMP_ID_RE = /^[A-Za-z0-9._-]{1,32}$/;
const DESTINATION_RE = /^[A-Za-z0-9._-]{1,200}$/;

let _registry;

function configError(message) {
  const err = new Error(message);
  err.code = 'ARCHIVE_CONFIG_INVALID';
  return err;
}

function readersSet(repo, configured) {
  if (configured === undefined) return new Set();
  if (!Array.isArray(configured)) {
    throw configError(
      `${REPOS_ENV}: repository "${repo}" has an invalid allowedReaders `
        + `(must be an array of azp strings): ${JSON.stringify(configured)}`,
    );
  }
  return new Set(configured.map((azp) => {
    const trimmed = typeof azp === 'string' ? azp.trim() : '';
    if (!trimmed) {
      throw configError(
        `${REPOS_ENV}: repository "${repo}" has an invalid allowedReaders entry: ${JSON.stringify(azp)}`,
      );
    }
    return trimmed;
  }));
}

function optionalToken(repo, field, configured, re, fallback) {
  if (configured === undefined) return fallback;
  if (typeof configured !== 'string' || !re.test(configured)) {
    throw configError(
      `${REPOS_ENV}: repository "${repo}" has an invalid ${field}: ${JSON.stringify(configured)}`,
    );
  }
  return configured;
}

/** Parse + validate `ARCHIVELINK_REPOSITORIES` once. */
function registry() {
  if (_registry) return _registry;

  const raw = process.env[REPOS_ENV];
  if (!raw || !raw.trim()) {
    _registry = new Map();
    return _registry;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw configError(`${REPOS_ENV} is not valid JSON: ${e.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw configError(`${REPOS_ENV} must be a JSON object of contRep -> { allowedReaders, ... }`);
  }

  _registry = new Map(Object.entries(parsed).map(([repo, entry]) => {
    if (!CONTREP_RE.test(repo)) {
      throw configError(`${REPOS_ENV}: "${repo}" is not a content repository id (2 chars, A-Z0-9)`);
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw configError(`${REPOS_ENV}: repository "${repo}" must be an object`);
    }
    return [repo, {
      allowedReaders: readersSet(repo, entry.allowedReaders),
      destination: optionalToken(repo, 'destination', entry.destination, DESTINATION_RE, DEFAULT_DESTINATION),
      compId: optionalToken(repo, 'compId', entry.compId, COMP_ID_RE, DEFAULT_COMP_ID),
    }];
  }));
  return _registry;
}

/** True when `contRep` / `archDocId` have the TOA01 shape. Total — never throws. */
function isValidLocator(contRep, archDocId) {
  return typeof contRep === 'string' && CONTREP_RE.test(contRep)
    && typeof archDocId === 'string' && ARCH_DOC_ID_RE.test(archDocId);
}

/**
 * May this caller mint a delivery link for a document in this repository? Synchronous
 * registry lookup, fails closed (empty azp, unknown repository, empty ACL → false).
 * @throws `ARCHIVE_CONFIG_INVALID` when the deployed registry is broken
 */
function mayRead(azp, contRep) {
  if (typeof azp !== 'string' || !azp.trim()) return false;
  if (typeof contRep !== 'string') return false;
  const entry = registry().get(contRep);
  if (!entry) return false;
  return entry.allowedReaders.has(azp.trim());
}

/**
 * Where to fetch a repository's documents from. Only called for a row that was authorized at
 * mint time, so an unknown repository here means the config changed underneath the row.
 * @returns {{destination: string, compId: string}}
 * @throws `UNKNOWN_REPOSITORY` / `ARCHIVE_CONFIG_INVALID`
 */
function resolveRepository(contRep) {
  const entry = registry().get(contRep);
  if (!entry) {
    const err = new Error(`unknown ArchiveLink repository: ${JSON.stringify(String(contRep).slice(0, 8))}`);
    err.code = 'UNKNOWN_REPOSITORY';
    throw err;
  }
  return { destination: entry.destination, compId: entry.compId };
}

/** Clear the memoized config (tests / a config change without a restart). */
function clearRegistryCache() {
  _registry = undefined;
}

module.exports = {
  mayRead,
  resolveRepository,
  isValidLocator,
  clearRegistryCache,
  REPOS_ENV,
};
