'use strict';

const cds = require('@sap/cds');

const archives = require('./lib/archives');
const buckets = require('./lib/buckets');
const delivery = require('./lib/delivery');
const opentext = require('./lib/opentext');
const token = require('./lib/token');
const { makeDocToken } = require('./lib/doctoken');
const { newDocId } = require('./lib/docref');

const LOG = cds.log('link');

// The ONE thin transport boundary this service depends on. LinkService's durable value — the
// Document registry, docId minting, mayRead/folder-guard authorization and short-lived token
// minting — is deliberately kept OFF the concrete OpenText client: it talks to OpenText only
// through this seam. When the family's shared `@gpc/attachments-opentext` module becomes the
// ingest-to-OpenText layer, only these bindings move; the handler logic below survives the
// swap untouched. Tests override `deps` to mock the transport, not the concrete client.
const deps = {
  // Confirm a node is a direct child of a folder — the folder-guard for an app-to-app claim.
  nodeInFolder: (nodeId, folderId) => opentext.nodeInFolder(nodeId, folderId),
  // Error formatting for an upstream failure (not a round trip; kept here so the handler has a
  // single transport-facing object).
  describeError: (err) => opentext.describeError(err),
};

// The delivery credential is SHORT-LIVED (ADR 0006 §3): a fresh /invoice/{token} minted per
// call. The model is re-mint-on-demand — a consumer (a list view, a page render) asks for a
// link when it shows an object and asks again when it refreshes, so the link only has to
// outlive the view that requested it. 24h is the safe default for that: long enough for a human
// to click within the day, short enough that a leaked link dies fast. NEVER the 30-day
// makeToken default. A caller that needs a link to persist (emailed, ticketed) passes an
// explicit `ttlDays`; one that needs it shorter does the same.
const LINKFOR_TOKEN_TTL_HOURS = Number(process.env.LINKFOR_TOKEN_TTL_HOURS || 24);

// Upper bound for a v2 `/doc` link (ADR 0009). A caller may ask for a long-lived link (an emailed
// bill), but never an effectively-permanent one.
const DOC_LINK_MAX_TTL_DAYS = Number(process.env.DOC_LINK_MAX_TTL_DAYS || 90);

// Where the anonymous deliver route lives (srv/server.js `GET /invoice/:token`). Absolute when
// DELIVERY_BASE_URL is set (the deployed srv route); otherwise a root-relative path, which is
// all the local/test caller needs to redeem the token.
const DELIVERY_BASE_URL = (process.env.DELIVERY_BASE_URL || '').replace(/\/+$/, '');

/**
 * Derive the caller's OAuth authorized party; '' when the token carries no claim. Same rule as
 * IngestService.callerAzp — `authInfo.token.azp` only, never `req.user.attr` (stripped on the
 * IAS path, absent on client-credentials), so the read scope cannot be silently widened.
 * @param {object} user `req.user`
 * @returns {string}
 */
function callerAzp(user) {
  const azp = user?.authInfo?.token?.azp;
  return typeof azp === 'string' ? azp.trim() : '';
}

/**
 * The effective delivery-token TTL in days. An explicit positive `ttlDays` wins; otherwise the
 * short LINKFOR_TOKEN_TTL_HOURS default, expressed as a fraction of a day. Never the 30-day
 * makeToken default.
 * @param {*} requested the caller's `ttlDays` argument (may be undefined/invalid)
 * @returns {number}
 */
function effectiveTtlDays(requested) {
  const n = Number(requested);
  return Number.isFinite(n) && n > 0 ? n : LINKFOR_TOKEN_TTL_HOURS / 24;
}

/**
 * Mint a fresh delivery token over `nodeId` and assemble the /invoice/{token} URL. The nodeId
 * goes INTO the HMAC token and no further — it never appears in the returned object. `now` is
 * pinned so the returned `expiresAt` matches the token's baked-in expiry exactly.
 * @returns {Promise<{deliveryUrl: string, expiresAt: Date}>}
 */
async function mintLink(nodeId, requestedTtlDays) {
  const ttlDays = effectiveTtlDays(requestedTtlDays);
  const nowSec = Math.floor(Date.now() / 1000);
  const tok = await token.makeToken(nodeId, { ttlDays, now: nowSec });
  const deliveryUrl = `${DELIVERY_BASE_URL}/invoice/${tok}`;
  const expiresAt = new Date((nowSec + Math.trunc(ttlDays * 86400)) * 1000);
  return { deliveryUrl, expiresAt };
}

