# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SAP CAP (Node.js) app on BTP that ports a Python prototype's document-delivery flow:
verify an HMAC sharing token → fetch a PDF from OpenText (OTDS/OTCS over the BTP Destination
Service) → serve it. **Option A** (`stream`, default) returns the PDF bytes directly;
**Option B** (`cdn`) returns a 302 to a short-lived CloudFront signed URL backed by an S3
write-through cache. Toggle with `OPENTEXT_DELIVERY_MODE=stream|cdn` — no code change.

`README.md` is the source of truth for BTP setup, Credential Store provisioning, and the
debugging/timing playbook. Read it before any deploy or BTP-services task. **`docs/` is the
self-contained knowledge base** — decisions in [`docs/adr/`](docs/adr/), discarded
explorations in [`docs/rfc/`](docs/rfc/), durable platform facts in
[`docs/constraints.md`](docs/constraints.md); start at [`docs/README.md`](docs/README.md) for
the taxonomy. Prefer these over browsing the prototype repo — the architecture/decision
knowledge is consolidated here.

The original is the sibling Python prototype `../python/opentext-cdn-prototype` (validated
the architecture and produced the latency numbers, now cited in `docs/`). It remains the
**canonical implementation** reference — `src/token_redirect.py`, `src/cdn_publisher.py`, and
`src/opentext_client.py` are what this repo ports; consult them when changing `token.js`,
`cloudfront.js`, `cdn.js`, or `opentext.js`. It also still holds the **secret material**
(`.env`, `secrets/cloudfront_private_key.pem` — referenced by path, never copied here) and a
**parallel SAP Integration Suite port** (`docs/sap-handoff/integration-suite/`) that must stay
token-compatible via the same `SHARED_LINK_SECRET`. Treat the prototype as read-only history.

## Commands

```bash
npm install
npm test                 # vitest run — all logic tests, no BTP services needed
npm run test:watch       # vitest watch
npx vitest run test/token.test.js          # single file
npx vitest run -t "name of test"           # single test by name

npx cds serve            # boot CAP on :4004 (needs SHARED_LINK_SECRET in env for checkSecret)
npm run watch            # cds watch
npm run watch:hybrid     # cds watch --profile hybrid (local code, live BTP services via `cds bind`)

# Portal SPA (Vite proxies /odata -> :4004)
npm --prefix app/portal run dev            # SPA on :5173

mbt build && cf deploy mta_archives/gpc-document-delivery_0.1.0.mtar   # deploy
```

Tests are **vitest**, not the CAP/Jest default. There is no separate vitest config file.

## Architecture

Request paths:
- **`PortalService.documents()`** (`srv/portal-service.{cds,js}`) — authenticated. Lists a
  folder from OpenText, keeps documents (type 144), and mints a short-lived sharing token
  per node. Returns rows the Vue SPA renders.
- **`GET /invoice/:token`** (`srv/server.js`) — anonymous; the token *is* the credential, so
  it sits outside CAP's `@requires` services and is registered on `cds.on('bootstrap')`.
  Verifies the token, then streams the PDF (Option A) or 302-redirects to CloudFront (Option B).
- **`SelfTestService`** (`srv/delivery-service.{cds,js}`) — `checkSecret` / `pingOpenText`
  diagnostic actions that return status only, never secret material.

`srv/lib/` (the load-bearing ports — keep byte-compatible with the Python side):
- `token.js` — HMAC verify/mint, byte-for-byte port of Python `token_redirect.py`. A token
  minted by either side must validate on the other (cross-interop test enforces this).
- `cloudfront.js` — canned-policy signing: RSA PKCS#1 v1.5 + **SHA-1**, AWS base64 alphabet
  (`+→-`, `/→~`, `=→_`).
- `credstore.js` — reads secrets from SAP Credential Store (JWE-decrypted REST), **falling
  back to `process.env`** when no credstore is bound — so local/test runs need no BTP.
- `opentext.js` — OTDS ticket bootstrap + OTCS calls over the Destination Service; caches
  the ticket, retries once on 401. **Auth gotcha (CE 25.4 + OTDS federation):** `OTDSTicket`
  must ride on *every* OTCS call as the session header; the `OTCSTicket` returned in
  response headers is **not** a valid standalone credential (yields 401) and is captured for
  diagnostics only. There is no OTDS→OTCS exchange endpoint.
- `cdn.js` — Option B S3 cache + CloudFront URL assembly.

## Conventions that aren't obvious

- **`SHARED_LINK_SECRET` must be byte-identical to the Python side** or every existing
  sharing token breaks. Same applies to any change in `token.js` or `cloudfront.js` — they
  are interop contracts, not free to refactor.
- Secrets resolve through `credstore.js`'s env fallback, so you rarely need real BTP creds
  to develop. Required env for a useful local boot: `SHARED_LINK_SECRET` (64 chars).
- OpenText endpoint paths live as **constants in `opentext.js`**, never in env. Destination
  names and tunables are env-overridable (`OPENTEXT_*`, `OTDS_*`, `OTCS_*`, `CREDSTORE_*`).
- Per-phase timing logs are at `debug` level, off by default. Enable with
  `CDS_LOG_LEVELS='{"portal":"debug","opentext":"debug"}'` (see README "Debugging with logs").
- `mta.yaml` provisions service instances; their *contents* (destinations, Credential Store
  entries) are configured separately. During validation the env fallback in `credstore.js`
  supplies secrets; `credstore.js` auto-detects the Credential Store binding, so switching to
  it needs no code change (task `0001`). Write entries via `scripts/credstore-put.js`.
