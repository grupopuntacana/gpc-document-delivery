# RFC 0001 — Anonymous public endpoint in front of CPI

- **Status:** **Discarded** — obsoleted by [ADR 0005](../adr/0005-shared-delivery-ingest-service.md)
  (delivery is now a CAP service that *is* the anonymous endpoint).
- **Date explored:** 2026-05-21
- **Supersedes:** the prototype's ADRs 0002 / 0003 / 0004, which this RFC consolidates.

> **Why this is an RFC and not three ADRs.** These were *explorations*, not decisions we
> kept. They were forced by a constraint ([C1](../constraints.md#c1--integration-suite-starter-edition-has-no-anonymous-public-endpoint)),
> we trialed three bridges, and then the whole problem dissolved. Recording them here — once,
> with the verdict — means that when someone asks *"why not just put APIM (or a proxy, or API
> Gateway) in front of the iFlow?"*, the answer is already on paper: **explored, and discarded
> for the reasons below.** This is the "we already walked into that wall" record, kept so
> nobody re-walks it.

## Problem

ADR 0001's customer-facing contract is `GET https://invoice.gpc.com/invoice/<token>` —
**anonymous and public**, because the token itself is the credential. The CPI HTTPS sender
adapter offers no anonymous mode and the tenant is on Integration Suite **Starter Edition**
(no API Management, no direct custom domain). See [constraint C1](../constraints.md#c1--integration-suite-starter-edition-has-no-anonymous-public-endpoint)
for the full statement. The token→302 logic itself (HMAC verify + CloudFront sign) already
ran inside `IFlow_InvoiceTokenRedirect`; the *only* missing piece was an
anonymous-to-authenticated bridge.

Three bridges were explored.

## Option A — SAP API Management proxy *(the architectural goal, blocked)*

Front the iFlow with an APIM proxy (`API_InvoiceDelivery_v1`); Custom Domain Service maps
`invoice.gpc.com` to the APIM host. APIM holds the CPI technical-user credential in an
encrypted KVM and injects it via a `BasicAuthentication` policy; the caller stays anonymous.

```
Browser → invoice.gpc.com/invoice/<token>  (anonymous)
  → Custom Domain Service → APIM (anonymous policy)
    → BasicAuthentication outbound (creds from KVM)
      → CPI iFlow (ESBMessaging.send) → 302 Location: <cloudfront>
```

- **Cleanest fit** — APIM is the natural home for rate-limiting, IP allow-listing, CORS, and
  is already the SAP-blessed pattern.
- **Blocked:** not included in Starter Edition. Upgrading is a procurement track measured in
  weeks. Remained the goal *if* the tenant ever upgraded.

## Option B — FastAPI proxy container *(built, then discarded)*

This one was **actually built** and used to validate the contract. A deliberately **dumb**
stateless container: anonymous in, reads `CPI_USER`/`CPI_PASSWORD` from env, forwards to CPI
with `Authorization: Basic …`, passes the upstream `302`/`401` back unchanged. No HMAC, no
signing, no business logic — the iFlow stayed the single security boundary. Lived in the
prototype's `proxy/`.

- **Unblocked us immediately** without APIM. Extra hop ~30–80 ms, negligible.
- **Costs:** a long-running container to own (patching, restarts, TLS, log retention) and a
  credential split across two stores (BTP user + proxy `.env`).
- **Why discarded:** it only ever existed to add an *anonymous front door*, and **BTP/CAP
  provides exactly that natively** — an unauthenticated route registered on the CAP app's
  bootstrap (`cds.on('bootstrap', app.get('/invoice/:token', …))` in `srv/server.js`), sitting
  outside CAP's `@requires` services. That route **is what serves the contract today.** Once
  the delivery logic moved into the CAP app, the proxy bridged nothing — there is no separate
  authenticated CPI endpoint left to front. The container was removed, not migrated.

## Option C — AWS API Gateway + Lambda *(proposed graduation, never needed)*

Re-implement the proxy as API Gateway + Lambda in the same AWS account that already hosts
CloudFront/S3. Same ~30 lines; `boto3` Secrets Manager replaces env for the CPI credential.
Custom domain via Route 53 + ACM (free, auto-renewed), no SAP entitlement required.

- **Better ops than B** for bursty, low-volume invoice traffic: no idle container, one-click
  CloudWatch/X-Ray, cleaner credential rotation. Cold start ~200–400 ms, acceptable.
- **Trade-off:** adds API Gateway as a managed surface; would have been the production form of
  B *if the proxy had graduated.* It never did.

## Verdict — all three discarded

The project **pivoted off Integration Suite to a Node CAP app on BTP** (see
[ADR 0005](../adr/0005-shared-delivery-ingest-service.md)). **BTP/CAP serves unauthenticated
routes natively** — an anonymous handler registered on the app's bootstrap
(`cds.on('bootstrap', app.get('/invoice/:token', …))` in `srv/server.js`), outside CAP's
`@requires` services — and **that route is what serves the contract in production today.**
All three options here existed only to manufacture that anonymous front door for the iFlow;
once delivery itself runs in the CAP app there is nothing to bridge, so **the problem they
fought simply disappears.** APIM/proxy/Lambda become dead weight and the FastAPI `proxy/` was
retired (removed, not migrated).

What survives as durable knowledge:

- The **constraint** that caused all this — [C1](../constraints.md#c1--integration-suite-starter-edition-has-no-anonymous-public-endpoint).
  Still true; that's why it's a constraint, not an ADR.
- The **rule** this RFC encodes: *don't re-propose an auth bridge in front of CPI for this
  use case.* If the answer ever needs to change, it's because the **runtime** changed (back to
  iFlow), not because one of A/B/C was overlooked.

## If you are tempted to revive one of these

- **"Just add APIM."** Only relevant if the tenant both (a) upgrades past Starter **and**
  (b) we move delivery back onto the iFlow. ADR 0005 removed (b).
- **"Keep the FastAPI proxy."** It only ever bridged auth for the iFlow. With no iFlow in the
  delivery path, it bridges nothing.
- **"Use Lambda for the endpoint."** The CAP app already owns the anonymous route and the
  OpenText/CloudFront plumbing; a second endpoint runtime would re-split ownership ADR 0005
  deliberately unified.

---

> **Origin:** Consolidated from the OpenText CDN Python prototype's ADRs 0002–0004
> (`opentext-cdn-prototype/docs/adr/`), 2026-05-21. The prototype repo is archival; see
> [docs/README.md → Origins & related work](../README.md#origins-and-related-work).
