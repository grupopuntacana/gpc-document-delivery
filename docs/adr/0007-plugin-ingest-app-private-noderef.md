# ADR 0007 — Attachments-plugin ingest: app-private `nodeId` + folder-guarded share-link

- **Status:** Proposed
- **Date:** 2026-09-15
- **Deciders:** Felix De Gracia; to be ratified by the SAP architecture review.
- **Lineage:** Extends and **amends** [ADR 0006](0006-delivery-link-authorization.md), which
  assumed the delivery/ingest service is the *only* way bytes reach OpenText. Builds on the
  `@gpc/attachments-opentext` backend (repo `grupopuntacana/attachments-opentext`; onboard issue
  pitrafa#190) that stores documents in OpenText **directly** via the `@cap-js/attachments`
  plugin. Inherits the provenance rule of onboard
  [ADR 0003](../../../onboard/docs/adr/0003-inbound-auth-ias-ams.md) ("provenance is derived, never
  declared"). Sits under [ADR 0005](0005-shared-delivery-ingest-service.md)'s service-vs-per-app
  tension.

## Context

ADR 0006 designed the "give me a link, avoid IDOR" flow on one assumption: **the service is the
sole ingest path**, so it mints an opaque `docId` at ingest and keeps the `nodeId` inside the
service, never exposed, never accepted back. OpenText `nodeId`s are sequential integers, so an
API that hands one out or takes one in is a walkable read oracle (IDOR, ~CVSS 9); the opaque
`docId` designed that away.

Since 0006 we shipped a **second ingest path**. `@gpc/attachments-opentext` is a
`@cap-js/attachments` storage backend that uploads straight to OpenText over BTP destinations and
stores the returned `nodeId` as the plugin's `Attachments.url`. Storage becomes a config switch,
no service in the byte path — proven end-to-end against live OpenText. That reference **is the
app's "this document is mine" claim**, and it is minted by OpenText on upload; the delivery
service never sees the upload and has no row for it.

Two things follow that 0006 did not model:

1. There is now an ingest path whose reference (`nodeId`) lives in the **consuming app's** DB, not
   the service's.
2. 0006's rule *"the service never accepts a `nodeId`"* cannot hold literally: on this path the
   app legitimately holds one, and it is the only identity it has for the document.

Underneath sits a hard constraint the plugin makes visible: **one stored reference cannot be both
directly-resolvable-to-bytes and a safe shareable claim-check.** An opaque `docId` is safe to
share but inert (resolving it to bytes needs the registry, i.e. the service on every read — which
would kill the direct-backend win); a `nodeId` enables direct reads but is unsafe if exposed. The
two jobs must be split by **audience**, not folded into one token.

## Decision

**1. Two ingest paths, both first-class.**
   - *Service-ingest* (ADR 0006): the service uploads, mints the opaque `docId` up front, keeps
     the `nodeId`.
   - *Plugin-ingest* (`@gpc/attachments-opentext`): the app uploads directly and stores the raw
     `nodeId` as `Attachments.url`.

**2. On the plugin path, `Attachments.url` is a PRIVATE OpenText reference.** Invariant:

   > No service exposes the `nodeId` to a client, and no service accepts a `nodeId` from an
   > untrusted/client caller.

   The app's own reads are the plugin's **authenticated** `…/content` handler; the partner-facing
   surface is token-gated at the app. The `nodeId` is never client-facing, so the walkable-id IDOR
   cannot arise on this path — not because the id is unguessable (it isn't) but because it never
   crosses to anyone who could walk it.

**3. Sharing on the plugin path is delegated to the delivery service via a *folder-guarded
   claim*.** When the app needs a shareable/signed URL it calls the service **service-to-service**
   (`azp`-authenticated). Because the app uploaded directly, the service has no row yet, so it
   authorizes by **folder membership == the caller's bucket**: it reads the node's OTCS parent and
   confirms it lies in the caller's bucket (folder-per-app, e.g. onboard's `5816`). This is the
   app's legitimate authority — it can only ever share nodes in *its own* folder — not an oracle
   over the store.

**4. First share upserts the `Document` row.** The claim writes the same row 0006/0008/0009 define
   — `{ docId, nodeId, bucket, ownerAzp, ownerId, revoked, createdAt }` — so **revocation and
   audit exist for shared documents**, on the one shared store. Registration is **lazy**
   (create-on-first-share) by default; **eager** (claim immediately after each upload) only where a
   compliance rule requires revocation from the moment of upload. Default lazy: a document that is
   never shared never needs a row.

**5. The client boundary is unchanged and stays opaque.** Clients only ever receive the
   short-lived `/invoice/:token` delivery token; the durable `docId` (if returned) is the app's
   re-mint handle. `srv/server.js` is untouched. The `nodeId` never crosses to a client, on either
   path.

**6. Amendment to ADR 0006.** Its rule *"the service never accepts a `nodeId`"* becomes:

   > The service never accepts a `nodeId` from a **client/untrusted** caller. A **trusted
   > app-to-app** caller may claim nodes **within its own bucket** (folder-guarded).

   0006's opaque-`docId` protection stands unchanged at the client boundary; this amendment only
   opens a bucket-scoped, service-to-service claim for the directly-uploaded node.

### Why this shape (vs alternatives)

| Option | Trade-off | Verdict |
|---|---|---|
| **App-private `nodeId` in `Attachments.url` + folder-guarded lazy claim at share time** | keeps the direct-backend win (no service in the byte path for private reads); sharing stays opaque, revocable, audited; one registry, in the service | **Chosen** |
| Store the opaque `docId` in `Attachments.url` instead of the `nodeId` | every `get`/`delete` must round-trip the service to resolve the id — re-adds the service to the byte path, defeats the direct backend | Rejected |
| A per-app registry (the backend keeps its own `docId → nodeId` + revoke) | duplicates the ownership/revocation store in every app and every app redeploys on a change — exactly what ADR 0005 rejected | Rejected |
| Eager claim on every upload | a service round trip per upload for documents that may never be shared; makes the plugin path depend on the service always | Rejected as default (kept as an opt-in for compliance) |
| Keep ADR 0006 literal (service-only ingest) | contradicts a shipped, proven ingest path; leaves the repo asserting something false | Rejected |

## Consequences

**Positive**
- Preserves the direct-backend win: private back-office reads never traverse the service.
- Sharing is still opaque, short-lived, revocable and auditable — the client never sees a `nodeId`.
- The ownership/revocation registry stays single and in the service; the plugin remains a thin
  storage backend with no auth/registry logic to duplicate or redeploy.
- Reconciles the two ingest paths instead of pretending one exists.

**Negative**
- Revocation/audit do not exist for a plugin-ingested document **until its first share** (the lazy
  default). Acceptable because private reads are already access-controlled at the app; eager
  registration is the escape hatch where a rule demands earlier revocability.
- The folder-guard is only sound with **folder-per-app discipline** (one bucket == one OTCS folder,
  no cross-app sharing of a folder). This must stay true (task 0005's bucket model).
- The service must be able to read a node's **parent** (OTCS metadata) to authorize a claim — a new
  capability on the OpenText client (`getParent`/`nodeInFolder`).

**Neutral**
- Two ingest paths coexist by design; a document that needs both private direct reads and public
  sharing is read via the app's private `nodeId` and shared via the service's `docId` row over the
  same underlying node.
- The anonymous delivery leg and its short-lived token are unchanged.

## Open items (tracked as tasks)

- **Widen `linkFor` to a folder-guarded claim** over a directly-uploaded node (the app-to-app
  accept-side), upserting the `Document` row lazily → amend / extend task
  [0008](../tasks/0008-linkfor-delivery-link.md).
- **OpenText client: read a node's parent folder** to authorize the claim → transport addition
  (twin of the `deleteDocument`/`existsNode` the plugin backend already added).
- **`@gpc/attachments-opentext`: record the app-private-`nodeId` invariant** (its README "not in
  scope") — done alongside this ADR.
- **Per-app lazy-vs-eager registration** decision → default lazy; revisit per consumer.

## References

- [ADR 0006](0006-delivery-link-authorization.md) (the flow this amends), [ADR 0005](0005-shared-delivery-ingest-service.md)
  (service vs per-app), [ADR 0001](0001-document-sharing-pattern.md) (DB-backed token direction).
- onboard [ADR 0003](../../../onboard/docs/adr/0003-inbound-auth-ias-ams.md) (`azp` derived, never
  declared); onboard issue pitrafa#190 (the direct-backend study and package extraction).
- Tasks [0005](../tasks/0005-bucket-model-folder-routing.md) (bucket == folder),
  [0007](../tasks/0007-per-app-ingest-authorization.md) (`mayWrite`/`mayRead`),
  [0008](../tasks/0008-linkfor-delivery-link.md) (`linkFor`, the accept-side to widen),
  [0009](../tasks/0009-ownership-registry-customer-scope.md) (customer scope, same row).
- `@gpc/attachments-opentext` (repo `grupopuntacana/attachments-opentext`): the plugin backend and
  its `Attachments.url = nodeId` reference.
- commons `document-service.md`, `cross-cutting.md` §1 (DoD-1 link-don't-copy, DoD-2 provenance).
