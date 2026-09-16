# ADR 0006 — Delivery-link authorization: opaque document reference + two-tier ownership

- **Status:** Proposed — **amended by [ADR 0007](0007-plugin-ingest-app-private-noderef.md)**
  (which adds the `@cap-js/attachments` plugin ingest path and relaxes the "never accept a
  `nodeId`" rule to "never from a client/untrusted caller").
- **Date:** 2026-09-01
- **Deciders:** Felix De Gracia; to be ratified by the SAP architecture review.
- **Lineage:** Extends [ADR 0005](0005-shared-delivery-ingest-service.md), which built the
  Deliver (anonymous) and Ingest (service-to-service) capability groups but left the
  minting-authority question open. Realizes the **DB-backed token** direction
  [ADR 0001](0001-document-sharing-pattern.md) already preferred for invoices
  ("per-document revocation is a real business need"). Inherits the provenance rule of onboard
  [ADR 0003](../../../onboard/docs/adr/0003-inbound-s2s-auth.md) ("provenance is derived,
  never declared").

## Context

A consumer is told to keep only a durable handle and never the blob (commons DoD-1), and to
re-mint a delivery link on demand rather than persist one that expires. The naive shape,
`linkFor(nodeId)`, has a **critical flaw**: OpenText `nodeId`s are **sequential integers**, so a
call that accepts a caller-named id is a universal read oracle over the whole store. Any
authenticated consumer could walk the id space and mint a valid, anonymously-redeemable link to
any document, across apps and across customers (IDOR, ~CVSS 9.x).

Guarding a walkable id after the fact (check the caller's bucket against the node's OpenText
parent) contains the hole but does not remove it: the service still accepts a raw `nodeId` and
still has to prove ownership on every call. The root cause is **exposing the `nodeId` at all**.

Two callers also need deliberately different reach:

- **The app (service-to-service, identified by `azp`)** ingests many customers' documents into
  its bucket. For notifications and backend flows it must act for **any** of its customers, so
  its scope is **the bucket**.
- **The customer (portal principal, identified by her subject/customerId)** may touch **only her
  own** documents, so her scope is **the row** (`ownerId == her`).

## Decision

**1. The service never hands out or accepts a `nodeId`. It issues an opaque document reference
(`docId`) — a claim-check.**

At ingest the service:
- writes the bytes to OpenText (as today), then
- generates an **opaque, unguessable `docId`** (128 bits of randomness), and
- persists a `Document` row `{ docId, nodeId, bucket, ownerAzp, ownerId, revoked, createdAt }`,
- returns **`docId`** (not the `nodeId`) to the consumer.

The consumer stores `docId` in place of the `nodeId`. `nodeId` stays **inside** the service; it
is never in a response body, never in a request body, never walkable.

**2. The `Document` row is one record doing three jobs: reference resolution, ownership, and
revocation.** This is the DB-backed token ADR 0001 prefers and task 0004 needs; there is one
store, not several. Because lookup is a DB read of a random key, the row itself is the integrity
check: a `docId` not in the table is simply rejected. No HMAC is required on `docId` (an optional
HMAC envelope can pre-filter before the DB hit later, but the row stays the source of truth).

**3. `linkFor(docId)` resolves the row, authorizes, then mints a fresh short-lived delivery
token.** `docId` and the delivery token are **different tokens with different jobs:**

| | `docId` (durable claim-check) | delivery token (`/invoice/:token`) |
|---|---|---|
| Held by | the consuming app, long-term | whoever opens the file, briefly |
| Redeemed at | authenticated `linkFor(docId)` | anonymous `/invoice/:token` |
| Lifetime | durable, revocable (DB row) | short (hours) |
| On leak | refused unless caller owns it; revocable | bounded by the short TTL |

The durable handle is never directly redeemable for bytes; the byte-credential is always freshly
minted and short-lived.

**4. Authorization is capability AND identity (defense in depth), enforced at mint/list, never at
delivery.** Possession of an unguessable `docId` already means "I uploaded this" (the capability),
but a leaked `docId` is still refused unless the caller matches the row:

- **App caller** (client-credentials, an `azp`, no end-user subject): allow if
  `ownerAzp`'s bucket == the caller's bucket (`mayRead(azp, bucket)`). May act for any `ownerId`
  in its bucket.
- **Customer caller** (principal-propagation portal user): allow if `row.ownerId ==
  caller.customerId`.

`bucket`/`ownerAzp` are **derived** from the caller's IAS token (`req.user.authInfo.token.azp`,
ADR 0003 / DoD-2). `ownerId` is **declared by the app** at ingest — legitimately, because an app
can only ever name a customer *within its own bucket*, so a spoofed `ownerId` cannot escalate
across tenants. Denials return **404** (do not confirm a `docId` the caller may not see). The
anonymous `/invoice/:token` route does not change (`srv/server.js`); by the time a delivery token
exists the scope check has already happened.

**5. Revocation lives on the row.** Flip `revoked` and `linkFor` stops minting for that `docId`.
Outstanding short-lived delivery tokens age out on their own; making them DB-backed too (task
0004) lets revocation reach them immediately.

### Why this shape (vs alternatives)

| Option | Trade-off | Verdict |
|---|---|---|
| **Opaque `docId` claim-check + `Document` row (reference + owner + revoke)** | one DB row does resolution, ownership, and revocation; `nodeId` never exposed, so the walkable-id IDOR cannot exist; needs a DB from day one | **Chosen** |
| `linkFor(nodeId)` guarded by an OpenText-parent bucket check, no DB | avoids a DB, but still accepts a walkable id, adds a round trip per call, and gives neither revocation nor customer scope | Rejected (was the earlier draft; superseded) |
| Bind owner into the delivery token, re-check at delivery | `linkFor` starts from a handle with nothing to read a node from; tokens are already unforgeable, so this guards a non-threat and burdens the hot anonymous path | Rejected |
| Per-app OpenText folder ACLs at delivery | delivery streams through one shared OTDS account that can read every folder, so folder ACLs never gate it | Rejected |

## Consequences

**Positive**
- The walkable-id IDOR is designed out, not guarded: there is no `nodeId` to enumerate or tamper.
- One `Document` row is the reference, the ownership record, and the revocation seat, so
  ownership, capability, revocation, and audit share a single store.
- Realizes ADR 0001's preferred DB-backed token and seats task 0004 / commons T4 at the same
  time; the work is not throwaway.
- `docId` possession is the simple, intuitive "this is the file I uploaded" model, hardened by an
  identity check so a leaked handle is still safe.
- Consumers replace a fragile persisted delivery URL with a durable `docId` minted-on-demand,
  removing the expired-link bug they have today.

**Negative**
- **Requires persistence from day one** — the service is stateless now. This is the deliberate
  cost: the opaque reference only means anything if there is a row to resolve it against. Given
  revocation is a hard requirement anyway (DoD-6), the DB is paid for now rather than deferred.
- Ingest's response contract changes (returns `docId`, not `nodeId`); consumers migrate their
  stored handle. `ownerId` becomes a new ingest argument for consumers that want customer scope.

**Neutral**
- The stateless HMAC token stays in use for the **short-lived delivery** leg; the durable leg is
  the DB-backed `docId`. The two token types coexist by design.

## Open items (tracked as tasks)

- **Opaque `docId` + `Document` row + `linkFor` (the app/capability core, DB-backed)** → task
  [0008](../tasks/0008-linkfor-delivery-link.md).
- **Customer-scoped read/list + revocation + fetch audit** (the `ownerId` dimension, the portal
  rescope, shares task 0004's store) → task
  [0009](../tasks/0009-ownership-registry-customer-scope.md).

## References

- [ADR 0005](0005-shared-delivery-ingest-service.md) (shared delivery + ingest; the open
  authorization item this closes) and [ADR 0001](0001-document-sharing-pattern.md) (DB-backed vs
  stateless token; the `c`/customer claim and per-document revocation originate here).
- onboard [ADR 0003](../../../onboard/docs/adr/0003-inbound-s2s-auth.md) — `azp` derived, never
  declared; `req.user.authInfo.token.azp`, not `req.user.attr.azp`.
- Tasks [0005](../tasks/0005-bucket-model-folder-routing.md) (bucket registry),
  [0007](../tasks/0007-per-app-ingest-authorization.md) (`mayWrite`, the write-side twin),
  [0004](../tasks/0004-revocable-tokens-audit.md) (revocable/audited tokens, shares this store).
- commons `document-service.md` T2 (per-app authorization), T4 (revocable + auditable delivery);
  `cross-cutting.md` §1 (DoD-2, DoD-6), §2.8 (offer cheap, re-validate live).
- `srv/lib/token.js` (short-lived delivery token, `makeToken`/`resolveToken`), `srv/server.js`
  (anonymous deliver route, unchanged by this ADR).
