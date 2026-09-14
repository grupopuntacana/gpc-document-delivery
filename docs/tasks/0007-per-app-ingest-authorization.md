# 0007 — Per-app ingest authorization: azp → allowed bucket (the "no overlap")

**Status:** done
**Depends on:** [0005](0005-bucket-model-folder-routing.md); the family **Auth kernel**
(`azp → sourceSystem` resolution, commons `cross-cutting.md` §2.1) — see open decision below.
**Architecture:** commons epic `document-service.md` T2; the "ingest authorization model"
[ADR 0005](../adr/0005-shared-delivery-ingest-service.md) flagged as not-yet-designed. This is
the isolation that makes the store multi-tenant — one app cannot write another's bucket.

## Context

After 0005, `uploadDocument` is authenticated (`@requires: 'authenticated-user'`) but any
authenticated caller may name any configured bucket. The whole point of bucket-per-app is
**isolation**: app A must not be able to write app B's namespace. This slice derives the caller's
identity from its IAS token and checks it against the bucket registry's **allowed writers**.

Per commons DoD-2, the caller identity is **derived, never declared** — read the OAuth
authorized-party from `req.user.authInfo.token.azp` (the standard claim; do **not** invent a
`app`/`source` body field, and do **not** use `req.user.attr.azp`, which the IAS strategy strips
and which yields a constant on the client-credentials path — the onboard convention). The registry
gains a writer ACL per bucket; a caller whose `azp` is not an allowed writer of the named bucket
is rejected `403`.

## Acceptance criteria

- [x] App A's token (one `azp`) **cannot** write a bucket owned by app B → `403`; app A writing
      its own bucket succeeds.
- [x] The authorization check is on the **derived** `azp`, not on any request-body field —
      a body carrying another app's name changes nothing (test sets `azp` on the mock user and
      asserts the body is ignored).
- [x] A caller whose `azp` maps to **no** bucket is `403`; an unauthenticated caller stays `401`
      (unchanged from `@requires`).
- [x] The `403` fires before any OpenText call (no folder is touched on a denied write).

## Checklist

### Registry — `srv/lib/buckets.js`
- [x] Add `allowedWriters: [azp, …]` (or an `azp → bucket(s)` map) per bucket.
- [x] `mayWrite(azp, bucket)` predicate; export it. Keep it pure config — no AMS call here unless
      the open decision below closes on AMS.

### Ingest handler — `srv/ingest-service.js`
- [x] Read `req.user.authInfo.token.azp`; reject `403` if empty (defensive — provenance must be
      present at the boundary, DoD-2).
- [x] Reject `403` if `!mayWrite(azp, req.data.bucket)`, before folder resolution/upload.

### Tests — `test/ingest.test.js`
- [x] Drive two callers with different `azp` (cds mock-auth user attrs / token stub); assert the
      cross-bucket write is `403` and the owned-bucket write succeeds.
- [x] Assert a spoofed body field does not grant access.

## Definition of Done (commons `cross-cutting.md` §1)
- **DoD-2 (provenance derived):** bucket-write authority comes from `azp`, asserted non-empty at
  the boundary, never from the body.
- **DoD-5 (two audiences):** ingest stays service-to-service IAS-authenticated; nothing here
  makes any entity queryable — the write action is the only surface.

## How it landed

- `srv/lib/buckets.js` — `allowedWriters` per entry (validated into a `Set`; absent or `[]`
  means **no** writer, never open) plus a synchronous, total `mayWrite(azp, bucket)`.
- `srv/ingest-service.js` — `callerAzp` (only `req.user.authInfo.token.azp`, no fallbacks) and
  a pure `authorizeWrite(user, bucket)`, checked **before** `resolveBucket` so a denied write
  cannot provision a folder. The caller's `azp` now rides on every ingest log line.
- **An unknown bucket answers `403`, not `400`.** Differing statuses would let an unauthorized
  caller enumerate other apps' namespaces one probe at a time — the same enumeration the
  `unknownBucket` message already avoids, leaked through the status code. `bucket` missing from
  the body stays `400` (malformed request, and no name to confirm).
- The caller's `azp` rides on every ingest log line, including the denial — which is how an
  operator learns the value to put in `allowedWriters`, since a bucket's ACL lists client ids
  that are not in `mta.yaml` and cannot be derived from it. No diagnostic endpoint is exposed
  for this: a caller can decode its own token, and the logs cover the operator's side.
- Tests: the 13 HTTP upload tests were converted to `srv.send` under a constructed
  `cds.context.user`, because mocked auth cannot produce an `azp` at all (CAP builds `authInfo`
  only in the `ias`/`jwt` strategies). No seam was added to production code. `401`/`403` stay
  asserted over HTTP.

**Deploy note:** the portal SPA is itself an ingest caller and `srv-api` sets
`forwardAuthToken: true`, so its `azp` is the frontend OIDC client's — not the `srv` module's.
The SPA's upload returns `403` until that value is read from a live browser request and put in
`invoices.allowedWriters`, which makes this a two-step deploy.

## Open decision this slice depends on (flag, don't assume)
`azp → app` resolution mechanism is **unresolved** at the family level (commons
`cross-cutting.md` §2.1, open-decisions register): a **checked-in registry** vs an **AMS
attribute**. *Commons recommendation: a checked-in registry near-term.* This slice assumes the
checked-in form (the writer ACL lives in `buckets.js`); if the family closes on AMS, the ACL
source moves but the handler check and DoD stay. **Do not build an AMS/DCL plugin here** — that is
the Auth kernel's job, coordinated with onboard.

## Out of scope
- Auto-provisioning writers, a self-service bucket-admin UI, per-document ACLs — none required to
  isolate app writes.
- Delivery-side authorization / revocable tokens → repo task 0004, commons epic T4.

## References
- onboard azp convention: `CLAUDE.md` "Provenance is derived", ADR 0003.
- commons `cross-cutting.md` §1 (DoD-2), §2.1 (Auth kernel), §6 (open-decisions register).
- [ADR 0005](../adr/0005-shared-delivery-ingest-service.md) "Ingest needs an authorization model".