/**
 * Mint a v2 `/doc/{token}` link over a `docId` (ADR 0009). Used for every row source that the
 * v1 `/invoice` token cannot carry (today: ArchiveLink). The token names only the docId; the
 * route resolves the row, so revocation reaches outstanding links immediately.
 * @returns {Promise<{deliveryUrl: string, expiresAt: Date}>}
 */
async function mintDocLink(docId, requestedTtlDays) {
  // v2 links are capped; the v1 /invoice mint keeps its historical (uncapped) behavior.
  const ttlDays = Math.min(effectiveTtlDays(requestedTtlDays), DOC_LINK_MAX_TTL_DAYS);
  const ttlSeconds = Math.trunc(ttlDays * 86400);
  const { token: tok, expiresAt } = await makeDocToken(docId, { ttlSeconds });
  return { deliveryUrl: `${DELIVERY_BASE_URL}/doc/${tok}`, expiresAt };
}

/** Mint the link the row's source is served by. OpenText rows keep the v1 `/invoice` link. */
function mintForRow(row, requestedTtlDays) {
  return delivery.linkKind(row) === 'doc'
    ? mintDocLink(row.docId, requestedTtlDays)
    : mintLink(row.nodeId, requestedTtlDays);
}

// ArchiveLink business-link fields S/4 may declare (TOA01 widths). Optional, audit-only.
const ARCHIVE_META = { sapObject: 10, objectId: 50, docType: 10 };

/**
 * Normalize the optional ArchiveLink metadata. Returns `null` (→ 400) when a supplied value is
 * not a string or exceeds its TOA01 width — never silently truncated into the audit row.
 */
function archiveMeta(data) {
  const entries = Object.entries(ARCHIVE_META).map(([field, max]) => {
    const v = data[field];
    if (v == null || v === '') return [field, null];
    if (typeof v !== 'string' || !v.trim() || v.trim().length > max) return [field, undefined];
    return [field, v.trim()];
  });
  if (entries.some(([, v]) => v === undefined)) return null;
  return Object.fromEntries(entries);
}

