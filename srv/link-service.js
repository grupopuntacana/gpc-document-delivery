'use strict';

const cds = require('@sap/cds');

const buckets = require('./lib/buckets');
const opentext = require('./lib/opentext');
const token = require('./lib/token');
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

module.exports = class LinkService extends cds.ApplicationService {
  init() {
    // The ownership/revocation store (db/schema.cds) — reached by its db name, never projected
    // here, so no queryable entity exposes the nodeId (DoD-5).
    const { Documents } = cds.entities('gpc.documentdelivery');

    /**
     * linkFor(docId) — the client-safe re-mint path. Resolve the opaque claim-check, authorize
     * the caller against the row's bucket, mint a fresh short-lived link. A raw nodeId is never
     * accepted or returned. Unknown / non-owned / revoked all collapse to 404 (mint nothing,
     * do not confirm a docId the caller may not see — ADR 0006 §4).
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
      if (!row || row.revoked || !buckets.mayRead(azp, row.bucket)) {
        LOG.warn(`linkFor denied for azp "${azp}" (docId not found, not owned, or revoked)`);
        return req.reject(404, 'not found');
      }

      const { deliveryUrl, expiresAt } = await mintLink(row.nodeId, req.data.ttlDays);
      LOG.info(`linkFor minted for docId ${docId} (azp "${azp}", bucket "${row.bucket}")`);
      return { deliveryUrl, expiresAt };
    });

    /**
     * linkForNode(bucket, nodeId) — the ADR 0007 §6 folder-guarded claim. A trusted app-to-app
     * caller shares a node it uploaded directly (via @cap-js/attachments), for which no
     * Documents row exists yet.
     *
     * API choice: a SEPARATE action, not an optional nodeId on linkFor. Accepting a nodeId is
     * the sensitive move ADR 0006 designed away, so it lives on its own explicitly-named,
     * authenticated surface — the client-facing linkFor stays opaque-only. Authorization is
     * two independent checks: (1) the caller must own the named bucket (`mayRead`), so it can
     * only ever name its OWN folder; (2) the node must actually sit in that folder
     * (`nodeInFolder`). Either failing is a 404 — never an oracle over the store, never an
     * enumeration of buckets by status code. The row is then upserted LAZILY (create-on-first-
     * share, ADR 0007 §4) so the shared document is revocable/auditable from here on.
     */
    this.on('linkForNode', async (req) => {
      const azp = callerAzp(req.user);
      if (!azp) return req.reject(403, 'caller token carries no azp claim');

      const { bucket, nodeId } = req.data;
      if (typeof bucket !== 'string' || !bucket.trim() || nodeId == null) {
        return req.reject(404, 'not found');
      }
      // The caller may only claim within its own bucket. An unknown bucket and a not-yours
      // bucket both fail here, so neither is distinguishable by status code (no enumeration).
      if (!buckets.mayRead(azp, bucket)) {
        LOG.warn(`linkForNode denied for azp "${azp}": not a reader of bucket "${bucket}"`);
        return req.reject(404, 'not found');
      }

      let folderNode;
      try {
        ({ folderNode } = await buckets.resolveBucket(bucket));
      } catch (err) {
        if (err.code === 'FOLDER_PROVISION_FAILED') {
          const reason = deps.describeError(err);
          LOG.error(`linkForNode folder provisioning failed for bucket "${bucket}":`, reason);
          return req.reject(502, `OpenText folder provisioning failed: ${reason}`);
        }
        LOG.error(`linkForNode bucket resolution failed for "${bucket}":`, err.message);
        return req.reject(500, 'bucket registry is misconfigured');
      }

      // The folder guard: read the node's OTCS parent and confirm it is this bucket's folder.
      let inFolder;
      try {
        inFolder = await deps.nodeInFolder(nodeId, folderNode);
      } catch (err) {
        const reason = deps.describeError(err);
        LOG.error(`linkForNode parent lookup failed for node ${nodeId}:`, reason);
        return req.reject(502, `OpenText parent lookup failed: ${reason}`);
      }
      if (!inFolder) {
        LOG.warn(`linkForNode denied: node ${nodeId} is not in bucket "${bucket}"'s folder`);
        return req.reject(404, 'not found');
      }

      // Lazy upsert: reuse an existing row (so revocation/audit are honored), else create one.
      const existing = await SELECT.one.from(Documents).where({ nodeId, bucket });
      if (existing && existing.revoked) {
        // A revoked node stays revoked — a re-claim must not resurrect a killed link.
        LOG.warn(`linkForNode denied: node ${nodeId} in bucket "${bucket}" is revoked`);
        return req.reject(404, 'not found');
      }
      let docId = existing && existing.docId;
      if (!docId) {
        docId = newDocId();
        await INSERT.into(Documents).entries({
          docId,
          nodeId,
          bucket,
          ownerAzp: azp,
          revoked: false,
          createdAt: new Date().toISOString(),
        });
        LOG.info(`linkForNode claimed node ${nodeId} in bucket "${bucket}" as docId ${docId}`);
      }

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
