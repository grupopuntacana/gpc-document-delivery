# SAP handoff playbook — document delivery via CloudFront cache

> A conversation script for the joint session with the SAP development
> team. Read it top-to-bottom in the room; it is paced for a 45-minute
> meeting (15 min framing, 20 min walking the two use cases, 10 min
> capture).
>
> The default answer to every "how should we do X" question is **ADR
> 0001**. Deviations are allowed only when explicitly justified during
> this session. Anything not justified is implicitly adopted.

---

## 0. Pre-read (send 24h before the session)

Three links, no more:

1. [ADR 0001 — Document sharing pattern](../adr/0001-document-sharing-pattern.md) — *how a customer ends up looking at a PDF.*
2. [Phase 5 benchmark numbers](executive-summary.md#the-numbers) — *why we need a cache between OpenText and the world.*
3. This playbook.

If they read only one thing, ADR 0001.

---

## 1. Framing (5 minutes)

> "We did a prototype to find out whether we can serve OpenText PDFs to
> customers without putting BLOBs in HANA and without exposing OpenText
> directly. We can. The numbers say we should. Today we want to walk
> through two of your actual use cases on the new pattern, and end the
> meeting with a list of decisions you own and a list of items we'll
> investigate on your behalf."

Headline numbers to have on a slide:

| Operation | What it costs today (direct OpenText, on-prem, behind VPN) |
|---|---|
| 50 KB invoice PDF download | p50 **1.16 s**, p95 1.84 s |
| 5 MB consumption report PDF download | p50 **4.65 s**, p95 **>10 s** |
| Same PDFs via CloudFront cache hit | typically <100 ms regardless of size |
| OTDS+OTCS auth handshake | p50 **1.5 s** per cold call |

Translation for the room: *every direct read from OpenText pays a second
or more. Every read through the cache pays milliseconds.*

---

## 2. The pattern in one picture (3 minutes)

```
                  ┌───────────────────────────────────────────────┐
                  │  Customer / merchant / back-office user       │
                  └───────────────────────────────────────────────┘
                                       │  (1) GET stable URL
                                       ▼
                       https://billing.gpc.com/invoice/{token}
                                       │
                                       │  (2) verify token,
                                       │       look up node_id,
                                       │       check authz
                                       ▼
                  ┌───────────────────────────────────────────────┐
                  │     SAP-owned redirect handler (the app)      │
                  └───────────────────────────────────────────────┘
                                       │
            ┌──────────────────────────┼──────────────────────────┐
            │  (3) 302 to short-lived CloudFront signed URL       │
            ▼                          ▼                          ▼
      ┌─────────────┐         ┌──────────────┐         ┌────────────────┐
      │  Customer   │────────▶│  CloudFront  │────────▶│  S3 (cache)    │
      │   browser   │  HTTPS  │  (≤100 ms)   │  miss   │  origin only   │
      └─────────────┘         └──────────────┘         └──────┬─────────┘
                                                              │ on miss
                                                              ▼
                                                       ┌─────────────┐
                                                       │  OpenText   │
                                                       │ (source of  │
                                                       │   truth)    │
                                                       └─────────────┘
```

Six things to call out, in this order:

1. **OpenText is the source of truth.** Always. Forever. The S3 bucket
   has a 30-day lifecycle policy and a `cache-only=true` tag exactly so
   nobody can confuse it with storage of record. Compliance keeps
   pointing at OpenText.
2. **The customer never sees S3 or CloudFront.** They see
   `billing.gpc.com/invoice/{token}`. That URL is stable for years.
3. **CloudFront signed URLs live for 5 minutes.** They are re-minted on
   every click. If a customer forwards a screenshot of one to a
   neighbour, it's worthless by the time the neighbour clicks.
4. **Revocation is a database flip**, not a key rotation. Refund? Wrong
   invoice issued? Customer dispute? `UPDATE shared_links SET revoked_at = NOW()`.
5. **OpenText carries the legal retention.** Energy regulators want
   12-year retention; that's an OpenText storage rule, untouched by us.
   The cache is just for speed.
6. **The cache also smooths out OpenText variability.** During the
   spike's measurement window, the same 5 MB consumption-report
   download from OpenText measured **1.6 s p50 on one day and 4.6 s
   p50 another day** — same code, same network. CloudFront cache hits
   were ~338 ms on both days. The customer experience becomes
   independent of OpenText's load profile, which is a benefit beyond
   raw latency.

---

## 3. Use case A — Customer portal: invoices to pay (10 minutes)

### Flow as the customer sees it

> "Logged-in customer opens the *Pending Invoices* page. They see a
> table; each row has an `Open PDF` button. Click → PDF in a new tab."

### Flow under the hood

| Step | Owner | What happens |
|---|---|---|
| 1 | **SAP** | Page queries SAP for `(merchant_id, customer_id) → [invoice_id, opentext_node_id, due_date, amount]`. |
| 2 | **SAP** | For each invoice the page needs to display, SAP calls our `mint_share_token(node_id, ttl_days=30, customer_id=...)` — returns a token. |
| 3 | **SAP** | Page renders `<a href="https://billing.gpc.com/invoice/{token}">Open PDF</a>`. |
| 4 | Customer | Clicks. Browser hits the redirect handler we own. |
| 5 | **Us** | Handler verifies token + (optional) session, then issues a fresh CloudFront signed URL and returns `302 Location: ...`. |
| 6 | Customer | Browser follows the redirect, fetches PDF from CloudFront. First click is a cache miss (we pull from OpenText, then return); every subsequent click on the same invoice is a cache hit. |

### What SAP devs need to investigate / decide

- [ ] Where in the existing app does the `mint_share_token` call live?
      Probably the same controller that already renders the invoices
      table. We want it as close to the rendering as possible, not in
      a batch job.
- [ ] Is there ever a use case where a customer needs the same invoice
      URL to be shareable with their accountant? If yes → TTL >30 days
      and audit log becomes mandatory. If no → 30-day TTL is fine.
- [ ] What does "invoice paid" do to the link? Should the URL keep
      working forever (most common — customers re-download to file
      taxes) or stop on payment? **Default: keeps working.**
- [ ] Is there an existing `customer_id` in session we can pass into
      the token, so the redirect handler can refuse mismatches?
      **Strongly recommended.**
- [ ] **Pre-warm the cache on invoice generation?** When SAP creates
      an invoice and stores the PDF in OpenText, the same job can
      call `publish(node_id)` to write through to S3 immediately. The
      first customer read is then a warm cache hit (~270 ms) instead
      of paying the cold-cache cost (~2.8 s). Adds ~2.8 s to a job
      that already runs in the background. **Strongly recommended
      for invoices.**

### What we investigate on their behalf

- [ ] Confirm with infra: ALB + Lambda-on-API-Gateway or running on the
      existing portal's app server? (Both work; pick whichever already
      has on-call coverage.)
