# ADR 0008 — Bucket-scoped reader/writer grants for cross-app document delivery

- **Status:** Proposed
- **Date:** 2026-09-16
- **Deciders:** Felix De Gracia; to be ratified by the SAP architecture review.
- **Lineage:** Extends ADR 0006 (opaque `docId` claim-check) and amends ADR 0007
  (plugin-ingest / app-private node reference). Continues the delivery-authorization track.
- **Amends:** ADR 0007 — the folder-guarded claim survives, but is no longer *owner-only*;
  read authority is now a per-bucket reader ACL, and the claim is exposed as its own
  `register` action, not only as a side effect of `linkForNode`.

## Context

A document uploaded by one app frequently must be read by a **different** app. The concrete
case that forced this:

> An **invoice-generator** app renders a PDF and ingests it (via the `@gpc/attachments-opentext`
> plugin, which writes straight to OpenText). It records, in **its own** table, that OpenText
> node → customer 2230. Later a **notifier** app reads that table, needs the invoice bytes to
> email the customer their billing, and asks document-delivery for a link. **The notifier did
> not upload the document and is not its owner.**

The authorization model up to ADR 0007 was *owner-only*: `mayRead === mayWrite`, both keyed on
a single per-bucket `allowedWriters` list, and `linkFor` effectively required the caller to be
the bucket's writer. Under that model the notifier is denied — which is wrong for the product.

Two more facts shape the decision:

1. **The plugin writes directly to OpenText**, so document-delivery never sees the upload and
   has no `Documents` row for it. ADR 0007 introduced `linkForNode(bucket, nodeId)` — a
   folder-guarded claim that lazily creates the row — but folded the claim into link-minting,
   so there was no way to *claim without delivering*, and no clean handle for the uploader to
   store and hand to another app.

2. **This is a solved problem in object storage.** S3 separates `s3:PutObject` from
   `s3:GetObject` and grants each to principals on a bucket/prefix; a pre-signed URL then
   delegates a single read. We were already bucket-shaped; we had just collapsed read into
   write.

## Decision

Model bucket access as **two per-app ACLs, exactly like S3**, and split the write-side claim
from the read-side link mint.

1. **Two ACLs per bucket** in `OPENTEXT_BUCKETS`:
   - `allowedWriters` — azps that may **ingest/claim** into the bucket (S3 `PutObject`).
   - `allowedReaders` — azps that may **read back and mint delivery links** (S3 `GetObject`).
   - **A writer implies read; a reader does not imply write.** So `mayWrite(azp)` =
     `allowedWriters`, and `mayRead(azp)` = `allowedReaders ∪ allowedWriters`. No wildcard,
     no open-by-default: a bucket with no writers accepts none, with no readers grants read
     only to its writers.

2. **Ownership stays recorded, but does not gate reads.** The `Documents` row's `ownerAzp` is
   the azp that ingested/claimed the node — kept for **audit and revocation**. The read gate is
   **bucket membership** (`mayRead`), not `ownerAzp === callerAzp`. This is what lets app Y
   deliver a document app X uploaded.

3. **`register(bucket, nodeId) → { docId }`** — the write-side claim on its own. A **writer**
   that uploaded a node directly (via the plugin) claims it (folder-guarded, per ADR 0007 §6)
   and gets back the opaque `docId` to store in its own domain table. It mints **no** link.
   `linkForNode` remains as the *register + mint* convenience for an app that both uploads and
   delivers its own node. Both are writer-authorized (`mayWrite`); claiming is a write act.

4. **`linkFor(docId)`** stays the client-safe read path, now authorized by `mayRead` — so a
   reader app delivers a doc it never uploaded. A raw `nodeId` is still never accepted or
   returned; unknown / not-a-reader / revoked all collapse to 404 (no oracle).

5. **The plugin stays a dumb object store.** `@gpc/attachments-opentext` mirrors the
   `@cap-js/attachments` S3 backend: `put`/`get`/`delete`, **no authorization logic**. The
   bucket policy + pre-signed URLs live in document-delivery; the app→customer relation table
   lives in the *consuming* app. document-delivery never learns what a document *means*.

## The flow (uploaded by X, delivered by Y)

```
Invoice app (writer of "billing")            Notifier app (reader of "billing")
  1. plugin.put() → OpenText node 8899          4. reads ITS OWN table: docId → customer 2230
  2. register("billing", 8899) → docId d-abc    5. linkFor(d-abc)              [notifier azp]
     (ownerAzp = invoice app)                    6. document-delivery: mayRead(notifier,"billing")?
  3. writes ITS OWN table: {docId d-abc,            yes (reader) → mints /invoice/{token}
     customer 2230}                              7. emails customer 2230 the link
```

- The notifier authorizes as a **reader**, not owner; `ownerAzp` (the invoice app) is audit-only.
- The **relation table (invoice→customer) belongs to the consuming app**, not document-delivery,
  which only knows `{docId, nodeId, bucket, ownerAzp}`.
- The table stores the **`docId`**, never the raw `nodeId` — the "never expose nodeId" invariant
  (DoD-5) holds across apps.
- **Customer-scoping is the consuming app's business logic.** document-delivery answers "may this
  *app* read this bucket," not "is this the right invoice for this customer." A *customer* reading
  their own invoice directly is a different surface (user self-service / ownership), not this one.

## Consequences

- **Cross-app delivery works** without weakening isolation: access is still explicit, per-bucket,
  per-azp, and failure-closed.
- **A new reader is one ACL entry** (`allowedReaders`), not code. A new writer likewise.
- **Config belongs in the deployable descriptor** (`secrets.mtaext` / `mta.yaml`), **not**
  `cf set-env` — an imperative env var is reverted to the descriptor's value on every redeploy.
- **`ownerAzp` and read authority are now distinct concepts.** Revocation is still per-document
  (`revoked`); a bucket's reader list controls who *can* mint, the row controls whether a specific
  document *still* mints.
- **Backward compatible.** Existing owner-only buckets (writers only, no readers) behave exactly as
  before — the writer is the only reader. `linkForNode` is unchanged for same-app callers.

## Alternatives considered

- **Keep owner-only, hand the notifier a pre-signed URL from the uploader.** Works only if the
  uploader mints at exactly the moment the notifier needs it; a notifier on its own schedule must
  re-mint, so it needs read authority anyway. Rejected — it pushes lifecycle coupling onto the apps.
- **Model access with AMS policies instead of a bucket ACL.** AMS fits *user* authorization (the
  console). Record/bucket access between *applications* is better as data (the ACL + the `ownerAzp`
  row) — one source of truth, no policy round-trip. AMS stays for the human surfaces.
- **Per-document grant rows (an explicit share table).** More granular than a bucket ACL, but the
  product need is app-level ("the notifier may deliver billing docs"), not per-document. Deferred;
  the `Documents` row is the seam if per-document sharing is ever required.
