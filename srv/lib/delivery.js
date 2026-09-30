'use strict';

/**
 * Source dispatch for a `Documents` row (ADR 0009): who may read it, which link serves it, how
 * to fetch its bytes (stream mode) or publish it to the CDN cache (cdn mode) — whatever system
 * of record it lives in.
 *
 *   source 'otcs'        → OpenText Content Server node (`opentext.js`, `cdn.publish`)
 *   source 'archivelink' → S/4 ArchiveLink content repository (`archivelink.js`)
 *
 * LinkService and the anonymous routes go through here, so adding a source is one entry in
 * `SOURCES` — never a `row.source === …` branch in a handler.
 */

const cds = require('@sap/cds');

const LOG = cds.log('delivery');

const archives = require('./archives');
const archivelink = require('./archivelink');
const buckets = require('./buckets');
const cdn = require('./cdn');
const opentext = require('./opentext');

// Characters allowed in a synthesized download name. `objectId` / `docType` are caller-declared,
// so they are reduced to a safe token rather than trusted into a Content-Disposition header.
const unsafe = /[^A-Za-z0-9._-]+/g;
const safePart = (v) => String(v || '').replace(unsafe, '_').replace(/^[._-]+|[._-]+$/g, '').slice(0, 60);

/** `ISU_BILL-050000000006.pdf` when S/4 declared the business link, else `C1-<archDocId>.pdf`. */
function archiveFileName(row, contentType) {
  const ext = opentext.extensionForType(contentType);
  const objectPart = safePart(row.objectId);
  const base = objectPart
    ? `${safePart(row.docType) || safePart(row.sapObject) || 'document'}-${objectPart}`
    : `${row.contRep}-${row.archDocId}`;
  return opentext.sanitizeFileName(`${base}.${ext}`);
}

function archiveLocator(row) {
  const { destination, compId } = archives.resolveRepository(row.contRep);
  return {
    contRep: row.contRep, archDocId: row.archDocId, destination, compId,
  };
}

// One entry per row source. Everything that differs between an OpenText node and an
// ArchiveLink document is a field here, so callers never branch on `row.source`:
//   label      log label for the row's location (never the docId)
//   scope      log label for the read scope
//   mayRead    may this azp mint a link for the row? (ADR 0008 bucket / ADR 0009 repository)
//   link       which anonymous route serves the row: 'invoice' (v1 token) or 'doc' (v2 token)
//   locator    fields identifying the underlying document when several rows can point at it
//              (revocation is enforced per locator), or null when the row IS the document
//   fetch      the bytes, for stream mode
//   publish    ensure it is in the CDN cache, return a signed URL
const SOURCES = {
  otcs: {
    label: (row) => `node=${row.nodeId}`,
    scope: (row) => `bucket "${row.bucket}"`,
    mayRead: (azp, row) => buckets.mayRead(azp, row.bucket),
    link: 'invoice',
    locator: () => null,
    async fetch(row) {
      const { buffer, contentType, fileName } = await opentext.downloadDocument(row.nodeId);
      return {
        buffer, contentType, fileName: opentext.downloadFileName(row.nodeId, contentType, fileName),
      };
    },
    publish: (row) => cdn.publish(row.nodeId),
  },
  archivelink: {
    label: (row) => `archive=${row.contRep}/${row.archDocId}`,
    scope: (row) => `repository "${row.contRep}"`,
    mayRead: (azp, row) => archives.mayRead(azp, row.contRep),
    link: 'doc',
    locator: (row) => ({ source: 'archivelink', contRep: row.contRep, archDocId: row.archDocId }),
    async fetch(row) {
      const { buffer, contentType } = await archivelink.downloadDocument(archiveLocator(row));
      return { buffer, contentType, fileName: archiveFileName(row, contentType) };
    },
    publish(row) {
      return cdn.publishObject({
        key: `archivelink/${row.contRep}/${row.archDocId}`, // never collides with documents/<nodeId>.pdf
        label: SOURCES.archivelink.label(row),
        metadata: { 'archivelink-contrep': row.contRep, 'archivelink-docid': row.archDocId },
        sourceOfTruth: 'archivelink',
        load: () => SOURCES.archivelink.fetch(row),
      });
    },
  },
};

function sourceOf(row) {
  const src = SOURCES[row && row.source];
  if (!src) throw new Error(`unsupported document source: ${JSON.stringify(row && row.source)}`);
  return src;
}

/** A short log label for the row's location. Never includes the docId. */
const label = (row) => sourceOf(row).label(row);

/** A short log label for the row's read scope (bucket / repository). */
const scope = (row) => sourceOf(row).scope(row);

/** May `azp` mint a link for this row? Fails closed; throws on a broken registry. */
const mayRead = (azp, row) => sourceOf(row).mayRead(azp, row);

/** Which anonymous route serves the row: 'invoice' (v1 token) or 'doc' (v2 token). */
const linkKind = (row) => sourceOf(row).link;

/**
 * Fetch the row's bytes.
 * @returns {Promise<{buffer:Buffer, contentType:string, fileName:string}>}
 */
const fetchDocument = (row) => sourceOf(row).fetch(row);

/** Ensure the row is in the CDN cache and return a short-lived CloudFront signed URL. */
const publishDocument = (row) => sourceOf(row).publish(row);

/** Human-readable reason for an upstream failure, whichever source raised it. */
const describeError = (err) => opentext.describeError(err);

/**
 * Resolve a `docId` to a row that may still be delivered, or null when it is missing or
 * revoked. Revocation is per DOCUMENT: when a source can have several rows for one underlying
 * document (ArchiveLink — concurrent first claims can race into two rows, ADR 0009), any
 * revoked row for that locator revokes them all. A row with an unknown source is not deliverable.
 * @returns {Promise<?object>}
 */
async function resolveDeliverable(docId) {
  const { Documents } = cds.entities('gpc.documentdelivery');
  const row = await SELECT.one.from(Documents).where({ docId });
  if (!row || row.revoked) return null;
  const source = SOURCES[row.source];
  if (!source) {
    // Schema drift or a hand-written row. The anonymous caller gets the same opaque 404 as for
    // a missing document; the operator gets the reason.
    LOG.warn(`document row has an unsupported source ${JSON.stringify(row.source)}`);
    return null;
  }
  const locator = source.locator(row);
  if (locator) {
    const revokedSibling = await SELECT.one.from(Documents).columns('docId')
      .where({ ...locator, revoked: true });
    if (revokedSibling) return null;
  }
  return row;
}

module.exports = {
  fetchDocument,
  publishDocument,
  resolveDeliverable,
  mayRead,
  linkKind,
  label,
  scope,
  describeError,
  contentDisposition: opentext.contentDisposition,
  // exported for unit tests
  archiveFileName,
  SOURCES,
};