- [ ] Stand up the `shared_links` table: schema, retention, who owns
      backups.
- [ ] Latency budget verification: 302 round-trip + signing must stay
      under 100 ms p95 to keep "click → PDF visible" under 200 ms on
      a cache hit.

### Concrete contract we'll publish

```
POST /internal/share/mint
  body:  { node_id, ttl_days, customer_id, merchant_id }
  200:   { token, stable_url, expires_at }

GET  /invoice/{token}
  302 -> https://d3ef18l0vjlle9.cloudfront.net/documents/...
  403  if token revoked, expired, or signature bad
  410  if the OpenText node was deleted
```

---

## 4. Use case B — Energy billing: monthly consumption reports (10 minutes)

### Flow as the customer sees it

> "Customer opens the *Consumption history* page. They see the last 12
> months as a list. Each row has `Download report`. If they want
> something older than 12 months they're told to contact customer
> service. The customer-service back-office user can pull older months
> directly."

### Flow under the hood — same pattern, two surfaces

| Step | Owner | What happens |
|---|---|---|
| 1 | **SAP** | After the meter-reading collector ingests, the billing job generates the consumption report PDF (the existing process; not changing). |
| 2 | **SAP** | When the PDF is written to OpenText, capture the returned `node_id` against `(customer_id, contract_id, period)` in your domain DB. |
| 3 | **SAP** | Customer portal: list last 12 periods → for each row call `mint_share_token(node_id, ttl_days=30)` → render the link. Same primitive as use case A. |
| 4 | **SAP** | Back-office UI: search by `(customer_id, contract_id, [period])` → render a *list* of `node_id`s → mint tokens for whichever the agent wants to send the customer. |
| 5 | Customer / agent | Clicks. Same redirect handler as use case A. PDF appears. |

