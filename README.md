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

## Secrets during validation (Credential Store deferred)

The Credential Store is a **paid** service, so it's commented out in `mta.yaml` while we
validate. The code needs no change: `credstore.js` falls back to env when no credstore is
bound (and for Option A only `SHARED_LINK_SECRET` is needed — the CloudFront key isn't used
until Option B). Supply the secret via a gitignored MTA extension descriptor:

```bash
cp secrets.mtaext.example secrets.mtaext       # fill in the 64-char secret
mbt build
cf deploy mta_archives/gpc-document-delivery_0.1.0.mtar -e secrets.mtaext
```

Quick alternative (no extension file): `cf set-env gpc-docdelivery-srv SHARED_LINK_SECRET '<secret>' && cf restage gpc-docdelivery-srv`.
Locally/hybrid: just `export SHARED_LINK_SECRET=<secret>`.

**To switch to Credential Store later:** uncomment the `gpc-docdelivery-credstore` resource
+ the srv `requires` line in `mta.yaml`, create the entries (below), redeploy, and delete
`secrets.mtaext`. `credstore.js` auto-detects the binding — no code change.

## BTP setup (one-time, after first deploy)

The MTA (`mta.yaml`) provisions the service instances (ias, **destination**,
application-logs; **credstore** when re-enabled). Their *contents* are configured in the
cockpit / CF CLI:

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

## Document listing portal (Option A — direct stream)

CAP port of the Python `demo/server.py` portal: list documents live from OpenText and
open them by clicking. Three pieces:

- **`PortalService.documents()`** (`srv/portal-service.{cds,js}`) — **authenticated**
  function. Calls `opentext.listFolder(folderId)`, keeps documents (type 144), derives a
  category from the filename, and mints a short-lived sharing token per node
  (`srv/lib/token.js`). Returns `[{ nodeId, displayName, category, subtitle, sizeBytes, token }]`.
  Folder id from `OPENTEXT_FOLDER_ID` (default `2000`); token TTL from `PORTAL_TOKEN_TTL_DAYS`
  (default 7).
- **`GET /invoice/:token`** (`srv/server.js`) — **anonymous** route (the token is the
  credential). Verifies the token, downloads the PDF from OpenText over the Destination
  Service, and streams the bytes back. *Option A:* serves the PDF directly. A later
  milestone swaps the handler body for a 302 → CloudFront signed URL without changing the
  URL contract.
- **Vue SPA** (`app/portal/src/App.vue` + `cap.js`) — fetches `documents()`, renders the
  rows grouped (Facturas / Consumo / Otros), each with an **Open PDF** link to
  `/invoice/{token}`.

`srv/lib/token.js` is a byte-for-byte port of Python `src/token_redirect.py` — verified by
cross-interop test (a token minted by either side validates on the other). Keep them in
sync if either changes.

Listing real data requires a live OpenText destination, so run it **hybrid** (`cds bind`)
or deployed — same as the Python demo needs live OpenText.

## Portal UI (`app/portal`)

A Vite + Vue 3 SPA, scaffolded with `cds add vue --into portal`, served on BTP via the
**SAP Application Frontend** (`app-front`) service — same delivery pattern as `../bookshop`.

- `app/portal/public/xs-app.json` — routing: `/odata/**` → `srv-api` destination,
  everything else → `app-front`. (`/rest/**` is open/anonymous, ready for the future
  customer-facing token route.)
