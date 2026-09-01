# 0005 — Bucket model + folder routing (the proving vertical)

**Status:** done
**Depends on:** [0003](0003-ingest-api-shared-upload.md) (done — the upload primitive exists).
**Architecture:** first slice of the **bucket-per-app** layer on the ingest capability group
([ADR 0005](../adr/0005-shared-delivery-ingest-service.md); commons epic `document-service.md`
T1). This is the end-to-end vertical that proves the design: *one configured bucket → an upload
lands in its own OpenText folder.*

## Context

`IngestService.uploadDocument` today hardcodes a single target folder
(`OPENTEXT_INGEST_FOLDER_ID || OPENTEXT_FOLDER_ID || 2000`, `srv/ingest-service.js:14`). Every
caller writes the same folder — there is no per-app namespace. To become an S3-like store,
ingest must take a **`bucket`** and route the document to that bucket's OpenText folder.

This slice adds the bucket **registry** (config only — `bucket → { OpenText parent folder
node }`) and the folder routing. It deliberately uses **pre-provisioned** folder node ids so it
can ship without any new OpenText write op (auto-create is the next slice, 0006). It does **not**
add authorization — that is 0007; here every authenticated caller may name any configured bucket.

The upload plumbing is reused unchanged: `opentext.uploadDocument`, `uniqueName` dedup,
`sanitizeFileName`, `listFolderChildNames`, base64 body, token mint. This slice only chooses
*where* the document lands.

## Acceptance criteria

- [x] `uploadDocument` accepts a `bucket` field; two configured buckets (e.g. `invoices` →
      folder node X, `statements` → folder node Y) land their uploads under **different**
      OpenText parent folders — assert on the `parent_id` in the create-node POST body captured
      by the test transport (see `test/ingest.test.js` `mockTransport().creates`).
- [x] An **unknown / unconfigured** bucket is rejected `400` before any OpenText call.
- [x] A **missing** `bucket` is rejected `400` (no silent fallback to the legacy folder — the
      registry is the only source of truth for where a document lands).
- [x] The returned shape is unchanged (`{ nodeId, name, token }`); dedup still works per bucket.

## Checklist

### Bucket registry — `srv/lib/buckets.js` (new)
- [x] A checked-in config source: `bucket → { folderNode }`. Read from env/JSON (e.g.
      `OPENTEXT_BUCKETS`) or a small module map; keep it a plain data table, no OpenText calls.
- [x] `resolveBucket(name)` → `{ folderNode }` or throws a "unknown bucket" error the handler
      maps to `400`. Writer ACL is added in 0007 — leave a documented seam, don't build it here.

### Ingest handler — `srv/ingest-service.{cds,js}`
- [x] Add `bucket : String` to the `uploadDocument` action signature (`ingest-service.cds`).
- [x] Resolve the bucket → folder node, reject unknown/missing with `400`; pass the resolved
      node to `opentext.uploadDocument` / `uniqueName` in place of the module-level `FOLDER_ID`.
- [x] Keep the existing size/empty/base64 guards and the `502` OpenText-failure translation.

### Tests — `test/ingest.test.js` (extend)
- [x] Configure two buckets; assert each lands under its own `parent_id`.
- [x] Assert unknown and missing `bucket` → `400`.

## Definition of Done (commons `cross-cutting.md` §1)
- **DoD-1 (link, don't copy):** the service stores only the returned `nodeId`; OpenText stays
  the system of record. No document bytes or master-data fields held locally.
- **DoD-4 (ports/no context leakage):** the registry knows `bucket → folderNode` only — never
  "onboard" or "service request". Bucket names are opaque namespaces, not context concepts.

## Out of scope (named, not dropped)
- **Auto-creating the folder** if it doesn't exist → 0006 (this slice uses pre-provisioned nodes).
- **Which caller may write which bucket** (the "no overlap") → 0007.
- **Per-bucket S3 cache prefix / non-PDF cache keys** → commons epic T3 (delivery read path,
  repo `cloudfront.js`/`cdn.js`) — not part of the upload path.
- **TOCTOU dedup hardening** — inherited from 0003, still deferred with the multi-tenant model.

## Implementation notes

- **Two error codes, not one.** The checklist said "reject unknown/missing with 400", but the
  registry distinguishes `UNKNOWN_BUCKET` (caller named a bucket we don't have → **400**) from
  `BUCKET_CONFIG_INVALID` (malformed `OPENTEXT_BUCKETS` → **500**, logged). Returning 400 for a
  broken deploy config would send the caller debugging a request that was fine.
- **The 400 does not list the configured buckets.** It reaches an authenticated caller, and
  enumerating other apps' namespaces would undercut the isolation 0007 adds.
- **Config lives in env (`OPENTEXT_BUCKETS`), not a checked-in map** — each BTP space points its
  buckets at its own pre-provisioned nodes without a redeploy, matching the other `OPENTEXT_*`
  tunables. Entries are validated eagerly so a typo in an unused bucket surfaces on first upload.
- **`OPENTEXT_INGEST_FOLDER_ID` is gone** — the registry replaces it; nothing reads it now.
- **The portal SPA had to change too** (not in the original checklist): `cap.js` sent no
  `bucket`, so drag-and-drop would have started returning 400. It now sends `invoices`
  (`VITE_INGEST_BUCKET` overrides). That bucket's `folderNode` must equal `OPENTEXT_FOLDER_ID`,
  which `PortalService` still lists from — otherwise an upload succeeds but never shows up in
  the listing. Documented in `README.md` and `.env.example`.

## References
- `srv/ingest-service.js` (current hardcoded `FOLDER_ID`), `srv/lib/opentext.js`
  (`uploadDocument`, `listFolderChildNames`, `sanitizeFileName`).
- [ADR 0005](../adr/0005-shared-delivery-ingest-service.md) "Doc-type → folder/prefix mapping".
- commons `docs/tasks/document-service.md` T1.