### What's different from use case A

- **Retention is a compliance number, not a UX number.** Energy
  regulator requires multi-year retention. That requirement lives on
  OpenText, not on S3. S3 still expires its cache copies after 30
  days. **OpenText must not have its retention shortened by the
  introduction of the cache.** Reaffirm this in writing.
- **File sizes are bigger.** 5 MB is realistic for a graphed
  consumption report. The cache benefit is bigger here than for
  invoices — direct download is p95 >10 s; cache hit <100 ms.
- **The "go to customer service" handoff** is not a separate system;
  the back-office user uses the same `mint_share_token` primitive but
  through their own UI. The token they mint may have a *shorter* TTL
  (e.g. 24 hours) because it's a one-shot link emailed to the
  customer, not a portal bookmark.

### What SAP devs need to investigate / decide

- [ ] Where does `node_id` live in their data model today? If the
      meter-reading → PDF generation job already stores it, great. If
      it stores only the OpenText *path* and not the *node id*, we
      need a one-time backfill.
- [ ] **Pre-warm the cache on report generation?** Same as invoices,
      with a bigger payoff: the 5 MB cold-cache write-through takes
      ~2.8 s, and avoiding that on the customer's first portal visit
      is more noticeable than on the 50 KB invoice case. **Strongly
      recommended.**
- [ ] Back-office UI: does it exist already? If yes, where do we put
      the "send link to customer" button? If no, who builds it?
- [ ] Confirm the regulator's exact retention requirement. The
      prototype assumes "OpenText keeps it; cache expires after 30
      days." We want the regulator's number captured in the ticket so
      future-us doesn't shorten it by accident.
- [ ] What does the customer experience when an OpenText document has
      been moved or archived? Should the stable URL still resolve, or
      should they get a useful error? **Default: 410 Gone with a
      "contact customer service" message.**

### What we investigate on their behalf

- [ ] Stress-test the cache-miss path for 5 MB PDFs: confirm the
      single-stream OpenText download doesn't break the 60-second
      Lambda timeout (it shouldn't — p95 was 10 s — but worth
      confirming).
- [ ] Verify the CloudFront `Content-Disposition: inline; filename=`
      flow correctly preserves the customer-friendly filename
      (`Consumo-2026-04-CLI123.pdf`) instead of the S3 UUID key.
- [ ] Get clarity from compliance on whether the cache copy itself
      counts as "a copy of the record" for retention purposes
      (precedent in industry: no, but capture the answer in writing).

---

## 5. Decisions captured in the room

Have the meeting notes follow this template — *fill it in live, not
afterward*:

```
Decision A.1 — invoice TTL                    : ____ days
Decision A.2 — invoice link survives payment? : yes / no
Decision A.3 — customer_id binding on token?  : yes / no
Decision A.4 — who builds the mint endpoint?  : ____
Decision A.5 — pre-warm cache on issuance?    : yes / no

Decision B.1 — energy TTL (portal)            : ____ days
Decision B.2 — energy TTL (back-office)       : ____ hours
Decision B.3 — OpenText retention number      : ____ years (regulator: ____)
Decision B.4 — node_id storage in SAP today   : yes / needs backfill
Decision B.5 — back-office UI owner           : SAP team / Us / new
Decision B.6 — pre-warm cache on generation?  : yes / no

Decision X.1 — token form: HMAC stateless / DB-backed revocable
Decision X.2 — secrets management: where lives SHARED_LINK_SECRET and
              the CloudFront private key (Secrets Manager / Vault / other)
Decision X.3 — re-benchmark cadence: weekly / monthly / never

Open items returned to us:  [list]
Open items returned to SAP: [list]
Next session date         : ____
```

