# GPC Document Delivery (SAP CAP on BTP)

Node.js CAP application on BTP that stores documents in OpenText and hands out short-lived
delivery links to them. It does three things:

- **Deliver** — an anonymous `GET /invoice/:token` (or `/doc/:token`) verifies a sharing
  token, then either streams the file from the system of record (`stream`) or 302-redirects
  to a short-lived CloudFront signed URL backed by an S3 write-through cache (`cdn`). Toggle
  with `OPENTEXT_DELIVERY_MODE=stream|cdn`; the deployed app runs `cdn`.
- **Ingest** — `IngestService.uploadDocument` uploads into a per-app *bucket* (an OpenText
  folder with writer/reader ACLs).
- **Link** — `LinkService` turns a document reference into a fresh delivery link, for CAP apps
  (`register` / `linkFor`) and for S/4 ArchiveLink documents (`linkForArchive`).

Decisions, constraints and runbooks live in [`docs/`](docs/README.md); other systems adopting
the service start at [docs/CONSUMING.md](docs/CONSUMING.md).

## Diagnostics (`SelfTestService`)

`SelfTestService` (`srv/delivery-service.{cds,js}`) checks the two BTP plumbing pieces
everything else depends on: secrets from the **SAP Credential Store** and OpenText
connectivity through the **BTP Destination Service**. Its actions return status only, never
secret material:

| Action | Proves | Returns |
|---|---|---|
| `POST /odata/v4/selftest/checkSecret` | Credential Store read | `{ ok, source, secretLen, keyFingerprint }` |
| `POST /odata/v4/selftest/pingOpenText` | Destination + OTDS auth | `{ ok, status, nodeTitle, ms }` |
| `POST /odata/v4/selftest/version` | Deployed build version | `{ version }` |

On a healthy deployment `checkSecret` returns `source:"credstore"` with `secretLen:64`, and
`pingOpenText` returns `ok:true` with node 2000's title.

