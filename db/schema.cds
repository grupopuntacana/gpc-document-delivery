namespace gpc.documentdelivery;

/**
 * The delivery service's ownership/revocation registry (ADR 0006, task 0008).
 *
 * One row does three jobs: it resolves an opaque, unguessable `docId` to a private OpenText
 * `nodeId`, records who owns it, and carries the per-document revocation flag. Standing this
 * up is the deliberate cost of ADR 0006 — the opaque reference only means anything if there
 * is a row to resolve it against.
 *
 * The store is INTERNAL: it is never projected onto any service (DoD-5 — `linkFor` exposes no
 * queryable entity), so the `nodeId` cannot leak through OData. Callers only ever hold the
 * opaque `docId`; the `nodeId` never leaves the service.
 *
 * A row is SOURCE-TYPED (ADR 0009): `source = 'otcs'` rows locate the bytes by OpenText `nodeId`
 * inside a `bucket` (the BTP / @gpc/attachments-opentext paths); `source = 'archivelink'` rows
 * locate them by the S/4 ArchiveLink pair `(contRep, archDocId)`, claimed by S/4 through
 * `LinkService.linkForArchive`. The `docId`, ownership and revocation work the same for both.
 *
 * SQLite locally / in tests, HANA on BTP (`cds.requires.db`).
 */
entity Documents {
      // The opaque 128-bit claim-check the consumer stores in place of the nodeId.
  key docId     : String;
      // Where the bytes live: 'otcs' (nodeId + bucket) or 'archivelink' (contRep + archDocId).
      // Existing rows predate the column and are all OpenText nodes, hence the default.
      source    : String(16) not null  default 'otcs';
      // The private OpenText node id — NEVER in a request or response body. Int64 to match
      // the ingest contract (opaque id, never truncate). Set only on 'otcs' rows.
      nodeId    : Int64      null;
      // The bucket (namespace) the document lives in; the app-caller read scope (`mayRead`).
      // Set only on 'otcs' rows — an 'archivelink' row is scoped by its `contRep` instead.
      bucket    : String     null;
      // ArchiveLink locator (TOA01 ARCHIV_ID / ARC_DOC_ID) — set only on 'archivelink' rows.
      // `contRep` is also the read scope (`archives.mayRead`).
      contRep   : String(2)  null;
      archDocId : String(40) null;
      // ArchiveLink business link as S/4 declared it (TOA01 SAP_OBJECT / OBJECT_ID / AR_OBJECT).
      // Audit + a friendly download name only; never an authorization input.
      sapObject : String(10) null;
      objectId  : String(50) null;
      docType   : String(10) null;
      // The app azp that owns the row, derived from its IAS token at ingest/claim (DoD-2).
      ownerAzp  : String     not null;
      // Reserved for the customer dimension (task 0009, pending redesign per ADR 0008 — customer
      // scoping likely moves to the consuming app). Written by nothing in this slice; a row with
      // no ownerId is app-only. Left here so that redesign extends, not alters.
      ownerId   : String     null;
      // Per-document revocation seat (ADR 0006 §5). A revoked row mints no more links.
      revoked   : Boolean     not null  default false;
      createdAt : Timestamp   not null;
}
