# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SAP CAP (Node.js) service on BTP that stores documents in OpenText and hands out short-lived
delivery links to them. Other systems (CAP apps on BTP, S/4) are its consumers. Three jobs:

- **Deliver** — anonymous `GET /invoice/:token` and `GET /doc/:token` verify a sharing token,
  then serve the file. `OPENTEXT_DELIVERY_MODE=stream` (code default) returns the bytes;
  `cdn` (what `mta.yaml` deploys) returns a 302 to a short-lived CloudFront signed URL backed
  by an S3 write-through cache.
- **Ingest** — `IngestService.uploadDocument` uploads into a per-app *bucket*.
- **Link** — `LinkService` turns a document reference into a fresh delivery link.

Where knowledge lives — read the relevant one before acting, don't re-derive it:

| Need | Read |
|---|---|
| BTP setup, Credential Store, hybrid runs, env vars, log/timing playbook | `README.md` |
| Why something is the way it is | `docs/adr/` (decisions), `docs/rfc/` (discarded explorations) |
| Platform facts that must not be "simplified" away | `docs/constraints.md` |
| How a consumer calls this service | `docs/CONSUMING.md` |
| AWS / ArchiveLink provisioning | `docs/setup/` |
| What is in flight | `docs/tasks/` |

`docs/README.md` explains the taxonomy; put new docs in the matching folder.

## Commands

```bash
npm install
npm test                 # vitest run — all logic tests, no BTP services needed
npm run test:watch
npx vitest run test/token.test.js          # single file
npx vitest run -t "name of test"           # single test by name
npm run lint             # eslint (Airbnb + CAP), --max-warnings 0; backend only
npm --prefix app/frontend run lint         # the SPA has its own eslint config

npm run watch            # cds watch on :4004 (needs SHARED_LINK_SECRET in env)
npm run watch:hybrid     # local code + live BTP services (after `cds bind`, see README)

npm --prefix app/frontend run dev          # SPA on :5173, proxies /odata -> :4004

mbt build && cf deploy mta_archives/document-delivery_1.0.0.mtar -e secrets.mtaext
```

- Tests are **vitest**, not the CAP/Jest default; there is no vitest config file.
- CI (`.github/workflows/test.yaml`) runs ESLint + vitest. Deploys never run on a plain push:
  only a `v*` tag (`release.yaml`, gated on CI having already passed on that commit) or a
  manual dispatch of `cf.yaml`.
- Listing or uploading real documents needs live OpenText, so use `watch:hybrid`. Mock users
  there: `admin`/`admin` and `alice` (empty password), each carrying an `azp` (`.cdsrc.json`).

## Architecture

**Services** (`srv/*.cds` + `.js`, all `@requires: 'authenticated-user'`, IAS in production):
- `IngestService` (`/odata/v4/ingest`) — `uploadDocument` → `{ docId, name, token }`.
- `LinkService` (`/odata/v4/link`) — `register`, `linkFor`, `linkForNode`, `linkForArchive`.
  Exposes no entity on purpose.
- `PortalService` (`/odata/v4/portal`) — backs the demo SPA in `app/frontend` (Vue 3 + Vite).
- `SelfTestService` (`/odata/v4/selftest`, files named `delivery-service.*`) — `checkSecret`,
  `pingOpenText`, `version`; status only, never secret material.

**Anonymous routes** (`srv/server.js`, registered on `cds.on('bootstrap')`, outside CAP auth
because the token is the credential):
- `/invoice/:token` — v1 token (`lib/token.js`): stateless HMAC over an OpenText `nodeId`.
- `/doc/:token` — v2 token (`lib/doctoken.js`): HMAC over a `docId`, resolved against the
  `Documents` row on every request, so revoking the row kills outstanding links at once.

**The `Documents` table** (`db/schema.cds`; SQLite locally and in tests, HANA on BTP) maps an
opaque `docId` to where the bytes live. Rows are source-typed: `otcs` (OpenText `nodeId` +
`bucket`) or `archivelink` (S/4 `contRep` + `archDocId`). It is never projected onto a service.

