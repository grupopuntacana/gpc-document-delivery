# Documentation

This repo is meant to be a **reference for how document delivery is done** — self-contained,
so you never have to browse another repo to understand a decision. The docs are organized by
*what kind of knowledge* each piece is. Put new docs in the right bucket and the repo stays
legible.

## The taxonomy — where does my knowledge go?

| Kind | Folder / file | Answers | Lifecycle |
|---|---|---|---|
| **Decision** | [`adr/`](adr/) | "What did we decide and what did we give up?" | Accepted → Superseded |
| **Exploration** | [`rfc/`](rfc/) | "What did we explore, and why did we keep or **discard** it?" | Draft → Accepted / **Discarded** |
| **Constraint** | [`constraints.md`](constraints.md) | "What platform fact bound the decision?" | durable — never superseded |
| **Design** | [`design/`](design/) | "What's the solution, why, and what's still open?" | living |
| **Runbook** | [`setup/`](setup/) | "How do I provision/operate this?" | living |
| **Consumer guide** | [`CONSUMING.md`](CONSUMING.md) | "How does my app use this service?" | living |
| **Reference** | [`endpoint-discovery.md`](endpoint-discovery.md) | "What did we learn probing it?" | living |
| **Work** | [`tasks/`](tasks/) | "What is in flight right now?" | todo → done |

**The distinction that matters most** (and the one this repo was reorganized around):

- An **ADR** is a decision you *maintain*. Its "Rejected alternatives" section is for the
  *obvious one-line* alternatives to that decision.
- An **RFC** is for an exploration that was a *mini-project of its own* — too substantial to
  be a bullet. A **discarded** RFC is the receipt for a wall we already walked into: when
  someone says *"why not just do it this way?"*, the answer is on paper. We don't delete
  discarded RFCs — the discard *is* the value.
- A **constraint** is the durable fact that made an option dead. It doesn't get superseded; it
  stays true (e.g. [C1](constraints.md#c1--integration-suite-starter-edition-has-no-anonymous-public-endpoint)
  is why the public-endpoint [RFC 0001](rfc/0001-public-anonymous-endpoint.md) was discarded).

## Map

- **[adr/](adr/)** — active decision log: [0001 sharing pattern](adr/0001-document-sharing-pattern.md),
  [0005 CAP delivery+ingest service](adr/0005-shared-delivery-ingest-service.md), …,
  [0009 S/4 ArchiveLink delivery](adr/0009-archivelink-source-typed-documents.md). (The
  retired 0002–0004 → RFC 0001; see the [ADR index](adr/README.md#the-gap-at-00020004).)
- **[rfc/](rfc/)** — [0001 anonymous public endpoint](rfc/0001-public-anonymous-endpoint.md) *(discarded)*.
- **[constraints.md](constraints.md)** — IS Starter licensing, OTDS auth gotcha, no-HANA-BLOBs,
  CC tunnel pinning, token/signing interop contracts.
- **[design/](design/)** — [solution-overview.md](design/solution-overview.md) (the case:
  numbers, cost, rejected alternatives, use cases, and the open design decisions we own) and
  [architecture-diagrams.md](design/architecture-diagrams.md) (component + cache-hit/miss
  mermaid flows) + [`document-delivery-landscape.excalidraw`](design/document-delivery-landscape.excalidraw)
  (the solution landscape by network zone).
- **[endpoint-discovery.md](endpoint-discovery.md)** — OpenText REST endpoints probed during
  the spike, and the OTDS-federation finding.
- **[CONSUMING.md](CONSUMING.md)** — how another system gets delivery links. For a CAP app that
  stores files with `@gpc/attachments-opentext`: `register` and `linkFor`, IAS identity,
  destination, bucket request, proxy model. For S/4: `linkForArchive` with its ArchiveLink
  reference, including an ABAP sketch. Troubleshooting for both.
- **[setup/](setup/)** — AWS provisioning runbook (S3 bucket, CloudFront key pair, distribution)
  and the [ArchiveLink / OTAC connectivity runbook](setup/archivelink-otac.md).
- **[tasks/](tasks/)** — lightweight work tracker.

For BTP setup, Credential Store, and the debugging/timing playbook, the root
[`README.md`](../README.md) is the source of truth; `CLAUDE.md` is the quick orientation.

## Origins and related work

This documentation was **validated in a Python prototype and consolidated here**. The
prototype proved the architecture and produced the latency numbers cited throughout; this
CAP repo is the going-forward implementation and the **self-contained source of truth**. You
do not need the prototype checked out to understand anything here — imported docs carry an
*Origin* footer purely for lineage.

- **Prototype (archival):** `../python/opentext-cdn-prototype` —
  the canonical Python implementations (`token_redirect.py`, `cdn_publisher.py`,
  `opentext_client.py`) that `srv/lib/{token,cloudfront,cdn,opentext}.js` port from, plus the
  built-and-discarded FastAPI `proxy/` (see [RFC 0001](rfc/0001-public-anonymous-endpoint.md)).
  Treat as **read-only history** — we don't browse it live or edit it.
- **The SAP handoff is retired.** Delivery was originally a discovery spike to be *handed off*
  to a SAP Integration Suite team; with the move to an owned BTP CAP app
  ([ADR 0005](adr/0005-shared-delivery-ingest-service.md)) the two-team model dissolved. The
  durable content of the handoff package (the design case, use cases, and open decisions) was
  promoted into [design/solution-overview.md](design/solution-overview.md); the original
  package — executive summary, joint-session *playbook*, and the Integration Suite manifests —
  stays in the prototype as history.
- **Still living only in the prototype** (a *parallel* track, intentionally not copied here):
  the SAP **Integration Suite** port under `docs/sap-handoff/integration-suite/` — package
  manifests and the live `workspace/` zips. It must stay **token-compatible** with this repo
  via the same `SHARED_LINK_SECRET` ([constraint C5](constraints.md#c5--the-sharing-token--cloudfront-signing-are-cross-implementation-interop-contracts)),
  which is why it stays where the build tooling lives rather than being snapshotted here.
- **Interop note:** the prototype keeps the real secret material (`.env`, the CloudFront
  private key under `secrets/`). Those are *referenced* by path for local/hybrid runs and are
  deliberately **not** copied into this repo. See the root README's Credential Store section.
