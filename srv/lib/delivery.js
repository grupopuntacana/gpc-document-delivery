'use strict';

/**
 * Source dispatch for a `Documents` row (ADR 0009): given a row, fetch its bytes (stream mode)
 * or publish it to the CDN cache (cdn mode), whatever system of record it lives in.
 *
 *   source 'otcs'        → OpenText Content Server node (`opentext.js`, `cdn.publish`)
 *   source 'archivelink' → S/4 ArchiveLink content repository (`archivelink.js`)
 *
 * The anonymous `GET /doc/:token` route and anything else that serves a row go through here,
 * so adding a source is one entry in `SOURCES` — never a branch in a route handler.
 */

const archives = require('./archives');
const archivelink = require('./archivelink');
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

/** A row's S3 cache key. Never collides with the v1 `documents/<nodeId>.pdf` keys. */
function archiveCacheKey(row) {
  return `archivelink/${row.contRep}/${row.archDocId}`;
}

// Types safe to render INLINE on this service's own origin. Anything else (HTML, SVG, XML, …) is
// served as an attachment: an ArchiveLink repository can hold files ordinary S/4 users attached,
// and an inline text/html from our origin would be stored XSS via a public /doc link.
const INLINE_TYPES = new Set([
  'application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/tiff', 'image/bmp',
  'text/plain',
]);

/** `inline` for allowlisted types, `attachment` otherwise, with a header-safe filename. */
function contentDisposition(contentType, fileName) {
  const base = String(contentType || '').split(';')[0].trim().toLowerCase();
  const mode = INLINE_TYPES.has(base) ? 'inline' : 'attachment';
  return `${mode}; filename="${opentext.sanitizeFileName(fileName)}"`;
}

const SOURCES = {
  otcs: {
    label: (row) => `node=${row.nodeId}`,
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
    async fetch(row) {
      const { buffer, contentType } = await archivelink.downloadDocument(archiveLocator(row));
      const fileName = archiveFileName(row, contentType);
      return {
        buffer, contentType, fileName, disposition: contentDisposition(contentType, fileName),
      };
    },
    publish(row) {
      return cdn.publishObject({
        key: archiveCacheKey(row),
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

/**
 * Fetch the row's bytes.
 * @returns {Promise<{buffer:Buffer, contentType:string, fileName:string}>}
 */
const fetchDocument = (row) => sourceOf(row).fetch(row);

/** Ensure the row is in the CDN cache and return a short-lived CloudFront signed URL. */
const publishDocument = (row) => sourceOf(row).publish(row);

/** Human-readable reason for an upstream failure, whichever source raised it. */
const describeError = (err) => opentext.describeError(err);

module.exports = {
  fetchDocument,
  contentDisposition,
  publishDocument,
  label,
  describeError,
  // exported for unit tests
  archiveFileName,
  archiveCacheKey,
  SOURCES,
};
