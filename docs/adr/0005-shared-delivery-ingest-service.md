# ADR 0005 — Document delivery + ingest as a shared CAP service on BTP

- **Status:** Proposed
- **Date:** 2026-06-25
- **Deciders:** Felix De Gracia; to be ratified by the SAP architecture review.
- **Lineage:** Continues the prototype ADR log. ADR 0001 (the sharing pattern) is
  consolidated locally as [`0001-document-sharing-pattern.md`](0001-document-sharing-pattern.md).
  The prototype's public-endpoint ADRs 0002–0004 are consolidated as the discarded
  [RFC 0001](../rfc/0001-public-anonymous-endpoint.md) (see "The gap at 0002–0004" in the
  [ADR index](README.md)). This is the first ADR of the BTP/CAP track (`gpc-document-delivery`).
- **Supersedes:** the public-endpoint trilogy — now [RFC 0001](../rfc/0001-public-anonymous-endpoint.md)
  (APIM / FastAPI proxy / AWS API Gateway), made moot by the constraint in
  [C1](../constraints.md#c1--integration-suite-starter-edition-has-no-anonymous-public-endpoint).

## Context

The project's purpose is **document delivery**: serve OpenText-stored PDFs to customers
through a CloudFront/S3 cache via the stable-URL → short-lived-signed-URL pattern of
ADR 0001. Two forces shape this decision:

1. **The public-endpoint trilogy is now moot.** ADRs 0002/0003/0004 all existed to solve
   one problem — *CPI's HTTPS sender adapter has no anonymous mode* (ADR 0003), so an
   anonymous `/invoice/{token}` endpoint needed an auth bridge (APIM, or a FastAPI proxy,
   or AWS API Gateway). The project has since **pivoted off Integration Suite to a Node
   CAP app on BTP** (see prototype memory `btp-cap-pivot`). In CAP, an anonymous route is
   a three-line Express handler (`cds.on('bootstrap', app.get('/invoice/:token', …))`,
   already live in `srv/server.js`). **The problem those three ADRs fought simply
   dissolves.** The FastAPI `proxy/` becomes dead weight.

2. **The reuse vision survives the pivot.** The Integration Suite handoff was a **two-package**
   plan: `GPCDocumentDeliveryCommons` (shared auth/signing/token/doc-type→prefix) consumed
   by per-domain `GPC*Delivery` packages (invoice, contracts, statements). The iFlow track
   died; the *architecture* is still right. Other SAP apps will need to both **deliver** and
   **ingest** documents, and none of them should re-implement the OpenText auth dance, the
   Cloud Connector tunnel (incl. the keep-alive socket-pinning gotcha), CloudFront signing,
   or secret handling.

## Decision

Build **one central CAP service — "GPC Document Delivery"** — that owns the hard plumbing
(OpenText OTDS/OTCS auth, the Cloud Connector tunnel, CloudFront/S3 cache, Credential
Store) and exposes **two capability groups**:

- **Deliver (customer-facing, anonymous):** `GET /invoice/:token` → verify token → 302 to
  a short-lived CloudFront signed URL. This is ADR 0001 unchanged; the URL contract is
  preserved.
- **Ingest (service-to-service, authenticated):** a CAP API other BTP apps call to upload a
  document. The caller passes a **doc-type**; the service maps it to the OpenText
  folder / S3 prefix (the `VM_DocTypeToS3Prefix` idea from the handoff) and returns the
  `nodeId` (and optionally a sharing token). Drag-and-drop demo upload becomes the first
  client of this same API.

Domain apps (invoice, contracts, statements) are **thin consumers** — they call `ingest`
via IAS service-to-service auth and never touch OpenText / the Cloud Connector directly.
This *is* `GPCDocumentDeliveryCommons`, reborn as a CAP service instead of a CPI package.

### Why a central service (vs alternatives)

| Option | Trade-off | Verdict |
|---|---|---|
| Shared **npm library** embedded per app | every app re-deploys on change; CC + secret wiring duplicated and re-certified per app | Rejected |
| **Per-app** direct-to-OpenText | multiplies the connectivity/credential plumbing we just stabilized; N security boundaries | Rejected |
| **Central service + API** | one owner of the plumbing, one security boundary, thin domain apps; cost is a shared runtime dependency | **Chosen** |

## Consequences

**Positive**
- Single owner of OpenText/CloudFront/Credential-Store/tunnel plumbing; domain apps stay thin.
- One security boundary for both deliver and ingest (mirrors the iFlow "single boundary" intent).
- The FastAPI proxy and the entire 0002–0004 workaround chain are retired.
- The Commons/domain split from the handoff is preserved without Integration Suite.
- **Delivery is now owned in-house, not handed off.** The original spike-then-handoff model
  (we discover → a SAP Integration Suite team builds the iFlow) dissolves: with BTP CAP we own
  the implementation directly. The handoff package's durable design content is promoted to
  [`design/solution-overview.md`](../design/solution-overview.md); the open questions it would
  have asked the SAP team are now our design backlog (e.g. token form → task `0004`).

**Negative**
- The central service is a **shared runtime dependency** (and a potential bottleneck / blast
  radius). Needs availability + capacity attention once multiple domains depend on it.
- **Ingest needs an authorization model**: which calling app may write which doc-type. Not
  yet designed (see open items).

**Neutral**
- Multitenancy/namespacing of doc-types and S3 prefixes becomes a config concern, not code.

## Open items (tracked as tasks)

- **Revocable tokens + fetch audit** — ADR 0001 explicitly prefers the **DB-backed**
  token variant for invoices (per-document revocation + audit), but CAP currently ships
  only the stateless HMAC token. This is a core *delivery* gap. → task `0004`.
- **Ingest API (shared upload)** — first endpoint of the ingest group; validate multipart
  write through the Cloud Connector tunnel. → task `0003`.
- **Doc-type → folder/prefix mapping** and the **ingest authorization model** — to be
  specified before the second domain consumer onboards.

## References

- ADR [0001](0001-document-sharing-pattern.md) (sharing pattern). The public-endpoint
  exploration is [RFC 0001](../rfc/0001-public-anonymous-endpoint.md) (discarded); its root
  cause is [constraint C1](../constraints.md#c1--integration-suite-starter-edition-has-no-anonymous-public-endpoint).
- Integration Suite handoff: `../python/opentext-cdn-prototype/docs/sap-handoff/integration-suite/commons-package-manifest.md` (two-package strategy, naming, `VM_DocTypeToS3Prefix`).
- `srv/server.js` (anonymous deliver route), `srv/lib/{opentext,token,credstore}.js`.
- Memory: `btp-cap-pivot`, `btp-connectivity-proxy-keepalive-pinning`.