- `app/portal/public/manifest.json` — Application Frontend app descriptor.
- `app/portal/vite.config.js` — builds `dist/` and zips it to `dist/portal.zip` (the
  artifact the MTA's `com.sap.application.content` deployer uploads).

The MTA wires three pieces for this: the `gpcdocdeliveryportal` html5 module (runs
`npm ci && npm run build`), the `gpc-docdelivery-app-deployer` content module (uploads
`portal.zip` + registers the `srv-api` destination), and the `gpc-docdelivery-app-front`
resource. `deploy_mode: html5-repo` is set at the top of `mta.yaml`.

Local UI dev (Vite proxies `/odata` → the CAP server on :4004):

```bash
npx cds serve &                      # CAP backend on :4004
npm --prefix app/portal run dev      # SPA on :5173, proxying /odata to :4004
```

## Deploy

```bash
npm install
mbt build                            # builds srv + portal SPA + content deployer into one mtar
cf deploy mta_archives/gpc-document-delivery_0.1.0.mtar
```

**Done when:** on the deployed app, `checkSecret` returns `source:"credstore"` with
`secretLen:64`, and `pingOpenText` returns `ok:true` with node 2000's title — i.e. the
secret comes from Credential Store and OpenText is reached through the Destination, with
no secrets in env or code.

## Debugging with logs

The service emits `info`-level operational lines always, and `debug`-level **per-phase
timing** that's off by default. The timing was used to drive the listing-performance work
(secret cache → ticket cache → OTCS field selection, ~2.5s → ~1.1s warm) and stays in the
code for future diagnosis.

### Loggers and what they print

| Logger | Level | Line | Meaning |
|---|---|---|---|
| `portal` | info | `documents: N from folder F` | a listing returned N docs |
| `portal` | debug | `documents timing: listMs=… tokenMs=… totalMs=…` | `listMs`=OpenText round trips, `tokenMs`=secret fetch + HMAC (≈0 once the secret cache is warm) |
| `opentext` | debug | `withTicket: authMs=… callMs=…` | `authMs`=OTDS auth (≈0 when the ticket cache is warm), `callMs`=the OTCS call itself |

Reading the timing: a warm request should show `authMs=0 tokenMs=0`; whatever remains is
`callMs` (OpenText server-side + tunnel latency). If `authMs` or `tokenMs` is non-zero on a
*repeat* request, the corresponding cache isn't taking effect.

### Turn debug timing on (no redeploy)

CAP log levels are set per-logger via the `CDS_LOG_LEVELS` env var (JSON map). Raise just the
two loggers, restage, then read the logs:

```bash
cf set-env gpc-docdelivery-srv CDS_LOG_LEVELS '{"portal":"debug","opentext":"debug"}'
cf restage gpc-docdelivery-srv

# load the portal a couple of times, then pull the timing lines:
cf logs gpc-docdelivery-srv --recent | grep -E "withTicket|documents"
```

Turn it back off when done:

```bash
cf unset-env gpc-docdelivery-srv CDS_LOG_LEVELS && cf restage gpc-docdelivery-srv
```

Locally, the same applies to `cds watch`: `CDS_LOG_LEVELS='{"portal":"debug","opentext":"debug"}' cds watch`.

### Related env toggles (for diagnosis)

- `CREDSTORE_SECRET_TTL_MS` — secret-cache TTL (default 600000; `0` disables caching).
- `OTDS_TICKET_TTL_MS` — OTDS ticket-cache TTL (default 600000; `0` disables).
- `OTCS_LIST_FIELDS` — fields requested from the OTCS folder list (default
  `properties{id,name,type,size}`; set `''` to fetch the full, unfiltered response).
- `OPENTEXT_KEEP_ALIVE` — `true` enables per-host keep-alive agents (default off; measured
  to give no win — the bottleneck is OpenText-side, not the TLS handshake).

## Roadmap (later milestones)
- `srv/lib/token.js` — port HMAC verify/parse from Python `token_redirect.py`
  (`b64url_nopad(json_sorted).b64url_nopad(hmac_sha256)`).
- `srv/lib/cloudfront.js` — port canned-policy signing (RSA PKCS#1 v1.5 + **SHA-1**, AWS
  base64 alphabet `+→-,/→~,=→_`).
- CloudFront signing (`srv/lib/cloudfront.js`, RSA PKCS#1 v1.5 + **SHA-1**) + S3 write-through
  cache, then swap `/invoice/:token` from direct-stream (Option A) to a 302 redirect (Option B).
  Needs AWS credentials on BTP (Credential Store / destination — TBD).
- Optional portal extras from the demo: drag-drop upload + backend-trace panel.
- Retire the FastAPI `proxy/` and the Integration Suite handoff once at parity.
