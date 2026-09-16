# Architecture Decision Records

The **active decision log** — one entry per decision we made and stand behind. An ADR is for
choices we *maintain*; explorations we discarded live as [RFCs](../rfc/), and durable platform
facts live in [constraints.md](../constraints.md). See [docs/README.md](../README.md) for the
full doc taxonomy.

These records were validated in the Python prototype and are now **consolidated here** — this
repo is self-contained, the prototype is archival.

| # | Title | Status |
|---|-------|--------|
| [0001](0001-document-sharing-pattern.md) | Document sharing pattern (stable URL → short-lived signed URL) | Accepted |
| [0005](0005-shared-delivery-ingest-service.md) | Document delivery + ingest as a shared CAP service on BTP | Proposed |
| [0008](0008-bucket-scoped-cross-app-reads.md) | Bucket-scoped reader/writer grants for cross-app document delivery (S3-aligned) + `register` | Proposed |

> ADRs 0006 (opaque `docId` claim-check) and 0007 (plugin-ingest / app-private node reference)
> land with the delivery-link-authorization branch; 0008 extends 0006 and amends 0007.

## The gap at 0002–0004

The prototype's ADRs 0002, 0003 and 0004 were the **public-endpoint trilogy** (APIM →
FastAPI proxy → AWS API Gateway). They were never decisions we kept — they were workarounds
for a constraint ([C1](../constraints.md#c1--integration-suite-starter-edition-has-no-anonymous-public-endpoint)),
and ADR 0005 dissolved the problem by moving delivery to a CAP service. They have been
**reframed as a single discarded RFC** — see [RFC 0001](../rfc/0001-public-anonymous-endpoint.md).
The numbers 0002–0004 are intentionally retired here so the active log shows only live
decisions; ADR 0005 keeps its number to preserve the lineage it was created under.