### Code map (`srv/lib/`)
- `credstore.js` — Credential Store REST reader (Basic auth + namespace header, JWE response
  decrypt with the binding's client key). Falls back to `process.env` when unbound, so
  local/test runs need no BTP services.
- `opentext.js` — OTDS ticket bootstrap + OTCS calls (list, fetch, upload) over the
  Destination Service. `OTDSTicket` on every OTCS call; single retry on 401, no backoff.
  Endpoint paths are constants here, never in env.
- `token.js` / `doctoken.js` — the `/invoice` (v1) and `/doc` (v2) sharing tokens.
- `cloudfront.js` / `cdn.js` — CloudFront canned-policy signing and the S3 cache.
- `buckets.js` / `archives.js` — the bucket registry and the ArchiveLink repository grants.
- `delivery.js` — dispatches a document by source (`otcs` | `archivelink`);
  `archivelink.js` / `seckey.js` read from the archive server with signed requests.

## Local development

```bash
npm install
npm test                 # vitest — all logic tests, no BTP services needed

# Boot with the env-fallback secret (checkSecret works; pingOpenText needs bound destinations):
SHARED_LINK_SECRET=<64-char-secret> npx cds serve
curl -u alice: -X POST http://localhost:4004/odata/v4/selftest/checkSecret -d '{}' -H 'Content-Type: application/json'
```

The `SHARED_LINK_SECRET` value **must be byte-identical** to the Python side
(`../python/opentext-cdn-prototype/.env`, 64 chars) or every existing sharing token
breaks — see the cross-side interop contract in that repo's `CLAUDE.md`.

To upload through the portal locally you also need a caller `azp`, since ingest is
ACL-checked (task 0007). One ships with the repo — see
[Writing locally (the dev `azp`)](#writing-locally-the-dev-azp).

## Secrets and per-deployment config

**Secrets** (`SHARED_LINK_SECRET`, the CloudFront private key, the AWS credentials, the
ArchiveLink signing key) are read from the **SAP Credential Store**: `mta.yaml` binds the
existing `credstore-shared` instance, and `credstore.js` auto-detects the binding. With no
credstore bound — local and test runs — it falls back to env, so locally just
`export SHARED_LINK_SECRET=<secret>`. Create the entries as described under
[Credential Store](#credential-store).

**Per-deployment config** that is not secret but must not live in the repo — the bucket ACLs
(`OPENTEXT_BUCKETS`), the ArchiveLink grants (`ARCHIVELINK_REPOSITORIES`) and the signing
certificate — goes in a gitignored MTA extension descriptor:

```bash
cp secrets.mtaext.example secrets.mtaext       # fill in the real values
mbt build
cf deploy mta_archives/document-delivery_1.0.0.mtar -e secrets.mtaext
```

Set these there rather than with `cf set-env`: an imperative env var is reverted to the
`mta.yaml` placeholder on every redeploy.

## BTP setup (one-time, after first deploy)

The MTA (`mta.yaml`) provisions the service instances (ias, **destination**, connectivity,
application-logs, the HDI container) and binds the existing **credstore**. Their *contents*
are configured in the cockpit / CF CLI:

### Destinations
Create two destinations (OTDS is on port 8443, OTCS on 443):

| Name | URL | Auth |
|---|---|---|
| `OpenText_OTDS` | `https://otion.grupopuntacana.com:8443` | BasicAuthentication — `Admin` / `<password>` |
| `OpenText_OTCS` | `https://otion.grupopuntacana.com` | BasicAuthentication — `Admin` / `<password>` |

The OTDS credentials are read off the `OpenText_OTDS` destination and placed in the auth
request body. Override the destination names with `OPENTEXT_OTDS_DESTINATION` /
`OPENTEXT_OTCS_DESTINATION` if needed.

S/4 ArchiveLink delivery (ADR 0009) needs a third destination, to the archive server S/4
archives into. Full steps, including the signing certificate: [docs/setup/archivelink-otac.md](docs/setup/archivelink-otac.md).

| Name | URL | Auth |
|---|---|---|
| `OpenText_OTAC` | `http://otac-dev:8082` (Cloud Connector virtual host) | NoAuthentication — requests are signed instead |

### Credential Store
Namespace defaults to `gpc-document-delivery` (override with `CREDSTORE_NAMESPACE`).

There is **no `cf` plugin and no cockpit editor** for Credential Store entries — writes go
through its REST API, and the request body must be a JWE encrypted to the store's public
key (the mirror of the JWE-decrypt `credstore.js` does on reads). `scripts/credstore-put.js`
does that encryption + POST for you, reusing the bound service key:

```bash
# 1. One-time: a service key exposes the binding (url, mTLS cert/key, encryption keys)
cf create-service-key credstore-shared cli
export CREDSTORE_CREDS="$(cf service-key credstore-shared cli | tail -n +2)"

# 2. Write the entries credstore.js reads (namespace from CREDSTORE_NAMESPACE, default above)
node scripts/credstore-put.js password SHARED_LINK_SECRET    '<64-char-secret>'
node scripts/credstore-put.js key      CloudFrontPrivateKey  "$(cat ../python/opentext-cdn-prototype/secrets/cloudfront_private_key.pem)"
# Option B (cdn mode) also needs the S3 credentials:
node scripts/credstore-put.js password AWS_ACCESS_KEY_ID     '<aws-access-key-id>'
node scripts/credstore-put.js password AWS_SECRET_ACCESS_KEY '<aws-secret-access-key>'
# S/4 ArchiveLink delivery also needs the key pair that signs reads from the archive:
node scripts/credstore-put.js key      ArchiveLinkSigningKey  "$(cat certs/archivelink-signing-dev.key)"
node scripts/credstore-put.js key      ArchiveLinkSigningCert "$(cat certs/archivelink-signing-dev.crt)"

# 3. Cleanup once done — the service key carries live binding creds
cf delete-service-key credstore-shared cli
```

> `credstore.js` expects: `password` entries `SHARED_LINK_SECRET`, `AWS_ACCESS_KEY_ID`,
> `AWS_SECRET_ACCESS_KEY`, and a `key` entry `CloudFrontPrivateKey` (stored base64, as the
> reader expects), all under the namespace above.
>
> **Write-API gotchas** (handled by the script, noted here so they're not rediscovered):
> the JWE protected header must carry an `iat` in **epoch seconds** and be **< 2 minutes
> old** (replay guard); algorithms are fixed to `RSA-OAEP-256` + `A256GCM`; `Content-Type`
> must be `application/jose`. No redeploy is needed after a write — `credstore.js` re-reads
> on the next request — but `cf restage document-delivery-srv` forces a clean instance.

## Hybrid testing (local code, live BTP services)

```bash
# Note: credstore is an existing shared service — its real CF instance is `credstore-shared`,
# not the `document-delivery-credstore` MTA alias.
cds bind -2 credstore-shared,document-delivery-destination,document-delivery-connectivity
npm run watch:hybrid     # cds watch --profile hybrid
# checkSecret.source should now be 'credstore'; pingOpenText.ok=true with the real node-2000 title
```

Bind **all three** services — the OpenText destinations are *OnPremise* (Cloud Connector),
so every OTDS/OTCS call tunnels through the **connectivity** service. Binding only
`destination` gives you the destination config but not the tunnel, and listings fail with
`No binding to a connectivity service found`. The **credstore** binding is what flips
`checkSecret.source` to `'credstore'` (env fallback otherwise).

Auth under hybrid is **mocked** (`.cdsrc.json` `[hybrid].auth`), so no IAS instance is
needed locally — call the authenticated services as a mock user, e.g. `curl -u alice: …`.
Production is unaffected: it uses `[production].auth: ias` from `package.json`.

## Document listing portal

The demo portal lists documents live from OpenText, opens them by clicking, and uploads new
ones. Four pieces:

- **`PortalService.documents()`** (`srv/portal-service.{cds,js}`) — **authenticated**
  function. Calls `opentext.listFolder(folderId)`, keeps documents (type 144), derives a
  category from the filename, and mints a short-lived sharing token per node
  (`srv/lib/token.js`). Returns `[{ nodeId, displayName, category, subtitle, sizeBytes, token }]`.
  Folder id from `OPENTEXT_FOLDER_ID` (default `2000`); token TTL from `PORTAL_TOKEN_TTL_DAYS`
  (default 7).
- **`GET /invoice/:token`** (`srv/server.js`) — **anonymous** route (the token is the
  credential). Verifies the token, then serves the document according to
  `OPENTEXT_DELIVERY_MODE`: `stream` (the default) downloads it from OpenText over the
  Destination Service and returns the bytes; `cdn` puts it in the S3 cache and answers with a
  302 to a CloudFront signed URL (`SIGNED_URL_TTL_SECONDS`). The URL contract is the same in
  both modes.
- **`IngestService.uploadDocument`** (`srv/ingest-service.{cds,js}`) — **authenticated**
  action; the seed of the shared *ingest* group (ADR 0005). Takes `{ bucket, fileName,
  contentType, contentBase64 }`, uploads a multipart type-144 node to OpenText over the
  Cloud Connector (`opentext.uploadDocument`, the first **write** through the tunnel),
  de-duplicates the filename Django-style (append an 8-hex UUID suffix on collision), and
  returns `{ docId, name, token }` — the opaque `docId` claim-check, never the private
  `nodeId` (which stays in the `Documents` row and never leaves the service; ADR 0006/0008).
  The **`bucket`** selects the target folder via the
  registry in `srv/lib/buckets.js` (`OPENTEXT_BUCKETS`), and the write is authorized by the
  caller's **derived `azp`** against that bucket's `allowedWriters` — see
  [Bucket registry](#bucket-registry-opentext_buckets) below.
- **Vue SPA** (`app/frontend/src/App.vue` + `cap.js`) — fetches `documents()`, renders the
  rows grouped (Facturas / Consumo / Otros), each with an **Open PDF** link to
  `/invoice/{token}`. A drag-and-drop **upload box** posts to `IngestService.uploadDocument`
  and refreshes the listing.

### Bucket registry (`OPENTEXT_BUCKETS`)

Ingest is **bucket-per-app** (task 0005): the caller names a `bucket` and the registry
(`srv/lib/buckets.js`) maps it to the OpenText folder the document lands in. A bucket is an
opaque namespace — it says *where* a document goes, never *what it means*.

```bash
OPENTEXT_BUCKETS='{"invoices":{"folderNode":5816,"allowedWriters":["invoice-app-azp"],"allowedReaders":["notifier-app-azp"]},"statements":{"folderNode":5817,"allowedWriters":["app-b-client-id"]}}'
```

Folder nodes are **pre-provisioned** — create the folder in OTCS and put its node id here
(self-provisioning by name is task 0006).

Each bucket has **two per-app ACLs** (task 0007, [ADR 0008](docs/adr/0008-bucket-scoped-cross-app-reads.md)),
mirroring S3's split of `s3:PutObject` from `s3:GetObject`:

- `allowedWriters` — the OAuth `azp` values allowed to **ingest/claim** into the bucket.
- `allowedReaders` — the `azp` values allowed to **read back and mint delivery links**.

A **writer implies read; a reader does not imply write**, so `mayWrite` = `allowedWriters` and
`mayRead` = `allowedReaders ∪ allowedWriters`. This is what lets a document **uploaded by app X
be delivered by app Y** (X a writer, Y a reader of the same bucket) — the classic invoice
generator → notifier flow. The caller's identity is **derived** from its IAS token, never
declared — there is no `app`/`source` body field, and the action rejects one outright. A bucket
with no `allowedWriters` accepts **no** writers, and with no `allowedReaders` grants read only
to its writers: there is no wildcard and no open-by-default, because the whole point of a bucket
is that one app cannot touch another's. **Real per-app ACLs belong in the deployable descriptor
(`secrets.mtaext` / `mta.yaml`), not `cf set-env`** — an imperative env var is reverted to the
descriptor's placeholder on every redeploy. Write rejections:

| Case | Status | Why |
|---|---|---|
| caller's `azp` not in the bucket's `allowedWriters` | `403` | the isolation the bucket model exists for |
| bucket not in the registry | `403` | same status as "forbidden" on purpose — a `400` here would let a caller enumerate other apps' namespaces one probe at a time |
| no `azp` on the caller's token | `403` | provenance must be present at the boundary; a missing claim is never a grant |
| `bucket` missing from the body | `400` | a malformed request, not an authorization question — and no name to confirm |
| `OPENTEXT_BUCKETS` malformed | `500` | a broken deployed config is ours, not the caller's |

The `403` fires before any OpenText call, so a denied write never touches (or creates) a
folder. Its response body says only `not authorized to write this bucket` — the log line
carries which of "no claim" / "unknown bucket" / "not yours" it actually was, along with the
caller's `azp`.

Entries are validated eagerly on first use, so a typo in an unused bucket still surfaces on
the first upload.

#### Writing locally (the dev `azp`)

The ACL applies locally too, so a developer needs an `azp` to upload anything. One is
configured out of the box — no per-developer setup:

- `.cdsrc.json` gives two mock users their own `authInfo.token.azp` under the `hybrid` profile,
  so ingest logs say which caller wrote:
  - **`admin`** / password `admin` → `local-dev-caller-admin`. This is what the browser's login
    dialog asks for when the portal is served by `cds watch` at
    `http://localhost:4004/frontend/index.html`, and the one `.env.example` authorizes.
  - **`alice`** / empty password → `local-dev-caller-alice`. What
    `app/frontend/vite.config.js` proxies as when the SPA runs on its own (`:5173`).
- `.env.example` grants **only `local-dev-caller-admin`** on `invoices`, so `cp .env.example .env`
  lets the portal upload out of the box. To write as `alice` (Insomnia, curl, or the `:5173`
  SPA), add `local-dev-caller-alice` to that bucket's `allowedWriters` in your own `.env`.
- `statements` deliberately keeps a fake azp, so the cross-bucket `403` that task 0007 exists
  to enforce stays verifiable locally.
- Any *other* mock user (`bob`, or any name CAP's `*` wildcard accepts) still authenticates and
  can list documents, but carries no `azp`, so its uploads fail with
  `403 no azp claim on the caller token`. That is the control working, not a misconfiguration.

```bash
cp .env.example .env
npm run watch:hybrid   # the project needs BTP services, so: hybrid
# then open http://localhost:4004/frontend/index.html and log in as `admin` / `admin`
```

Or against the API directly, no SPA involved — same credentials the portal dialog takes:

```bash
curl -u admin:admin -X POST http://localhost:4004/odata/v4/ingest/uploadDocument \
  -H 'Content-Type: application/json' \
  -d '{"bucket":"invoices","fileName":"a.pdf","contentBase64":"JVBERi0xLjQK"}'
```

This exercises the **authorization decision** end to end — `azp` → `mayWrite` → `200`. A mock
user without an `azp` (say `bob`) gets `403`, so does `alice` until you grant its azp, and so
does `admin` against `statements`. What it does **not** exercise is signature/issuer
validation: the mocked `azp` is a plain string, not a signed token. For that, bind a real IAS
instance (see
[Hybrid testing](#hybrid-testing-local-code-live-btp-services)).

Mock users are never reachable in production: `NODE_ENV=production` resolves `auth` to `ias`,
where `authInfo` comes from a verified token and no mock user exists. Verify without deploying:

```bash
NODE_ENV=production node -e "const cds=require('@sap/cds'); console.log(cds.env.requires.auth.kind, Object.keys(cds.env.requires.auth.users||{}))"
```

Carrying an `authInfo` on a mock user works by construction, not by documented CAP contract:
mock users officially take `id`/`password`/`roles`/`attr`/`tenant`/`features`, and `authInfo`
survives only because CAP spreads the whole user config into `cds.User`. If an upgrade ever
stops passing it through, local uploads start returning `403` with a message that blames the
ACL — check this setting first before suspecting the bucket config.

> **The portal's bucket.** The SPA uploads to `invoices` (`app/frontend/src/cap.js`,
> override at build time with `VITE_INGEST_BUCKET`). That bucket's `folderNode` must equal
> **`OPENTEXT_FOLDER_ID`** — the portal *lists* from `OPENTEXT_FOLDER_ID` but *uploads*
> through the registry, so if the two point at different nodes the upload succeeds and the
> document never appears in the listing. Both default to the `5816` "Demo Documents" folder
> in `.env.example`.

#### Finding a caller's `azp`

A bucket's ACL lists client ids that are **not** in `mta.yaml` and cannot be derived from it.
Read a caller's real `azp` one of two ways:

- **From the logs.** Every denied upload logs it:
  `upload denied: azp "<value>" may not write bucket "<name>"` (`cf logs document-delivery-srv`).
  A successful one carries it too. This is the quickest path for an app already calling ingest.
- **From the token.** The caller decodes its own JWT payload (base64, not encrypted) and reads
  the `azp` claim — in the browser's devtools for the portal, or from the token a
  service-to-service client just fetched.

Copy the value into that bucket's `allowedWriters` and redeploy.

> **The portal's upload 403s until its `azp` is in the ACL.** The SPA is itself an ingest
> caller, and the `srv-api` destination sets `forwardAuthToken: true` — so the token reaching
> `srv` is the **forwarded user token**, whose `azp` is the frontend's OIDC client, *not* the
> `srv` module's own technical client. Deploying 0007 is therefore two steps: deploy, read the
> azp, put it in `invoices.allowedWriters`, redeploy. Read it **from a browser request** — a
> service-to-service token carries the technical client's azp instead: a wrong value that
> looks plausible.

`srv/lib/token.js` is a byte-for-byte port of Python `src/token_redirect.py` — verified by
cross-interop test (a token minted by either side validates on the other). Keep them in
sync if either changes.

Listing real data requires a live OpenText destination, so run it **hybrid** (`cds bind`)
or deployed.

## Delivery links (`LinkService`) — the read/claim surface

`LinkService` (`srv/link-service.{cds,js}`, `@path: link`) turns a durable handle into a fresh,
short-lived `/invoice/{token}` delivery link ([ADR 0006](docs/adr/0006-delivery-link-authorization.md)
/ [0008](docs/adr/0008-bucket-scoped-cross-app-reads.md)). All its actions are
`@requires: 'authenticated-user'` (service-to-service IAS auth); the anonymous leg is the
separate `/invoice/{token}` route. No entity is exposed — the store stays un-queryable, and a
raw `nodeId` is never accepted or returned.

- **`register(bucket, nodeId) → { docId }`** — the **write-side** claim. A **writer** of the
  bucket (`mayWrite`) claims a node it uploaded directly through the `@gpc/attachments-opentext`
  plugin (which leaves no `Documents` row), folder-guarded (the node must sit in the bucket's
  folder), and gets back the opaque `docId` to store in its own domain table. Mints no link.
- **`linkFor(docId, ttlDays?) → { deliveryUrl, expiresAt }`** — the **read-side**, client-safe
  path. Resolves the opaque `docId`, authorizes the caller as a **reader** of the row's bucket
  (`mayRead` = readers ∪ writers), and mints a fresh link — so a doc uploaded by app X is
  delivered by app Y when Y is a reader. `ownerAzp` is audit/revoke only; it does not gate reads.
- **`linkForNode(bucket, nodeId, ttlDays?)`** — the write-side convenience: `register` + mint in
  one call, for an app that both uploads and delivers its own node.

`ttlDays` is optional; omitted, the token defaults to `LINKFOR_TOKEN_TTL_HOURS` (24h), never the
30-day `makeToken` default — the delivery credential is short-lived (re-mint on demand).

### S/4 ArchiveLink documents (`linkForArchive`, `GET /doc/:token`)

Documents S/4 archived through ArchiveLink get links too, without being uploaded to BTP
([ADR 0009](docs/adr/0009-archivelink-source-typed-documents.md)).

- **`linkForArchive(contRep, archDocId, sapObject?, objectId?, docType?, ttlDays?) →
  { docId, deliveryUrl, expiresAt }`** — the caller passes the ArchiveLink reference it holds
  (link-table `ARCHIV_ID` + `ARC_DOC_ID`). It must be listed in `allowedReaders` for that
  repository in `ARCHIVELINK_REPOSITORIES`. The `Documents` row is created on first use with
  `source = 'archivelink'`; `linkFor(docId)` works on it afterwards.
- **`GET /doc/:token`** — the anonymous route for these links. Its token names the `docId` and
  is checked against the row on every request, so revoking a document stops its links at once.
  `/invoice/:token` is unchanged and still serves OpenText nodes.
- The bytes are read from the archive server over the SAP Content Server HTTP protocol, through
  the `OpenText_OTAC` destination, with each request signed (`srv/lib/seckey.js`).

| Variable | Meaning |
|---|---|
| `ARCHIVELINK_REPOSITORIES` | `{"C1":{"allowedReaders":["<azp>"],"destination"?,"compId"?}}` — who may mint links per repository. Set it in `secrets.mtaext`. |
| `ARCHIVELINK_DESTINATION` | Default destination for repositories that don't name one (`OpenText_OTAC`). |
| `ARCHIVELINK_SIGNING_CERT` / `_PATH`, `ARCHIVELINK_SIGNING_KEY` / `_PATH` | The signing key pair, **for local runs only**. On BTP both live in the Credential Store (`ArchiveLinkSigningCert`, `ArchiveLinkSigningKey`), so they rotate together without a redeploy. Signing is on when a certificate is found. |
| `ARCHIVELINK_AUTH_ID` | The ID the certificate is registered under. Default `CN=<certificate CN>`. |
| `DOC_LINK_MAX_TTL_DAYS` | Upper bound for a `/doc` link's lifetime (90). |
| `DELIVERY_BASE_URL` | Base of the links handed to other systems: this service's own route. Set in `mta.yaml` (`${default-url}`). Unset, links come back as a path only. The demo portal doesn't use it; it builds relative links that its router forwards to the service. |

To check connectivity to the archive without deploying, run `scripts/probe-archivelink.js`
(see the [runbook](docs/setup/archivelink-otac.md#3-verify-with-the-probe)).

**Adopting this from another system?** Follow [docs/CONSUMING.md](docs/CONSUMING.md). It covers
CAP apps on BTP (IAS identity, the `DOCUMENT_SERVICE` destination, requesting a bucket, the
proxy model, `register` / `linkFor`) and S/4 (`linkForArchive`, with an ABAP sketch).

## Portal UI (`app/frontend`)

A Vite + Vue 3 SPA served on BTP via the **SAP Application Frontend** (`app-front`) service.

- `app/frontend/public/xs-app.json` — routing: `/odata/**` → `srv-api` destination
  (authenticated); `/invoice/**` and `/doc/**` → `srv-api` anonymously (the token is the
  credential); everything else → `app-front`.
- `app/frontend/public/manifest.json` — Application Frontend app descriptor.
- `app/frontend/vite.config.js` — builds `dist/` and zips it to `dist/frontend.zip` (the
  artifact the MTA's `com.sap.application.content` deployer uploads).

The MTA wires three pieces for this: the `documentdeliveryfrontend` html5 module (runs
`npm ci && npm run build`), the `document-delivery-app-deployer` content module (uploads
`frontend.zip` + registers the `srv-api` destination), and the `document-delivery-app-front`
resource. `deploy_mode: html5-repo` is set at the top of `mta.yaml`.

Local UI dev (Vite proxies `/odata` → the CAP server on :4004):

```bash
npx cds serve &                      # CAP backend on :4004
npm --prefix app/frontend run dev      # SPA on :5173, proxying /odata to :4004
```

## Deploy

```bash
npm install
mbt build                            # builds srv + frontend SPA + content deployer into one mtar
cf deploy mta_archives/document-delivery_1.0.0.mtar
```

> **First deploy after the `gpc-document-delivery` → `document-delivery` rename:** CF keys
> deployments by MTA ID, so the new MTA deploys alongside the old one and the renamed
> managed-service instances are re-provisioned (the old ones orphaned). After confirming the
> new deployment is healthy, clean up the stale MTA with `cf delete-mta gpc-document-delivery`.
> The `credstore-shared` existing-service is unaffected.

**CI/CD.** Pushing a `v*` tag (e.g. `git tag v0.2.0 && git push origin v0.2.0`) deploys to
**Production** via `.github/workflows/release.yaml`. The release first runs a `verify-ci`
gate (`.github/actions/verify-ci`) that checks the CI run (ESLint + vitest) already passed
on the tagged commit — it does **not** re-run tests — so the tag must point at a master
commit where CI ran. Pushing to `master` deploys to **Staging** via `cf.yaml`. On a tag
deploy the tag name is passed as `APP_VERSION` into the SPA build and baked into the bundle
(shown in the portal footer); `POST /odata/v4/selftest/version` reports the backend's build
(`APP_VERSION` env, else `package.json` — the env is not yet stamped into the deployed
runtime, so it currently returns the `package.json` version).

After a deploy, run the [diagnostics](#diagnostics-selftestservice) to confirm the secret
comes from the Credential Store and OpenText is reachable through the Destination.

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
| `link` | info / warn | `linkForArchive minted …` / `… denied for azp "…" …` | a link was minted, or why it was refused (the caller only sees 404) |
| `invoice` | info / error | `served archive=C1/… …` / `fetch failed archive=C1/… : …` | a `/doc` delivery, or the upstream reason for a 502 (the caller only sees a generic message) |
| `archivelink` | debug | `fetched C1/… bytes=… type=…` | one read from the archive server |

Reading the timing: a warm request should show `authMs=0 tokenMs=0`; whatever remains is
`callMs` (OpenText server-side + tunnel latency). If `authMs` or `tokenMs` is non-zero on a
*repeat* request, the corresponding cache isn't taking effect.

### Turn debug timing on (no redeploy)

CAP log levels are set per-logger via the `CDS_LOG_LEVELS` env var (JSON map). Raise just the
two loggers, restage, then read the logs:

```bash
cf set-env document-delivery-srv CDS_LOG_LEVELS '{"portal":"debug","opentext":"debug"}'
cf restage document-delivery-srv

# load the portal a couple of times, then pull the timing lines:
cf logs document-delivery-srv --recent | grep -E "withTicket|documents"
```

Turn it back off when done:

```bash
cf unset-env document-delivery-srv CDS_LOG_LEVELS && cf restage document-delivery-srv
```

Locally, the same applies to `cds watch`: `CDS_LOG_LEVELS='{"portal":"debug","opentext":"debug"}' cds watch`.

### Related env toggles (for diagnosis)

- `CREDSTORE_SECRET_TTL_MS` — secret-cache TTL (default 600000; `0` disables caching).
- `OTDS_TICKET_TTL_MS` — OTDS ticket-cache TTL (default 600000; `0` disables).
- `OTCS_LIST_FIELDS` — fields requested from the OTCS folder list (default
  `properties{id,name,type,size}`; set `''` to fetch the full, unfiltered response).
- `OPENTEXT_KEEP_ALIVE` — `true` enables per-host keep-alive agents (default off; measured
  to give no win — the bottleneck is OpenText-side, not the TLS handshake).

Open work is tracked in [docs/tasks/](docs/tasks/README.md).
