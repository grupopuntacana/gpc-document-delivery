# Architecture Decision Records

This is the BTP/CAP track's ADR log. It **continues** the prototype's ADR sequence —
ADRs **0001–0004 live in the sibling prototype repo**
(`../python/opentext-cdn-prototype/docs/adr/`) and remain the source for the
delivery pattern and the (now-superseded) public-endpoint decisions.

| # | Title | Status |
|---|-------|--------|
| 0001 | Document sharing pattern (stable URL → short-lived signed URL) | Accepted *(prototype repo)* |
| 0002 | Public endpoint via APIM | Superseded by 0005 *(prototype repo)* |
| 0003 | Public endpoint via FastAPI proxy | Superseded by 0005 *(prototype repo)* |
| 0004 | Public endpoint via AWS API Gateway | Superseded by 0005 *(prototype repo)* |
| [0005](0005-shared-delivery-ingest-service.md) | Document delivery + ingest as a shared CAP service on BTP | Proposed |
