# Executive summary — OpenText PDF delivery via CloudFront cache

> One-page decision package for the architecture review. Prepared
> 2026-05-14. Backed by a working prototype in this repository.

## The question on the table

How should we serve OpenText-stored PDFs (invoices, consumption
reports, contracts) to customers and external systems, given that
storing BLOBs in HANA is undesirable and exposing OpenText directly
to cloud apps is impractical?

## Recommendation

Adopt a **CloudFront-backed S3 cache** in front of OpenText, with a
**stable customer-facing URL** (`billing.gpc.com/invoice/{token}`)
that an app-owned redirect handler resolves to short-lived
CloudFront signed URLs. **OpenText remains the source of truth**;
S3 is a 30-day cache only.

Documented in [ADR 0001](../adr/0001-document-sharing-pattern.md).
Proof of life in this repo.

## The numbers

Measured end-to-end against the real `otion.grupopuntacana.com` and
the provisioned `d3ef18l0vjlle9.cloudfront.net` distribution.

| Customer-facing read | Today (direct OpenText) | With cache (warm) |
|---|--:|--:|
| 50 KB invoice PDF, p50 | **863 ms** | **270 ms** |
| 5 MB consumption report, p50 | **1.6 s** | **338 ms** |
| 5 MB report, p95 worst day observed | **>10 s** | unchanged ~553 ms |

- **3–5× lower latency** at the sizes we care about.
- The 5 MB direct-from-OpenText p50 fluctuated between **1.6 s and
  4.6 s** across the spike's measurement window — same code, same
  laptop. The cache also **decouples customer-facing latency from
  OpenText's load profile**, which is independently valuable.
- Cold-cache cost is paid **once per document**, ~2.8 s, and can be
  shifted off the customer's critical path by **pre-warming the
  cache** at the moment the PDF is generated (see §Implementation
  options below).

## Why this works

- **OpenText keeps its compliance role.** Regulator retention (12-year
  energy bills, 7-year invoices) lives on OpenText, not on S3.
- **The customer URL is stable for years.** The CloudFront signed URL
  it resolves to lives 5 minutes. Forwarded screenshots stop working.
- **Revocation is a database flip**, not a key rotation. Refunds,
  disputes, mistaken issuances are reversible in seconds.
- **Pattern matches industry prior art** (Stripe, Xero, QuickBooks,
  Square, DocuSign). We are not inventing anything load-bearing.

## What we rejected (and why)

| Alternative | Why not |
|---|---|
| BLOBs in HANA | HANA is for transactional rows; PDFs bloat the DB and storage is expensive. The whole reason for this spike. |
| Direct OpenText reads from cloud apps | Auth model, latency, and reliability all unsuitable for customer-facing traffic. Phase 5 numbers confirm. |
| Public CloudFront URL | Filenames are enumerable; no revocation; no audit. Unsuitable for financial records. |
| Long-lived (months/years) signed URLs | URL leak = permanent leak; key rotation breaks every outstanding link. |
| IP-restricted signed URLs | Customer IPs unpredictable (mobile, NAT, VPN). |
| Server-side proxy streaming PDF bytes through the app | Defeats the CDN. Only useful for on-the-fly transforms (watermarking) — out of scope. |

Full reasoning in [ADR 0001](../adr/0001-document-sharing-pattern.md).

## Effort to build (estimate)

- **Prototype effort consumed:** ~2 days, single engineer, full
  spike completed (this repo).
- **Production effort estimated:**
  - One `shared_links` table or HMAC secret (trivial).
  - One redirect handler (~50 lines + tests).
  - Wire-up in the customer portal and back-office UI: depends on
    portal stack — likely 1–2 sprints per use case.
  - IaC for S3 + CloudFront + key group + OAC: ~1 sprint, one-time.

No new vendor relationships. No new platform skills required of the
SAP team; the integration surface is a single REST call
(`POST /internal/share/mint`).

## Runtime cost (rough order of magnitude)

For the GPC volume profile (assumptions to confirm with SAP / finance):

- **Storage:** 30-day rolling cache, ~50K active documents at avg
  500 KB = ~25 GB on S3 standard ≈ **<$1/mo**.
- **Egress:** CloudFront data transfer is the dominant line item.
  Even at 1M reads/month × 500 KB average = 500 GB at
  ~$0.085/GB-out US ≈ **~$43/mo**.
- **Requests:** ~$0.01 per 10,000 = negligible at expected volumes.

Total: **tens of dollars per month** at expected volumes. Replace
these numbers with the SAP team's actual document and read counts
to firm up before the meeting.

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| OpenText outage (witnessed during the spike) | Medium | Cache continues to serve warm objects; customer reads of recently-fetched PDFs are unaffected. Cold-cache reads fail with a meaningful error. |
| CloudFront keypair compromise | Low | Rotate the keypair; no customer URLs break because every signed URL is freshly minted. |
| S3 bucket policy / OAC misconfiguration | Low | Caught by the live E2E test; CDN self-test (`scripts/` walkthrough) verifies the full chain. |
| Compliance pushback on "a copy lives in AWS" | Medium | The cache is tagged `cache-only=true`, lifecycled to 30 days, and not the system of record. Capture this in writing with compliance during the SAP session. |
| Multi-region / data residency | Out of scope for spike | Address only if DR or sovereignty requirements emerge. Pattern is region-agnostic. |

## Implementation options to decide in the joint session

1. **Token form:** stateless HMAC vs DB-backed opaque token.
   Recommendation: **DB-backed** because revocation is a real
   business need (refunds, disputes). Stateless is the prototype's
   default for simplicity.
2. **Cache warming strategy:** lazy (first read pays the cold-cache
   tax) vs eager (publish at PDF-generation time, customer's first
   read is already warm). Recommendation: **eager for invoices and
   consumption reports** — the PDF is generated by a background job
   anyway; calling `publish()` adds ~2.8 s to that job and removes
   the first-customer-read penalty entirely.
3. **TTL:** prototype default is 30 days. SAP confirms per use case.

## Next steps

1. Joint session with SAP development team using the
   [playbook](playbook.md). Walk both use cases (customer portal
   invoices, energy billing reports). Capture decisions in §5 of
   the playbook.
2. Re-benchmark closer to the meeting date to capture a
   representative OpenText baseline (varies day to day).
3. Confirm document/read volumes with SAP to firm up the cost
   estimate above.
4. Write follow-up ADRs only for explicit deviations from ADR 0001.

## Where to look in the repo

- Pattern rationale: [`docs/adr/0001-document-sharing-pattern.md`](../adr/0001-document-sharing-pattern.md)
- Joint-session script: [`docs/sap-handoff/playbook.md`](playbook.md)
- AWS provisioning runbook: [`docs/setup/`](../setup/)
- Working code: `srv/lib/opentext.js`, `srv/lib/cdn.js` + `srv/lib/cloudfront.js`, `srv/lib/token.js`
- Live E2E: `scripts/live_e2e.py` (prototype script)
- Benchmark: `scripts/benchmark.py` (prototype script); full numbers are from the prototype benchmark run, May 2026 (the figures tabulated above)

---

> **Origin:** Imported from the OpenText CDN Python prototype (`opentext-cdn-prototype`), 2026-05-14. This is the consolidated, self-contained copy — the prototype repo is archival. Benchmark/latency figures are from the prototype's May 2026 measurement run and have not been re-measured against the CAP implementation. See [docs/README.md → Origins & related work](../README.md#origins-and-related-work) for the prototype's role.
