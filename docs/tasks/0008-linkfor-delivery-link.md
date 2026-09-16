# 0008 — Opaque document reference + `linkFor` (claim-check, DB-backed)

> **Status: DONE, and AMENDED by [ADR 0008](../adr/0008-bucket-scoped-cross-app-reads.md)
> (shipped v1.1.0).** This task's owner-only model — `mayRead` *"initially `= mayWrite`,
> owner-only"* and the *"a row the caller's bucket owns"* / *"different-bucket app → 404"*
> acceptance criteria below — is **superseded**. As shipped: a bucket has separate
> `allowedWriters` / `allowedReaders`, `mayRead = readers ∪ writers`, the read gate is bucket
> membership (not `ownerAzp`), and the write-side claim is a standalone `register(bucket, nodeId)`
> action. Read this for the `docId`/claim-check lineage; read ADR 0008 for the current behavior.

**Status:** done (superseded in part by ADR 0008)
**Depends on:** [0005](0005-bucket-model-folder-routing.md) (bucket registry, `azp → bucket`);
the family Auth kernel (`azp` resolution, see task 0007's open decision). Introduces the
persistence [0009](0009-ownership-registry-customer-scope.md) and
[0004](0004-revocable-tokens-audit.md) build on.
**Architecture:** [ADR 0006](../adr/0006-delivery-link-authorization.md) — the app/capability
core. Read-side twin of task [0007](0007-per-app-ingest-authorization.md): `0007` gates writes
with `mayWrite(azp, bucket)`, this gates link-minting with `mayRead(azp, bucket)`.

## Context

`nodeId`s are **sequential integers**, so any API that hands one out or accepts one back is
walkable and IDOR-prone (ADR 0006 §Context). This slice removes the primitive: the service issues
an **opaque, unguessable `docId`** at ingest and never exposes or accepts a `nodeId`. The consumer
stores `docId` and later presents it to `linkFor(docId)` ("this is the file I uploaded"), which
resolves a persisted `Document` row, authorizes the caller, and mints a **fresh short-lived**
delivery token. `docId` (durable, authenticated) and the delivery token (short, anonymous) are
different tokens with different jobs.

This slice covers the **app (service-to-service) caller** and stands up the `Document` row that
customer scoping (0009) and revocation/audit (0004) reuse. The anonymous `/invoice/:token` route
is untouched.

## Acceptance criteria

- [ ] `uploadDocument` returns an **opaque `docId`** (128-bit random, unguessable), not the
      `nodeId`. The `nodeId` appears in no response body and no request body anywhere.
- [ ] A `Document` row `{ docId, nodeId, bucket, ownerAzp, ownerId?, revoked, createdAt }` is
      written on every ingest; `bucket`/`ownerAzp` derived from the caller's `azp`.
- [ ] `linkFor(docId)` for a row the caller's bucket owns returns a fresh `/invoice/{token}` URL
      with a **short, explicit** TTL (hours, never the 30-day `makeToken` default).
- [ ] `linkFor(docId)` for an unknown or non-owned `docId`, or a `revoked` row, returns **404**
      (do not distinguish "not found" from "not yours"), and mints nothing.
- [ ] The bucket decision is on the **derived** `azp` (`req.user.authInfo.token.azp`), asserted
      non-empty; a spoofed body field changes nothing. Unauthenticated stays `401`.
- [ ] The minted token verifies and delivers through the existing `/invoice/:token` route with
      **no change** to `srv/server.js`.

## Checklist

### Schema — `db/schema.cds` (new; the service is stateless today)
- [ ] Stand up persistence (HANA on BTP / SQLite locally) and a `Document` entity keyed on the
      opaque `docId`, columns `{ nodeId, bucket, ownerAzp, ownerId, revoked, createdAt }`. This is
      the shared store 0009 and 0004 extend — design it once, with them in mind.

### Reference minting — `srv/lib/docref.js` (new)
- [ ] `newDocId()` → 128-bit URL-safe random. Opaque, no structure. (Optional later: an HMAC
      envelope as a pre-DB filter; not needed now — the DB row is the integrity check.)

### Ingest — `srv/ingest-service.js` / `.cds`
- [ ] After the OpenText write, `newDocId()` + `INSERT` the `Document` row; derive
      `bucket`/`ownerAzp` from `req.user.authInfo.token.azp` (403 if empty, DoD-2).
- [ ] Change the return to `{ docId, name }` (drop `nodeId` from the contract; keep the
      short-lived `token` only if a caller still wants an immediate link).

### Service — `srv/link-service.cds` (or fold into `ingest-service.cds`)
- [ ] `action linkFor(docId : String, ttlDays : Integer) returns { deliveryUrl : String; expiresAt : Timestamp; }`,
      `@requires: 'authenticated-user'`.

### Registry — `srv/lib/buckets.js`
- [ ] Add `mayRead(azp, bucket)` (initially `= mayWrite`, owner-only) and export it.

### Handler — `srv/link-service.js`
- [ ] Read `req.user.authInfo.token.azp` (403 if empty). `SELECT` the `Document` row by `docId`.
- [ ] `404` if no row, if `revoked`, or if `!mayRead(azp, row.bucket)` — before minting.
- [ ] On pass, `token.makeToken(row.nodeId, { ttlDays: <short> })`; build the `/invoice/{token}`
      URL; return `{ deliveryUrl, expiresAt }`. The `nodeId` never leaves the handler.

### TTL
- [ ] `LINKFOR_TOKEN_TTL_HOURS` (default a few hours), passed explicitly; never inherit the
      30-day `makeToken` default (`token.js:55`).

### Tests — `test/link.test.js`
- [ ] Ingest returns an opaque `docId`, not the `nodeId`; the response contains no `nodeId`.
- [ ] Owner app: `linkFor(docId)` → 200 and a redeemable token. Different-bucket app → 404.
- [ ] Unknown/tampered `docId` → 404 with no mint; a spoofed body field grants nothing.
- [ ] A `revoked` row → 404. Minted TTL is the short `linkFor` TTL, not 30 days.

## Definition of Done (commons `cross-cutting.md` §1)
- **DoD-1 (link, don't copy):** consumers keep only `docId`; the service keeps the `nodeId`, never
  the reverse.
- **DoD-2 (provenance derived):** bucket-read authority comes from `azp`, non-empty at the
  boundary, never the body.
- **DoD-5 (two audiences):** `linkFor` is service-to-service IAS-authenticated and exposes no
  queryable entity; delivery stays separately anonymous.

## Out of scope
- Customer (`ownerId`) scoping, the customer-scoped portal listing, and the ingest `ownerId`
  argument → task 0009.
- The revocation *action* and fetch audit → tasks 0009 / 0004 (this slice only adds the `revoked`
  column and honors it).

## References
- [ADR 0006](../adr/0006-delivery-link-authorization.md); [ADR 0001](../adr/0001-document-sharing-pattern.md)
  (DB-backed token direction).
- Tasks [0005](0005-bucket-model-folder-routing.md), [0007](0007-per-app-ingest-authorization.md)
  (`mayWrite` twin), [0009](0009-ownership-registry-customer-scope.md),
  [0004](0004-revocable-tokens-audit.md) (share this store).
- onboard ADR 0003 (`azp` provenance); commons `document-service.md` T2,
  `cross-cutting.md` §2.8.
- `srv/lib/token.js` (short-lived delivery token), `srv/server.js` (deliver route, unchanged).