module.exports = class LinkService extends cds.ApplicationService {
  init() {
    // The ownership/revocation store (db/schema.cds) — reached by its db name, never projected
    // here, so no queryable entity exposes the nodeId (DoD-5).
    const { Documents } = cds.entities('gpc.documentdelivery');

    /**
     * linkFor(docId) — the client-safe re-mint path (READ side, ADR 0006/0008). Resolve the
     * opaque claim-check, authorize the caller as a READER of the row's bucket (`mayRead` =
     * readers ∪ writers), mint a fresh short-lived link. This is the cross-app path: a doc
     * uploaded/owned by app X is delivered by app Y when Y is a reader of X's bucket — the
     * `ownerAzp` on the row is X for audit/revoke, but it does not gate the read. A raw nodeId
     * is never accepted or returned. Unknown / not-a-reader / revoked all collapse to 404 (mint
     * nothing, do not confirm a docId the caller may not see — ADR 0006 §4).
     */
    this.on('linkFor', async (req) => {
      const azp = callerAzp(req.user);
      // Provenance must be present at the boundary (DoD-2); an azp-less caller is a 403, not a
      // 404 — it is an auth failure, not a missing document.
      if (!azp) return req.reject(403, 'caller token carries no azp claim');

      const { docId } = req.data;
      // An empty docId resolves to nothing; answer the same opaque 404 as an unknown one.
      if (typeof docId !== 'string' || !docId.trim()) return req.reject(404, 'not found');

      const row = await SELECT.one.from(Documents).where({ docId });
      let allowed = false;
      if (row && !row.revoked) {
        try {
          allowed = delivery.mayRead(azp, row);
        } catch (err) {
          // A malformed bucket / repository registry (or a row with an unknown source) is our
          // fault, not the caller's: log the reason and answer 500, as linkForArchive does.
          LOG.error('linkFor: read-scope registry is misconfigured:', err.message);
          return req.reject(500, 'registry is misconfigured');
        }
      }
      if (!allowed) {
        LOG.warn(`linkFor denied for azp "${azp}" (docId not found, not a reader, or revoked)`);
        return req.reject(404, 'not found');
      }

      const { deliveryUrl, expiresAt } = await mintForRow(row, req.data.ttlDays);
      LOG.info(`linkFor minted for docId ${docId} (azp "${azp}", ${delivery.scope(row)})`);
      return { deliveryUrl, expiresAt };
    });

    /**
     * linkForArchive(contRep, archDocId, …) — S/4-native delivery (ADR 0009). S/4 already holds
     * the ArchiveLink (TOA01 `ARCHIV_ID` + `ARC_DOC_ID`) for a document it archived; it calls
     * this, authenticated as its own IAS/OAuth client, to get a short-lived public link.
     *
     * The ArchiveLink id is a LOCATOR, not a credential — SAP GUIDs are time/host based, so a
     * caller holding one proves nothing. The gate is the caller's `azp` against the repository's
     * `allowedReaders` (archives.js), the same fail-closed, 404-on-deny shape as a bucket.
     *
     * The row is upserted lazily, keyed by `(contRep, archDocId)` — one row per archived
     * document, so a reprint (a new ARC_DOC_ID for the same print document) is a new row, and
     * revoking a row stops both future mints and outstanding `/doc` links. The returned `docId`
     * lets a caller re-mint later through the ordinary `linkFor(docId)`.
     */
    this.on('linkForArchive', async (req) => {
      const azp = callerAzp(req.user);
      if (!azp) return req.reject(403, 'caller token carries no azp claim');

      const { contRep, archDocId } = req.data;
      // Shape validation is not an oracle (it says nothing about what exists), so a malformed
      // locator is an honest 400; everything past this point collapses to 404.
      if (!archives.isValidLocator(contRep, archDocId)) {
        return req.reject(400, 'contRep must be 2 chars [A-Z0-9] and archDocId 1-40 chars [A-Za-z0-9]');
      }
      const meta = archiveMeta(req.data);
      if (!meta) return req.reject(400, 'sapObject/objectId/docType must be strings within their ArchiveLink widths');

      let allowed;
      try {
        allowed = archives.mayRead(azp, contRep);
      } catch (err) {
        LOG.error('ArchiveLink repository registry is misconfigured:', err.message);
        return req.reject(500, 'archive registry is misconfigured');
      }
      if (!allowed) {
        LOG.warn(`linkForArchive denied for azp "${azp}": not a reader of repository "${contRep}"`);
        return req.reject(404, 'not found');
      }

      // Revocation is per archived document, not per row: two concurrent first claims can race
      // into two rows, so ANY revoked row for this locator blocks the mint (ADR 0009).
      const rows = await SELECT.from(Documents).columns('docId', 'revoked')
        .where({ source: 'archivelink', contRep, archDocId });
      const existing = rows.find((r) => !r.revoked);
      if (rows.some((r) => r.revoked)) {
        LOG.warn(`linkForArchive denied: ${contRep}/${archDocId} is revoked`);
        return req.reject(404, 'not found');
      }
      let docId = existing && existing.docId;
      if (!docId) {
        docId = newDocId();
        await INSERT.into(Documents).entries({
          docId,
          source: 'archivelink',
          contRep,
          archDocId,
          ...meta,
          ownerAzp: azp,
          revoked: false,
          createdAt: new Date().toISOString(),
        });
        LOG.info(`linkForArchive claimed ${contRep}/${archDocId} as docId ${docId} (azp "${azp}")`);
      }

      const { deliveryUrl, expiresAt } = await mintDocLink(docId, req.data.ttlDays);
      LOG.info(`linkForArchive minted for docId ${docId} (azp "${azp}", repository "${contRep}")`);
      return { docId, deliveryUrl, expiresAt };
    });

    /**
     * The WRITE-side claim shared by `register` and `linkForNode` (ADR 0007 §6, ADR 0008). A
     * trusted app-to-app WRITER claims a node it uploaded directly via @cap-js/attachments, for
     * which no Documents row exists yet. Two independent checks: (1) the caller must be a WRITER
     * of the named bucket (`mayWrite`) — claiming is a write-authority act, so a read-only
     * consumer cannot mint ownership; (2) the node must actually sit in that bucket's folder
     * (`nodeInFolder`). Either failing is a 404 (never an oracle, never bucket enumeration by
     * status code). The row is then upserted LAZILY so the document is revocable/auditable.
     *
     * Returns `{ docId, nodeId }`; `req.reject` throws on every failure path, so a caller that
     * awaits this either gets the claim or the request is already rejected.
     */
    const claimNode = async (req, label) => {
      const azp = callerAzp(req.user);
      if (!azp) return req.reject(403, 'caller token carries no azp claim');

      const { bucket, nodeId } = req.data;
      if (typeof bucket !== 'string' || !bucket.trim() || nodeId == null) {
        return req.reject(404, 'not found');
      }
      // The caller may only claim within a bucket it WRITES. An unknown bucket and a not-yours
      // bucket both fail here, so neither is distinguishable by status code (no enumeration).
      if (!buckets.mayWrite(azp, bucket)) {
        LOG.warn(`${label} denied for azp "${azp}": not a writer of bucket "${bucket}"`);
        return req.reject(404, 'not found');
      }

      let folderNode;
      try {
        ({ folderNode } = await buckets.resolveBucket(bucket));
      } catch (err) {
        if (err.code === 'FOLDER_PROVISION_FAILED') {
          const reason = deps.describeError(err);
          LOG.error(`${label} folder provisioning failed for bucket "${bucket}":`, reason);
          return req.reject(502, `OpenText folder provisioning failed: ${reason}`);
        }
        LOG.error(`${label} bucket resolution failed for "${bucket}":`, err.message);
        return req.reject(500, 'bucket registry is misconfigured');
      }

      // The folder guard: read the node's OTCS parent and confirm it is this bucket's folder.
      let inFolder;
      try {
        inFolder = await deps.nodeInFolder(nodeId, folderNode);
      } catch (err) {
        const reason = deps.describeError(err);
        LOG.error(`${label} parent lookup failed for node ${nodeId}:`, reason);
        return req.reject(502, `OpenText parent lookup failed: ${reason}`);
      }
      if (!inFolder) {
        LOG.warn(`${label} denied: node ${nodeId} is not in bucket "${bucket}"'s folder`);
        return req.reject(404, 'not found');
      }

      // Lazy upsert: reuse an existing row (so revocation/audit are honored), else create one.
      const existing = await SELECT.one.from(Documents).where({ source: 'otcs', nodeId, bucket });
      if (existing && existing.revoked) {
        // A revoked node stays revoked — a re-claim must not resurrect a killed link.
        LOG.warn(`${label} denied: node ${nodeId} in bucket "${bucket}" is revoked`);
        return req.reject(404, 'not found');
      }
      let docId = existing && existing.docId;
      if (!docId) {
        docId = newDocId();
        await INSERT.into(Documents).entries({
          docId,
          source: 'otcs',
          nodeId,
          bucket,
          ownerAzp: azp,
          revoked: false,
          createdAt: new Date().toISOString(),
        });
        LOG.info(`${label} claimed node ${nodeId} in bucket "${bucket}" as docId ${docId}`);
      }
      return { docId, nodeId };
    };

    /**
     * register(bucket, nodeId) — the WRITE-side claim on its own (ADR 0008). A writer that
     * uploaded a node directly (via the plugin) claims it and gets back the opaque `docId` to
     * store in its own domain table. It mints NO link — a reader app later delivers it with
     * linkFor(docId). This is what decouples "who uploaded" from "who delivers".
     */
    this.on('register', async (req) => {
      const { docId } = await claimNode(req, 'register');
      return { docId };
    });

    /**
     * linkForNode(bucket, nodeId) — the WRITE-side convenience: register + mint in one call,
     * for the app that both uploads and delivers its own node. Same folder-guarded writer
     * authorization as `register`; a reader-only app uses linkFor(docId) instead.
     */
    this.on('linkForNode', async (req) => {
      const { nodeId } = await claimNode(req, 'linkForNode');
      const { deliveryUrl, expiresAt } = await mintLink(nodeId, req.data.ttlDays);
      return { deliveryUrl, expiresAt };
    });

    return super.init();
  }
};

// Exposed for unit tests: `deps` is the transport seam (mock the transport, not the concrete
// client); the two helpers are pure and unit-tested directly.
module.exports.deps = deps;
module.exports.callerAzp = callerAzp;
module.exports.effectiveTtlDays = effectiveTtlDays;
