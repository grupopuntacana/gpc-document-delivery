# Platform constraints

Durable facts about the platform that **bound every design decision** in this repo. These
are not decisions and they do not get "superseded" — they are environmental truths. When an
[ADR](adr/) or [RFC](rfc/) says "we couldn't do X," the reason usually lives here.

If one of these stops being true (e.g. the tenant upgrades its Integration Suite edition),
don't edit the fact away — add a dated note and let the dependent ADR/RFC react. The history
of *what was true when we decided* is part of the value.

---

## C1 — Integration Suite **Starter Edition** has no anonymous public endpoint

The customer-facing contract (`GET /invoice/{token}`, anonymous — the token *is* the
credential) cannot be served by the SAP CPI HTTPS sender adapter on this tenant:

- **No anonymous mode.** The HTTPS sender always requires a User Role (`ESBMessaging.send`)
  or client-certificate auth. The token in the URL is opaque to the adapter — only an
  iFlow's Groovy can verify it — so exposing the adapter directly forces every caller to
  authenticate *before* the token check can run.
- **No API Management.** Starter Edition excludes APIM, which is SAP's supported way to put
  an anonymous policy + outbound credential injection in front of CPI.
- **No direct custom domain on CPI.** CPI runtime hosts (`*.cfapps.<region>.hana.ondemand.com`)
  sit behind a shared SAP wildcard cert; CNAME-ing a branded host straight to them fails TLS
  validation. Branded hostnames need Custom Domain Service, which in turn needs APIM or an
  external edge.

**Consequence.** Under the iFlow architecture, an anonymous `/invoice/{token}` needed an
auth bridge. We explored three (APIM, a FastAPI proxy, AWS API Gateway) — see
[RFC 0001](rfc/0001-public-anonymous-endpoint.md). **All of that dissolved** when the project
moved to a Node **CAP** app on BTP, where an anonymous route is a few lines of Express
registered on bootstrap (`srv/server.js`) — see [ADR 0005](adr/0005-shared-delivery-ingest-service.md).
This constraint is *why the CAP runtime was chosen over staying on Integration Suite.*

> If the tenant ever upgrades to Standard/Premium (APIM included), this constraint relaxes —
> but ADR 0005 already removed the dependency, so it would only matter for a hypothetical
> return to the iFlow path.

---

## C2 — OpenText OTDS/OTCS federation auth gotcha (CE 25.4)

Validated the hard way during the prototype's endpoint-discovery phase (see
[endpoint-discovery.md](endpoint-discovery.md)):

- The `OTDSTicket` obtained from OTDS must ride on **every** OTCS call as the session header.
- The `OTCSTicket` returned in OTCS response headers is **not** a valid standalone credential
  — using it alone yields `401`. It is captured for diagnostics only.
- There is **no OTDS→OTCS exchange endpoint**. Do not look for one.

**Consequence.** `srv/lib/opentext.js` bootstraps and caches the OTDS ticket, sends it on
all OTCS calls, and retries once on `401`. This is an interop contract with the Python
prototype's `opentext_client.py`; don't "simplify" the ticket handling without re-validating
against a live CE 25.4 tenant.

---

## C3 — PDFs must not live in HANA

Storing document BLOBs in HANA is undesirable (HANA is for transactional rows; BLOBs bloat
the DB and storage is expensive). This is the founding premise of the whole spike.

**Consequence.** **OpenText is the system of record**; S3 is a **30-day cache only**
(`cache-only=true`, `source-of-truth=opentext` tags + lifecycle policy). Regulator retention
(multi-year energy bills, 7-year invoices) lives on OpenText, never on S3. See
[ADR 0001](adr/0001-document-sharing-pattern.md) and
[architecture-diagrams.md](design/architecture-diagrams.md).

---

## C4 — Cloud Connector tunnel needs keep-alive socket pinning

The BTP connectivity-proxy → Cloud Connector tunnel to on-prem OpenText drops idle sockets
in a way that breaks reused connections. The fix is to pin/keep-alive the socket on the
agent used for OTCS calls.

**Consequence.** `srv/lib/opentext.js` configures the HTTP agent accordingly. Tracked in
memory `btp-connectivity-proxy-keepalive-pinning`. Relevant to anything that adds a new
outbound call through the tunnel (e.g. the ingest write path).

---

## C5 — The sharing token + CloudFront signing are cross-implementation interop contracts

`SHARED_LINK_SECRET` and the token wire format must stay **byte-identical** across every
implementation that mints or verifies tokens (the CAP `srv/lib/token.js`, the Python
prototype's `token_redirect.py`, and any Integration Suite Groovy port). The same applies to
the CloudFront canned-policy signing (RSA PKCS#1 v1.5 + SHA-1, AWS base64 alphabet) in
`srv/lib/cloudfront.js`.

**Consequence.** A token minted by one side must validate on the other (enforced by a
cross-interop test). These modules are **contracts, not free-to-refactor code**. Changing the
secret or the format breaks every outstanding sharing URL.

---

> **Origin:** Synthesized from the OpenText CDN Python prototype (`opentext-cdn-prototype`)
> and this repo's `CLAUDE.md`/`opentext.js`. The prototype repo is archival; see
> [docs/README.md → Origins & related work](README.md#origins-and-related-work).
