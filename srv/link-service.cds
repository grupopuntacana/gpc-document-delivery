/**
 * LinkService — turn a durable handle into a fresh, short-lived delivery link (ADR 0006,
 * task 0008; amended by ADR 0007, and by ADR 0008 which adds cross-app reads + `register`).
 * The read-side twin of IngestService.
 *
 * The write and read halves are DELIBERATELY separate actions, never one that takes "a docId
 * OR a nodeId". Authorization mirrors S3's split (ADR 0008): a bucket has `allowedWriters`
 * (ingest/claim = PutObject) and `allowedReaders` (mint links = GetObject); a writer implies
 * read, a reader does not imply write.
 *
 *   register(bucket,      — WRITE side. A trusted app-to-app WRITER claims a node it uploaded
 *     nodeId)               directly through the @cap-js/attachments plugin (which leaves no
 *                           `Documents` row). Folder-guarded (the node must sit in the bucket's
 *                           folder), then lazily upserts the ownership row and returns the
 *                           opaque `docId`. The writer stores that docId (e.g. in its own
 *                           invoice→customer table); a reader app later delivers it via linkFor.
 *
 *   linkFor(docId)        — READ side, client-safe. Resolves the opaque `docId` to its row,
 *                           authorizes the caller as a READER of the row's bucket (so a doc
 *                           uploaded by app X can be delivered by app Y), and mints a fresh
 *                           /invoice/{token} link. A raw nodeId is NEVER accepted or returned.
 *
 *   linkForNode(bucket,   — WRITE-side convenience = register + mint in one call, for the app
 *     nodeId)               that both uploads and delivers its own node. Same folder-guarded
 *                           writer authorization as `register`.
 *
 *   linkForArchive(       — S/4-NATIVE path (ADR 0009). S/4 holds the ArchiveLink (TOA01 ARCHIV_ID +
 *     contRep,              ARC_DOC_ID) of a document it archived and asks for a public link.
 *     archDocId, …)         Authorized by the caller's azp against the content repository's
 *                           `allowedReaders` (ARCHIVELINK_REPOSITORIES); lazily upserts a
 *                           source='archivelink' row and returns its `docId` plus a `/doc/{token}`
 *                           link. The ArchiveLink id is a locator, never the credential.
 *
 * `linkFor(docId)` serves both row sources: OpenText rows keep the v1 `/invoice/{token}` link
 * (byte-compatible with the Python / Integration Suite side); ArchiveLink rows get `/doc/{token}`.
 *
 * All `@requires: 'authenticated-user'` (service-to-service IAS auth). The anonymous leg is the
 * separate /invoice/{token} route (srv/server.js), unchanged. No entity is exposed here — the
 * store stays un-queryable (DoD-5).
 *
 * `ttlDays` is optional; when omitted the token defaults to LINKFOR_TOKEN_TTL_HOURS, NEVER the
 * 30-day makeToken default — the delivery credential is short-lived.
 */
@path: 'link'
service LinkService {

  @requires: 'authenticated-user'
  action register(
    bucket  : String,   // the caller's own bucket — names the OTCS folder the node must live in
    nodeId  : Int64     // the directly-uploaded node; claimed ONLY by a WRITER of the bucket and
                        // only when it sits in `bucket`'s folder (ADR 0007 §6 / ADR 0008)
  ) returns {
    docId : String;     // the opaque claim-check to store in place of the nodeId
  };

  @requires: 'authenticated-user'
  action linkFor(
    docId   : String,
    ttlDays : Integer
  ) returns {
    deliveryUrl : String;
    expiresAt   : Timestamp;
  };

  @requires: 'authenticated-user'
  action linkForNode(
    bucket  : String,   // the caller's own bucket — names the OTCS folder the node must live in
    nodeId  : Int64,    // the directly-uploaded node; claimed ONLY by a WRITER of the bucket and
                        // only when it sits in `bucket`'s folder (ADR 0007 §6 / ADR 0008)
    ttlDays : Integer
  ) returns {
    deliveryUrl : String;
    expiresAt   : Timestamp;
  };

  @requires: 'authenticated-user'
  action linkForArchive(
    contRep   : String(2),   // TOA01 ARCHIV_ID — the content repository, e.g. 'C1'; the read scope
    archDocId : String(40),  // TOA01 ARC_DOC_ID — the archived document (one per reprint)
    sapObject : String(10),  // optional, audit only: TOA01 SAP_OBJECT, e.g. 'PRINTDOC'
    objectId  : String(50),  // optional, audit + download name: TOA01 OBJECT_ID
    docType   : String(10),  // optional, audit + download name: TOA01 AR_OBJECT, e.g. 'ISU_BILL'
    ttlDays   : Integer
  ) returns {
    docId       : String;    // opaque claim-check; re-mint later with linkFor(docId)
    deliveryUrl : String;    // /doc/{token}, short-lived
    expiresAt   : Timestamp;
  };
}