**Authorization** is by the caller's `azp`, derived from its IAS token, never taken from the
request body:
- `lib/buckets.js` — `OPENTEXT_BUCKETS` registry: bucket → OpenText folder, plus
  `allowedWriters` / `allowedReaders`. Writer implies read; no wildcard, nothing open by default.
- `lib/archives.js` — `ARCHIVELINK_REPOSITORIES`: which `azp` may mint links per content
  repository.

**`srv/lib/` modules worth knowing before editing:**
- `delivery.js` — the per-source dispatch table (`SOURCES`). Handlers and routes go through
  it; adding a source is one entry there, never a `row.source === …` branch in a handler.
- `opentext.js` — OTDS ticket + OTCS calls over the Destination Service; caches the ticket,
  retries once on 401. **Auth gotcha:** `OTDSTicket` must ride on *every* OTCS call; the
  `OTCSTicket` in response headers is not a usable credential (401). See constraints C2.
- `archivelink.js` / `seckey.js` — reads from the archive server over the SAP Content Server
  HTTP protocol, each request signed.
- `cdn.js` / `cloudfront.js` — S3 cache and CloudFront canned-policy signing (RSA PKCS#1 v1.5
  + **SHA-1**, AWS base64 alphabet `+→-`, `/→~`, `=→_`).
- `credstore.js` — reads secrets from the SAP Credential Store binding; **falls back to
  `process.env` when none is bound**, so local and test runs need no BTP.

## Rules that aren't obvious

- **`token.js` and `cloudfront.js` are interop contracts, not free to refactor.** The v1 token
  must stay byte-compatible with the Python prototype and the SAP Integration Suite port
  (`test/token.test.js` pins the Python-compatible encoding; constraints C5), and `SHARED_LINK_SECRET` must be
  byte-identical on all sides or every issued link breaks. Need a new token shape? Extend v2
  in `doctoken.js`, which uses a separately derived key.
- **A raw `nodeId` never appears in a request or response** of `IngestService` / `LinkService`
  (the one exception is the write-side claim `register` / `linkForNode`, which is
  folder-guarded). Consumers hold the opaque `docId`.
- **Denials stay opaque to the caller, specific in the log.** Unknown bucket and forbidden
  bucket both return 403 with the same body; a missing or revoked document returns the same
  404; upstream errors return a generic 502. Don't make error bodies more helpful.
- OpenText endpoint paths are **constants in `opentext.js`**, never env. Destination names and
  tunables are env-overridable (`OPENTEXT_*`, `OTDS_*`, `OTCS_*`, `CREDSTORE_*`, `ARCHIVELINK_*`).
- **Config that must survive a redeploy goes in `mta.yaml` or `secrets.mtaext`**, not
  `cf set-env`. Real ACL values (`OPENTEXT_BUCKETS`, `ARCHIVELINK_REPOSITORIES`) live in the
  gitignored `secrets.mtaext`; `mta.yaml` holds placeholders. `.env`, `secrets.mtaext`,
  `certs/` and `.cdsrc-private.json` hold live material — don't print or commit them.
- **Module systems are mixed:** `srv/` and `scripts/` are CommonJS with `'use strict'`;
  `test/` is ESM and pulls backend modules in via `createRequire`. The SPA is ESM with its own
  `package.json`.
- **Tests mock at the `deps` seam** (e.g. `opentext.deps`, `linkService.deps`) and set env
  (`SHARED_LINK_SECRET`, `OPENTEXT_BUCKETS`) at the top of the file before requiring modules.
  Follow that pattern rather than mocking HTTP.
- Per-phase timing logs are `debug` level, off by default:
  `CDS_LOG_LEVELS='{"portal":"debug","opentext":"debug"}'`.
- Code comments and docs cite ADRs and tasks by number (`ADR 0009`, `task 0007`); keep doing
  so, and update the ADR/task when behaviour it describes changes.

## The Python prototype

`../python/opentext-cdn-prototype` is where the architecture was validated. It is read-only
history, and `docs/` is self-contained, so you rarely need it. Two reasons to open it: it is
the reference implementation when touching `token.js`, `cloudfront.js`, `cdn.js` or
`opentext.js` (`src/token_redirect.py`, `src/cdn_publisher.py`, `src/opentext_client.py`), and
it holds the secret material local runs reference by path (never copy it here).
