# ADR 0001 — Document sharing pattern: stable app URLs + on-demand short-lived CloudFront signed URLs

- **Status:** Accepted
- **Date:** 2026-05-13
- **Deciders:** Prototype author (Felix De Gracia); to be ratified by the SAP architecture review before iFlow design.
- **Context phase:** Phase 6 of the OpenText CDN prototype.

## Context

The prototype serves invoice PDFs (and similar customer-facing documents) that are stored in OpenText Content Server and cached in CloudFront via a private S3 origin. The remaining design question is **how the link reaches the customer**:

- Filenames follow a predictable convention (`2026-05-12-{customerid}-{account}-{document-number}.pdf`). They are *not* secret.
- A single PDF may be referenced from email, a customer portal, a chat message, or printed onto another document. The URL must therefore survive being copy-pasted across channels and time zones.
- Documents are financial records. Unauthorized read access is a real liability, not just a hygiene concern.
- CloudFront keypair-signed URLs are bound to an `Expires` epoch and a specific resource path. If the URL leaks, every party that holds it can read until expiry; if the keypair is rotated, every outstanding URL stops working.
- We do not yet have a customer-portal session model in place. The pattern must work both with and without an authenticated browser session.

## Decision

We will use a **two-layer URL pattern**:

1. **Stable, customer-facing URL** served by a small app endpoint we control, e.g. `https://billing.gpc.com/invoice/{token}`. The token is an opaque, revocable handle that maps to one OpenText `node_id`.
2. **Short-lived (5-minute) CloudFront signed URL**, generated on demand by the app when a stable URL is dereferenced, served via `302 Found` redirect.

The customer always sees and shares the stable URL. The CloudFront signed URL is regenerated for every request and never lives outside one HTTP round-trip.

S3 keys use a UUID/node-id, not the human filename; the human-readable filename is set on the S3 object via `Content-Disposition: inline; filename="..."` so the browser still saves it correctly.

The token may be one of two forms — both are acceptable; the choice is an implementation detail decided per deployment:

- **Stateless signed token** (HMAC-SHA256 over `{node_id, expiry_epoch, optional_customer_id}` with a server-side secret). Easy to deploy (no DB), trivially scalable, but cannot be revoked individually before its expiry.
- **Database-backed opaque token** (random 128-bit handle indexed in a `shared_links` table). Revocable, auditable, but adds an operational dependency.

For invoices we will start with the **database-backed** form because per-document revocation is a real business need (refunds, mistakenly issued invoices, customer disputes).

## Why this pattern

| Concern | How the pattern addresses it |
|---|---|
| **Revocation** | App layer can flip a `revoked_at` column or delete the token row. The customer-facing URL stops working on the next access. With a long-lived signed URL we would have no recourse other than rotating the entire keypair (breaks all URLs). |
| **Audit** | Every fetch passes through our app before reaching CloudFront, so we record `who fetched, when, from where, which document`. Pure-signed-URL designs cannot answer "who actually opened this invoice." |
| **Key rotation** | The CloudFront keypair can be rotated at any time without breaking customer links — every signed URL is freshly minted. With long-lived signed URLs, rotation is a flag-day operation. |
| **Enumeration resistance** | The S3 key is a UUID; the predictable invoice filename is metadata only. Even if an attacker guesses the filename pattern, they have no S3 key to ask for. |
| **Channel independence** | The stable URL works in email, SMS, chat, printed on paper. The customer's act of clicking is decoupled from the signed URL's lifetime. |
| **Auth optionality** | If the customer happens to have an authenticated session, we layer that check in front of token resolution. If they do not, the token itself acts as a bearer credential. The same backend supports both. |
| **Vendor parity** | This is the pattern used by Stripe, Xero, QuickBooks, Square, DocuSign, and every SaaS that exposes long-lived document references over short-lived signed object stores. We are not inventing anything; we are matching prior art. |

## Rejected alternatives

