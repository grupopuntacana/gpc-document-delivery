# Solution design — OpenText PDF delivery via CloudFront cache

The system design for document delivery: the problem, the chosen architecture, the evidence,
and the design decisions that are still open and **owned by us**.

> **Ownership note.** This began as a discovery spike whose deliverable was a *handoff package*
> for a separate SAP Integration Suite team to build the iFlow. With the move to a **BTP CAP
> app owned in-house** ([ADR 0005](../adr/0005-shared-delivery-ingest-service.md)), that
> two-team model dissolved — the same way the public-endpoint bridge did
> ([RFC 0001](../rfc/0001-public-anonymous-endpoint.md)). So this is **the living design doc
> for an owned system**, not a pitch to another team. The original handoff package (executive
> summary + joint-session playbook + Integration Suite manifests) remains in the prototype repo
> as history — see [Origins](../README.md#origins-and-related-work).

## The problem

Serve OpenText-stored PDFs (invoices, consumption reports, contracts) to customers and external
systems, given that storing BLOBs in HANA is undesirable ([C3](../constraints.md#c3--pdfs-must-not-live-in-hana))
and exposing OpenText directly to cloud apps is impractical (auth model, latency, reliability).

## The design

A **CloudFront-backed S3 cache** in front of OpenText, with a **stable customer-facing URL**
(`/invoice/{token}`) that an app-owned handler resolves to short-lived CloudFront signed URLs.
**OpenText is the source of truth**; S3 is a 30-day cache only. The full rationale and rejected
alternatives are [ADR 0001](../adr/0001-document-sharing-pattern.md); the component and
cache-hit/miss flows are in [architecture-diagrams.md](architecture-diagrams.md).

## The numbers

Measured end-to-end against the real `otion.grupopuntacana.com` and the provisioned
CloudFront distribution. **Prototype benchmark run, May 2026** — not yet re-measured against the
CAP implementation.

| Customer-facing read | Today (direct OpenText) | With cache (warm) |
|---|--:|--:|
| 50 KB invoice PDF, p50 | **863 ms** | **270 ms** |
| 5 MB consumption report, p50 | **1.6 s** | **338 ms** |
| 5 MB report, p95 worst day observed | **>10 s** | unchanged ~553 ms |

- **3–5× lower latency** at the sizes we care about.
- The 5 MB direct-from-OpenText p50 fluctuated between **1.6 s and 4.6 s** across the
  measurement window — same code, same laptop. The cache also **decouples customer-facing
  latency from OpenText's load profile**, which is independently valuable.
- Cold-cache cost is paid **once per document**, ~2.8 s, and can be shifted off the customer's
  critical path by **pre-warming** at PDF-generation time (see Open decisions below).

## Why it works

- **OpenText keeps its compliance role.** Regulator retention (12-year energy bills, 7-year
  invoices) lives on OpenText, not on S3.
- **The customer URL is stable for years.** The CloudFront signed URL it resolves to lives
  5 minutes. Forwarded screenshots stop working.
- **Revocation is a state flip**, not a key rotation. Refunds, disputes, mistaken issuances are
  reversible in seconds (requires the DB-backed token form — see Open decision X.1).
- **Pattern matches industry prior art** (Stripe, Xero, QuickBooks, Square, DocuSign).

## What we rejected (and why)

| Alternative | Why not |
|---|---|
| BLOBs in HANA | HANA is for transactional rows; PDFs bloat the DB and storage is expensive. The whole premise. |
| Direct OpenText reads from cloud apps | Auth model, latency, and reliability all unsuitable for customer-facing traffic. |
| Public CloudFront URL | Filenames are enumerable; no revocation; no audit. Unsuitable for financial records. |
| Long-lived (months/years) signed URLs | URL leak = permanent leak; key rotation breaks every outstanding link. |
| IP-restricted signed URLs | Customer IPs unpredictable (mobile, NAT, VPN). |
| Server-side proxy streaming PDF bytes through the app | Defeats the CDN. Only useful for on-the-fly transforms (watermarking) — out of scope. *(Note: the CAP **Option A** `stream` mode does exactly this by design as the simple default; **Option B** `cdn` is the pattern above.)* |

Full reasoning in [ADR 0001](../adr/0001-document-sharing-pattern.md).

## Use cases

### A — Customer portal: invoices to pay

A logged-in customer opens *Pending Invoices*, sees a table, clicks `Open PDF` → PDF in a new
tab.

1. The page resolves `(merchant_id, customer_id) → [invoice_id, opentext_node_id, …]`.
2. For each row it mints a sharing token for the node (TTL ~30 days, bound to `customer_id`).
   In the CAP app this is the `PortalService.documents()` mint path (`srv/portal-service.js`).
3. The row links to `/invoice/{token}`.
4. On click, the anonymous handler (`srv/server.js`) verifies the token (+ optional session),
   issues a fresh CloudFront signed URL, and returns `302`. First click is a cache miss
   (pull from OpenText, write through); every later click is a cache hit.

**Endpoint contract (current + planned):**

```
GET /invoice/{token}            (live, anonymous — srv/server.js)
  302 -> short-lived CloudFront signed URL
  403  if token revoked / expired / signature bad
  410  if the OpenText node was deleted

mint                            today: PortalService.documents() (authenticated portal)
                                planned service-to-service mint: ADR 0005 ingest/deliver API
```

### B — Energy billing: monthly consumption reports

Same primitive, two surfaces (customer portal for the last 12 months; back-office for older
periods). What differs from A:

- **Retention is a compliance number, not a UX number.** The multi-year regulator requirement
  lives on **OpenText**; S3 still expires cache copies after 30 days. The cache must never
  shorten OpenText retention.
- **File sizes are bigger** (~5 MB graphed reports), so the cache benefit is larger —
  direct download p95 >10 s vs cache hit <100 ms.
- **The back-office "send link to customer"** uses the same mint primitive but typically a
  **shorter TTL** (e.g. 24 h) because it's a one-shot emailed link, not a portal bookmark.

## Open design decisions (we own these now)

These were the questions the handoff would have asked the SAP team to answer. They are now our
design backlog — record each as it lands (ADR for the load-bearing ones, task for the rest).

| # | Decision | Recommendation | Tracked |
|---|---|---|---|
| X.1 | **Token form** — stateless HMAC vs DB-backed opaque | **DB-backed** — per-document revocation + fetch audit are real needs (refunds, disputes). CAP currently ships only stateless HMAC. | [task 0004](../tasks/0004-revocable-tokens-audit.md) |
| X.2 | **Cache warming** — lazy (first read pays ~2.8 s) vs eager (publish at generation) | **Eager** for invoices and reports — the PDF is generated by a background job anyway; `publish()` adds ~2.8 s there and removes the first-customer-read penalty. | — |
| X.3 | **TTL per use case** — portal vs one-shot back-office links | Portal bookmark ~30 days; back-office emailed link ~24 h. | — |
| X.4 | **Secrets management** — where `SHARED_LINK_SECRET` and the CloudFront private key live | Credential Store (BTP), env fallback for local. | root [README](../../README.md) Credential Store section |
| X.5 | **node_id storage** — does the domain model already persist the OpenText node id? | Persist it at PDF-generation time; one-time backfill if only the path is stored. | — |

**Design invariants** (don't re-open without a written reason — these are why the pattern works):

- Never email the CloudFront URL directly (that's the rejected long-lived-signed-URL pattern).
- The token is for our app, not S3 — S3 has no notion of a token.
- No HANA BLOB copy ([C3](../constraints.md#c3--pdfs-must-not-live-in-hana)).
- Don't let SAP/domain apps pre-sign CloudFront themselves — that hands them the private key and
  turns key rotation into a deploy. Signing stays in the delivery service (`srv/lib/cloudfront.js`).

## Runtime cost (order of magnitude)

For the GPC volume profile (confirm with actual document/read counts):

- **Storage:** 30-day rolling cache, ~50K active docs × ~500 KB ≈ ~25 GB on S3 standard ≈ **<$1/mo**.
- **Egress:** the dominant line item. 1M reads/month × 500 KB ≈ 500 GB at ~$0.085/GB-out US ≈ **~$43/mo**.
- **Requests:** ~$0.01 per 10,000 = negligible.

Total: **tens of dollars per month** at expected volumes.

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| OpenText outage (witnessed during the spike) | Medium | Cache keeps serving warm objects; recently-fetched PDFs unaffected. Cold-cache reads fail with a meaningful error. |
| CloudFront keypair compromise | Low | Rotate the keypair; no customer URLs break — every signed URL is freshly minted. |
| S3 bucket policy / OAC misconfiguration | Low | Verified by the CDN self-test walkthrough and the setup runbook. |
| Compliance pushback on "a copy lives in AWS" | Medium | Cache is tagged `cache-only=true`, lifecycled to 30 days, not the system of record. Capture in writing with compliance. |
| Multi-region / data residency | Out of scope | Address only if DR/sovereignty requirements emerge. Pattern is region-agnostic. |

## Where to look

- Pattern rationale: [ADR 0001](../adr/0001-document-sharing-pattern.md)
- Flows / diagrams: [architecture-diagrams.md](architecture-diagrams.md)
- Platform constraints: [constraints.md](../constraints.md)
- AWS provisioning runbook: [setup/](../setup/)
- Code: `srv/lib/opentext.js`, `srv/lib/cdn.js` + `srv/lib/cloudfront.js`, `srv/lib/token.js`,
  `srv/server.js` (anonymous deliver route), `srv/portal-service.js` (mint path)

---

> **Origin:** Consolidated from the OpenText CDN Python prototype's SAP-handoff package
> (`executive-summary.md` + `playbook.md`), prepared 2026-05-14, and reframed as an owned design
> doc. Benchmark/latency figures are from the prototype's May 2026 measurement run and have not
> been re-measured against the CAP implementation. See
> [docs/README.md → Origins & related work](../README.md#origins-and-related-work).