---

## 6. Anti-pattern guard rail

If any of these phrases is uttered in the room, stop and reread ADR 0001:

- *"Can we just email the CloudFront URL directly?"* — No; that's the
  rejected long-lived-signed-URL pattern. Audit/revocation/rotation
  all break.
- *"Can the customer hit S3 directly with the token?"* — No; the token
  is for our app, not S3. S3 has no idea what a token is.
- *"What if we store the PDF in HANA as a BLOB too?"* — No; that
  re-introduces exactly the problem this prototype was built to avoid.
  HANA is for transactional rows.
- *"Let's give the URL a one-year TTL, it's easier."* — That's pattern
  B in the ADR's rejected list. We will not.

Deviations from the pattern are allowed only with a written reason in
the meeting notes and a follow-up ADR.

---

## 7. Talking points for common pushback

| They say… | You reply… |
|---|---|
| *"This is a lot of moving parts vs just serving from OpenText."* | One redirect handler + one DB table. The moving parts replace 1.5-second p95 latencies with <100 ms ones. Numbers in the executive summary. |
| *"Why not pre-sign at SAP and skip your service?"* | Because then SAP holds the CloudFront private key, and rotating it becomes a SAP deploy, not an ops change. Separation of concern. |
| *"What if AWS goes down?"* | OpenText is still up; rebuild the cache in front of it. Worst case is the latency reverts to today's numbers. No data loss. |
| *"Can we just put OpenText behind CloudFront directly, no S3?"* | Tried in the discovery phase. CloudFront-to-OpenText-over-VPN was unreliable and OpenText's auth model isn't designed for an anonymous edge cache. S3 isolates the cache from the auth model. |
| *"What if we already have an internal CDN?"* | Same pattern applies; replace `CloudFront` with `<internal CDN>`. The ADR is CDN-agnostic. The prototype just happens to use CloudFront. |
| *"OpenText already feels fast enough most of the time."* | "Most of the time" is the issue. Same 5 MB download measured 1.6 s p50 one day and 4.6 s p50 another day during this spike — same code, same network. The cache makes customer-facing latency independent of OpenText's load profile. That predictability is independently valuable. |
| *"Why pre-warm if the cache fills itself on first read?"* | Cold-cache cost is ~2.8 s and the customer pays it. Pre-warming runs inside a background job that already exists (PDF generation), adds ~2.8 s to that job, and removes the penalty from every first customer click. Same total cost, better placement. |

---

## 8. After the session

1. Open one Jira ticket per decision captured above. Link each to this
   playbook.
2. If any deviation from ADR 0001 was agreed, write a follow-up ADR with
   the reason. Link from ADR 0001.
3. Schedule a 30-minute follow-up in two weeks to confirm investigation
   items are answered.

---

## Appendix — the prototype itself

The proof-of-life code was first written in the Python prototype and is
now ported into the CAP service (`srv/lib/`). SAP devs can run it to feel
the pattern; nothing here is hypothetical:

- `srv/lib/opentext.js` — OTDS-federated auth (Phase 2 documented
  the OTCSTicket gotcha; saves them rediscovering it).
- `srv/lib/cdn.js` (cache-miss S3 put) + `srv/lib/cloudfront.js`
  (CloudFront signed URL generation).
- `srv/lib/token.js` — the sharing primitive ADR 0001 describes.
- The CAP mint path `PortalService.documents()` (`srv/portal-service.js`)
  — show them this; it mints a token live per node. (The prototype
  equivalent was `scripts/share_link.py mint <node_id>`.)
- `scripts/live_e2e.py` (prototype script) — end-to-end run; numbers
  go into the benchmark section of the executive summary.

---

> **Origin:** Imported from the OpenText CDN Python prototype (`opentext-cdn-prototype`). This is the consolidated, self-contained copy — the prototype repo is archival. Benchmark/latency figures are from the prototype's May 2026 measurement run and have not been re-measured against the CAP implementation. See [docs/README.md → Origins & related work](../README.md#origins-and-related-work) for the prototype's role.
