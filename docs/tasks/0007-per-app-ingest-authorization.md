# 0007 — Per-app ingest authorization: azp → allowed bucket (the "no overlap")

**Status:** todo
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

- [ ] App A's token (one `azp`) **cannot** write a bucket owned by app B → `403`; app A writing
      its own bucket succeeds.
- [ ] The authorization check is on the **derived** `azp`, not on any request-body field —
      a body carrying another app's name changes nothing (test sets `azp` on the mock user and
      asserts the body is ignored).
- [ ] A caller whose `azp` maps to **no** bucket is `403`; an unauthenticated caller stays `401`
      (unchanged from `@requires`).
- [ ] The `403` fires before any OpenText call (no folder is touched on a denied write).

## Checklist

### Registry — `srv/lib/buckets.js`
- [ ] Add `allowedWriters: [azp, …]` (or an `azp → bucket(s)` map) per bucket.
- [ ] `mayWrite(azp, bucket)` predicate; export it. Keep it pure config — no AMS call here unless
      the open decision below closes on AMS.

### Ingest handler — `srv/ingest-service.js`
- [ ] Read `req.user.authInfo.token.azp`; reject `403` if empty (defensive — provenance must be
      present at the boundary, DoD-2).
- [ ] Reject `403` if `!mayWrite(azp, req.data.bucket)`, before folder resolution/upload.

### Tests — `test/ingest.test.js`
- [ ] Drive two callers with different `azp` (cds mock-auth user attrs / token stub); assert the
      cross-bucket write is `403` and the owned-bucket write succeeds.
- [ ] Assert a spoofed body field does not grant access.

## Definition of Done (commons `cross-cutting.md` §1)
- **DoD-2 (provenance derived):** bucket-write authority comes from `azp`, asserted non-empty at
  the boundary, never from the body.
- **DoD-5 (two audiences):** ingest stays service-to-service IAS-authenticated; nothing here
  makes any entity queryable — the write action is the only surface.

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
