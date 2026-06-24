# GPC Document Delivery (SAP CAP on BTP)

Node.js CAP application that replaces the SAP Integration Suite iFlow track for serving
OpenText PDFs through CloudFront. End goal (across milestones): verify an HMAC sharing
token → fetch the PDF from OpenText (S3-cached) → 302-redirect to a short-lived CloudFront
signed URL — i.e. the CAP port of the Python prototype's `token_redirect.py` +
`cdn_publisher.py` + `opentext_client.py`.

Patterns follow the sibling projects `../bookshop` (deployed) and `../vestibule` (POC):
Node CAP, IAS auth, MTA deploy.

## Milestone 1 — Credential Store + Destination spike (this commit)

Proves the two BTP plumbing pieces the rest of the port depends on, before porting any
crypto:

1. **Secret management** via **SAP Credential Store** — `SHARED_LINK_SECRET` and the
   CloudFront private key are read at runtime from a bound service, not from `.env`.
2. **Connectivity** via the **BTP Destination Service** — OpenText (OTDS/OTCS) is reached
   through destinations; the OTDS-ticket auth dance runs in CAP code.

A `SelfTestService` (`srv/delivery-service.cds`) exposes two diagnostic actions that
return status only, never secret material:

| Action | Proves | Returns |
|---|---|---|
| `POST /odata/v4/selftest/checkSecret` | Credential Store read | `{ ok, source, secretLen, keyFingerprint }` |
| `POST /odata/v4/selftest/pingOpenText` | Destination + OTDS auth | `{ ok, status, nodeTitle, ms }` |

### Code map
- `srv/lib/credstore.js` — Credential Store REST reader (Basic auth + namespace header,
  JWE response decrypt with the binding's client key). Falls back to `process.env`
  (`SHARED_LINK_SECRET`, `CLOUDFRONT_PRIVATE_KEY[_PATH]`) when unbound, so local/test runs
  need no BTP services.
- `srv/lib/opentext.js` — OTDS ticket bootstrap + OTCS node fetch over the Destination
  Service. `OTDSTicket` on every OTCS call; single retry on 401, no backoff. Endpoint
  paths are constants here, never in env.
- `srv/delivery-service.js` — the two handlers.

## Local development

```bash
npm install
npm test                 # vitest — credstore fallback + OTDS retry/header logic (no BTP needed)

# Boot with the env-fallback secret (checkSecret works; pingOpenText needs bound destinations):
SHARED_LINK_SECRET=<64-char-secret> npx cds serve
curl -u alice: -X POST http://localhost:4004/odata/v4/selftest/checkSecret -d '{}' -H 'Content-Type: application/json'
```

The `SHARED_LINK_SECRET` value **must be byte-identical** to the Python side
(`../python/opentext-cdn-prototype/.env`, 64 chars) or every existing sharing token
breaks — see the cross-side interop contract in that repo's `CLAUDE.md`.

## BTP setup (one-time, after first deploy)

The MTA (`mta.yaml`) provisions the service instances (xsuaa, ias, **destination**,
**credstore**, application-logs). Their *contents* are configured in the cockpit / CF CLI:

### Destinations
Create two destinations (OTDS is on port 8443, OTCS on 443):

| Name | URL | Auth |
|---|---|---|
| `OpenText_OTDS` | `https://otion.grupopuntacana.com:8443` | BasicAuthentication — `Admin` / `<password>` |
| `OpenText_OTCS` | `https://otion.grupopuntacana.com` | BasicAuthentication — `Admin` / `<password>` |

The OTDS credentials are read off the `OpenText_OTDS` destination and placed in the auth
request body. Override the destination names with `OPENTEXT_OTDS_DESTINATION` /
`OPENTEXT_OTCS_DESTINATION` if needed.

### Credential Store
Namespace defaults to `gpc-document-delivery` (override with `CREDSTORE_NAMESPACE`). After
binding, create:

```bash
# password entry — the HMAC secret (mirror of the Python .env value)
cf csv-set-value <credstore-instance> <namespace> password SHARED_LINK_SECRET --value '<64-char-secret>'
# key entry — the CloudFront signing private key (PEM)
cf csv-set-value <credstore-instance> <namespace> key  CloudFrontPrivateKey --value "$(cat ../python/opentext-cdn-prototype/secrets/cloudfront_private_key.pem)"
```

> The exact CLI/cockpit steps depend on the tenant's Credential Store tooling; the reader
> in `credstore.js` expects a `password` entry named `SHARED_LINK_SECRET` and a `key` entry
> named `CloudFrontPrivateKey` under the namespace above.

## Hybrid testing (local code, live BTP services)

```bash
cds bind -2 gpc-docdelivery-credstore,gpc-docdelivery-destination
npm run watch:hybrid     # cds watch --profile hybrid
# checkSecret.source should now be 'credstore'; pingOpenText.ok=true with the real node-2000 title
```

## Deploy

```bash
npm install
npx cds build --production
mbt build
cf deploy mta_archives/gpc-document-delivery_0.1.0.mtar
```

**Done when:** on the deployed app, `checkSecret` returns `source:"credstore"` with
`secretLen:64`, and `pingOpenText` returns `ok:true` with node 2000's title — i.e. the
secret comes from Credential Store and OpenText is reached through the Destination, with
no secrets in env or code.

## Roadmap (later milestones)
- `srv/lib/token.js` — port HMAC verify/parse from Python `token_redirect.py`
  (`b64url_nopad(json_sorted).b64url_nopad(hmac_sha256)`).
- `srv/lib/cloudfront.js` — port canned-policy signing (RSA PKCS#1 v1.5 + **SHA-1**, AWS
  base64 alphabet `+→-,/→~,=→_`).
- S3 write-through cache + `GET /invoice/{token}` → 302 redirect endpoint.
- Approuter + portal (mirror the Python `demo/` harness).
- Retire the FastAPI `proxy/` and the Integration Suite handoff once at parity.
