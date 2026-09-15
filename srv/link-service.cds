/**
 * LinkService — re-mint a fresh, short-lived delivery link from a durable handle (ADR 0006,
 * task 0008; amended by ADR 0007). The read-side twin of IngestService.
 *
 * Two ways in, two audiences — deliberately separate actions, never one that takes "a docId
 * OR a nodeId":
 *
 *   linkFor(docId)        — the client-safe path. Resolves the opaque `docId` claim-check to
 *                           its `Documents` row, authorizes the caller against the row's
 *                           bucket, and mints a fresh /invoice/{token} link. A raw nodeId is
 *                           NEVER accepted or returned here.
 *
 *   linkForNode(bucket,   — the ADR 0007 §6 folder-guarded claim: a TRUSTED app-to-app caller
 *     nodeId)               may claim a node it uploaded directly through the @cap-js/attachments
 *                           plugin (which has no `Documents` row yet). Authorized by folder
 *                           membership == the caller's own bucket, then the row is lazily
 *                           upserted so the shared document becomes revocable/auditable.
 *
 * Both are `@requires: 'authenticated-user'` (service-to-service IAS auth). The anonymous leg
 * is the separate /invoice/{token} route (srv/server.js), unchanged. No entity is exposed
 * here — the store stays un-queryable (DoD-5).
 *
 * `ttlDays` is optional; when omitted the token defaults to LINKFOR_TOKEN_TTL_HOURS (a few
 * hours), NEVER the 30-day makeToken default — the delivery credential is short-lived.
 */
@path: 'link'
service LinkService {

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
    nodeId  : Int64,    // the directly-uploaded node; accepted ONLY over this trusted app-to-app
                        // channel and only when it sits in `bucket`'s folder (ADR 0007 §6)
    ttlDays : Integer
  ) returns {
    deliveryUrl : String;
    expiresAt   : Timestamp;
  };
}