1. **Public, unsigned CloudFront URL**
   *Rejected:* the filename is enumerable, anyone with the URL can read, and there is no revocation. Acceptable only for non-confidential assets.

2. **Long-lived CloudFront signed URL emailed directly to the customer (months/years)**
   *Rejected:* leaks are permanent, key rotation is a flag-day, and audit trails capture only the last hop (CloudFront access log) — not the act of opening the link. Acceptable as a stopgap for one-off internal sharing only.

3. **Custom-policy signed URL with IP restriction**
   *Rejected:* customer IPs are unpredictable (mobile networks, NAT, VPNs). Operationally infeasible at scale.

4. **CloudFront signed cookies behind a portal login**
   *Considered, kept as a possible future extension:* this is a natural complement to the chosen pattern *inside* a logged-in portal — the portal sets a signed cookie when the user logs in, then renders direct CloudFront links for the docs in their account. Out of scope for the prototype because there is no customer portal yet. The token pattern remains the canonical sharing primitive; signed cookies become a per-session optimisation when the portal exists.

5. **Server-side proxy that streams the PDF bytes through the app instead of redirecting**
   *Rejected:* would force every PDF byte through the app servers, defeating the point of the CDN. Only useful when bytes must be transformed on the fly (e.g. dynamic watermarking) — out of scope here. (Note: the CAP port ships this as **Option A** `stream`, the default mode, alongside the **Option B** `cdn` redirect — toggled with `OPENTEXT_DELIVERY_MODE` without a code change.)

## Consequences

**Positive**
- Single, stable URL per document; survives any channel; works for years.
- Revocation and audit are first-class.
- CloudFront keypair becomes rotatable without flag-day pain.
- The customer-facing surface is the app, not S3 / CloudFront — those become implementation details.

**Negative**
- Adds one app endpoint and a small token-resolution dependency to the runtime path. Token resolution must be cheap (single DB row read or HMAC verify) to keep latency comparable to a direct signed-URL fetch.
- Introduces a `shared_links` table (for the DB-backed variant) that must be backed up and lifecycle-managed.
- The 302-redirect step adds one round trip vs a direct CloudFront fetch. In practice this is ~20–80 ms; negligible compared to the >1 s OpenText baseline we're displacing.

**Neutral**
- The CloudFront signed-URL TTL is now an operational knob, not a customer-visible value. Setting it shorter (e.g. 60 s) costs almost nothing because the customer never sees it.

## Implementation in this prototype

See `srv/lib/token.js` (HMAC verify/mint) and the CAP mint path `PortalService.documents()` (`srv/portal-service.js`). The CAP port ships with the **stateless signed token** variant for simplicity; swapping to the DB-backed variant is a token-resolution body change, not an API change. `PortalService.documents()` demonstrates issuance, and `GET /invoice/:token` (`srv/server.js`) demonstrates resolution, so the pattern can be exercised end-to-end.

In production the redirect endpoint lives behind whatever serves `billing.gpc.com` — for the CAP stack this is the anonymous `GET /invoice/:token` route registered on `cds.on('bootstrap')` in `srv/server.js`. The handler is ~15 lines: parse token, resolve, generate CloudFront signed URL, `return 302 Location: ...`.

## References

- AWS docs — *Serving private content with signed URLs and signed cookies*.
- Stripe API — *Hosted invoice page URLs* (an example of this pattern in production at scale).
- Discovery notes from Phase 4 (`srv/lib/cloudfront.js` for URL signing, `srv/lib/cdn.js` for the S3 cache) — the signing primitive reused here.

---

> **Origin:** Imported from the OpenText CDN Python prototype (`opentext-cdn-prototype`), 2026-05-13. This is the consolidated, self-contained copy — the prototype repo is archival. Benchmark/latency figures are from the prototype's May 2026 measurement run and have not been re-measured against the CAP implementation. See [docs/README.md → Origins & related work](../README.md#origins-and-related-work) for the prototype's role.
