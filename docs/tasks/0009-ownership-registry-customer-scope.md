# 0009 — Customer-scoped read/list + revocation + fetch audit (the `ownerId` dimension)

**Status:** todo
**Depends on:** [0008](0008-linkfor-delivery-link.md) (opaque `docId` + `Document` row +
`linkFor`); [0005](0005-bucket-model-folder-routing.md) (bucket registry). Shares its store and
revocation/audit with [0004](0004-revocable-tokens-audit.md).
**Architecture:** [ADR 0006](../adr/0006-delivery-link-authorization.md) — the customer
dimension. 0008 stood up the `Document` row and the app-caller path; this adds the customer
caller, the revocation action, and the fetch audit on that same row.

## Context

0008 scopes `linkFor` by **bucket** (the app caller) over the opaque `docId` row. It does not yet
serve the **customer**: a logged-in resident who may mint/list **only her own** documents
(`ownerId == her`), never the whole bucket. This slice adds the `ownerId` dimension, the
customer-scoped portal listing, and the revocation + audit surface — all on the one `Document` row
0008 created, and coordinated with 0004 so there is a single store.

Per ADR 0006: `bucket`/`ownerAzp` are **derived** from `azp`; `ownerId` is **declared by the app**
at ingest (only ever within its own bucket, so it cannot cross tenants).

## Acceptance criteria

- [ ] `uploadDocument` accepts an optional `ownerId : String`; it is recorded on the `Document`
      row. Uploads without it stay app-only (no customer can claim them).
- [ ] **Customer caller** (portal principal): `linkFor(docId)` succeeds only if `row.ownerId ==
      caller.customerId`, else **404**. A customer cannot mint/list across `ownerId`, even within
      the same bucket.
- [ ] **App caller** (service-to-service): `listFor(ownerId)` returns that customer's documents
      **within the caller's bucket only** (the on-behalf-of / notifications path).
- [ ] `portal.documents()` returns only the logged-in customer's rows (filter on `req.user`
      subject), replacing today's "one hardcoded folder for every user" — see the leak note below.
- [ ] A `revoke(docId)` action (owner app, or an admin surface) flips `revoked`; subsequent
      `linkFor(docId)` → 404. If delivery tokens are DB-backed (0004), outstanding links die too.
- [ ] Each delivery fetch is recorded (who/when/which `docId`) for audit (DoD-6), coordinated with
      task 0004.

## Checklist

### Schema — `db/schema.cds`
- [ ] Confirm `Document.ownerId` (added by 0008's schema) is indexed for the customer/list
      queries. Add the audit shape (a `DeliveryFetch` row or equivalent) with 0004, not a second
      store.

### Ingest — `srv/ingest-service.js` / `.cds`
- [ ] Add optional `ownerId : String`; write it onto the `Document` row.

### Caller-type resolution — `srv/lib/caller.js` (new)
- [ ] Classify a request as **app** (client-credentials `azp`, no end-user subject) vs
      **customer** (principal-propagation subject), so `linkFor`/list dispatch the right predicate.
      Document the IAS token shape each produces.

### Link + list — `srv/link-service.js`, `srv/portal-service.js`
- [ ] `linkFor`: customer caller → `row.ownerId == customerId` else 404; app caller keeps 0008's
      `mayRead(azp, row.bucket)`. Populate the delivery token `c` claim with `ownerId` (audit).
- [ ] `portal.documents()`: filter by the logged-in customer's id, not `FOLDER_ID`.
- [ ] `listFor(ownerId)` (service-to-service): rows where `ownerId == arg` AND
      `bucket == bucketOf(caller azp)`.

### Revocation + audit — coordinate with task 0004
- [ ] `revoke(docId)` flips `revoked` (authorize: owner app, or admin). `linkFor` already honors
      the flag (0008).
- [ ] Record delivery fetches for audit; if delivery moves to DB-backed tokens (0004), revocation
      reaches live links.

### Tests
- [ ] Customer A cannot `linkFor`/list customer B's doc → 404, same bucket included.
- [ ] App caller `listFor(ownerId)` stays within its bucket; cannot reach another bucket.
- [ ] Spoofed `ownerId` at ingest lands only under the caller's derived bucket.
- [ ] Portal listing returns only the logged-in customer's rows.
- [ ] `revoke(docId)` → later `linkFor` is 404.

## Definition of Done (commons `cross-cutting.md` §1)
- **DoD-2 (provenance derived):** `bucket`/`ownerAzp` from `azp`; `ownerId` is app-declared data,
  recorded only within the caller's own bucket.
- **DoD-6 (revocable + auditable):** the `Document` row is the seat of per-document revocation and
  fetch audit for personal documents; one store, shared with task 0004.

## Note — current-state leak this fixes
`portal.documents()` today lists **one hardcoded folder for every authenticated user** with no
per-customer filter (`portal-service.js`), so user A can already see and open user B's documents.
The customer-scoped listing here is the fix; it must land before the portal serves real customers.

## Out of scope
- Delegation/sharing of a document between customers; per-document ACLs beyond `(bucket, ownerId)`.
- The delivery-token storage mechanism itself → task 0004 (this task guarantees they share the
  `Document`/audit store, not how DB-backed delivery tokens are built).

## References
- [ADR 0006](../adr/0006-delivery-link-authorization.md); tasks
  [0008](0008-linkfor-delivery-link.md) (the row + app path it extends),
  [0004](0004-revocable-tokens-audit.md) (shared revocation/audit store),
  [0005](0005-bucket-model-folder-routing.md).
- onboard ADR 0003 (`azp` derived vs data declared); commons `document-service.md` T2/T4,
  `cross-cutting.md` §1 (DoD-2, DoD-6).
- `srv/lib/token.js` (the `c`/customer claim populated here), `srv/portal-service.js`
  (the listing this rescopes).
