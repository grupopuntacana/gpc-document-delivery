# 0002 — Option B: CloudFront signed URLs + S3 write-through cache

**Status:** in progress — Layers 1+2+3 implemented & unit-tested (decision A: Credential Store). Remaining: real end-to-end cache-hit verification on BTP + the A/B benchmark (task 0003).
**Depends on:** [0001](0001-wire-credential-store.md) (Credential Store holds the CloudFront key + AWS creds)
**Goal:** the prototype's reason for existing — produce the **decision-ready latency
comparison** between serving PDFs direct from OpenText (Option A, current) and via a
CloudFront/S3 cache (Option B).

## Context

Today `GET /invoice/:token` (`srv/server.js`) verifies the token and **streams** the
PDF straight from OpenText (Option A). Option B instead returns a **302 redirect to a
short-lived CloudFront signed URL** backed by an S3 write-through cache, so repeat
fetches are served from the CDN edge, not OpenText.

Reference implementation to port: Python `../python/opentext-cdn-prototype/src/cdn_publisher.py`
(`publish`, `invalidate`, `sign_cloudfront_url`). `srv/lib/credstore.js` already exposes
`getCloudFrontPrivateKey()`. Keep the URL contract (`/invoice/:token`) unchanged.

**Non-secret config (env / `mta.yaml` properties), from the Python `.env`:**
| Key | Value |
|---|---|
| `AWS_REGION` | `us-east-1` |
| `S3_BUCKET` | `opentext-cdn-cache-gpc` |
| `CLOUDFRONT_DOMAIN` | `d3ef18l0vjlle9.cloudfront.net` |
| `CLOUDFRONT_KEY_PAIR_ID` | `KOZINHBBRK0NV` |
| `SIGNED_URL_TTL_SECONDS` | `300` |

**Secrets (Credential Store):** `CloudFrontPrivateKey` (already in task 0001).
AWS access key/secret for S3 — see open question.

## ✅ Resolved decision (was: blocks layer 2 only)

**Decision: Option A — Credential Store.** S3 creds are `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY` `password` entries, read via `credstore.getAwsCredentials()`
(env fallback for local/hybrid), cached in-memory like the HMAC secret. Original options:
- **A — Credential Store** (recommended): add `password` entries `AWS_ACCESS_KEY_ID` /
  `AWS_SECRET_ACCESS_KEY`, read via a new `credstore.getAwsCredentials()`. Consistent
  with how every other secret is handled.
- **B — env vars** via `secrets.mtaext` (quick, less clean).
- **C — defer**: pre-warm the bucket out-of-band (Python side has boto3) and ship
  **layer 1 + 3 only** (signing + 302). This already yields the headline **cache-hit**
  latency number without any AWS creds on BTP; add write-through (layer 2) later.

> Signing itself (layer 1) is **offline crypto** — it needs the CloudFront private key
> but NO AWS SDK and NO AWS creds. Only the S3 cache (layer 2) needs creds.

## Acceptance criteria

- [ ] `GET /invoice/:token` in `cdn` mode returns **302** to a CloudFront signed URL
      that actually serves the PDF (cache hit) end-to-end.
- [ ] Signed URLs are **byte-identical** to the Python signer for the same key + policy
      + expiry (RSA PKCS#1 v1.5 is deterministic — cross-verify).
- [ ] `OPENTEXT_DELIVERY_MODE=stream|cdn` toggles Option A vs B without code changes,
      so both can be benchmarked.
- [ ] S3 is treated as a **cache, not store-of-record**: objects tagged/metadata'd
      `cache-only=true`, `source-of-truth=opentext` (mirror `cdn_publisher.py`).
- [ ] A benchmark captures Option A vs B latency (feeds task 0003).

## Checklist

### Layer 1 — `srv/lib/cloudfront.js` (signing; no AWS creds)
- [x] Port `sign_cloudfront_url`: canned policy, **RSA PKCS#1 v1.5 + SHA-1**, AWS base64
      alphabet (`+`->`-`, `=`->`_`, `/`->`~`). In Node: `crypto.createSign('RSA-SHA1')`
      (PKCS#1 v1.5 is the default padding) + a `awsBase64()` replace.
- [x] Keep the policy string byte-exact:
      `{"Statement":[{"Resource":"<url>","Condition":{"DateLessThan":{"AWS:EpochTime":<epoch>}}}]}`
- [x] `s3Key(nodeId)` = `documents/${nodeId}.pdf` (match Python `_s3_key`).
- [x] `signedUrlForNode(nodeId, ttl?)`: build `https://${CLOUDFRONT_DOMAIN}/${s3Key}`,
      sign with key from `credstore.getCloudFrontPrivateKey()`, env-driven domain/keypair/TTL.
- [x] Cache the signing key in-module (single-flight promise) like the secret/ticket caches.
- [x] **Test** `test/cloudfront.test.js`: cross-verified against an **independent oracle**
      (re-derives the signature without the module's `awsBase64` — proves byte-identity
      against any other PKCS1v15+SHA1 signer, incl. Python) using a throwaway test RSA key,
      plus a public-key round-trip verify and URL-param-format assertions.

### Layer 2 — `srv/lib/cdn.js` (S3 write-through; decision A: Credential Store)
- [x] Add dependency `@aws-sdk/client-s3` (S3 only; CloudFront invalidation deferred).
- [x] `credstore.getAwsCredentials()` (decision A) with env fallback
      (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`) for local/hybrid, cached single-flight.
- [x] `publish(nodeId)`: `HeadObject` -> on miss `opentext.downloadDocument` +
      `opentext.getNodeName` + `PutObject` (ContentType `application/pdf`, Metadata
      `cache-only=true`, `source-of-truth=opentext`, `opentext-node-id`,
      `original-filename`) -> return `cloudfront.signedUrlForNode(nodeId)`.
- [x] `invalidate(nodeId)`: delete S3 object (CloudFront invalidation intentionally
      skipped — billed/slow; short TTL + lifecycle policy already bound staleness).
- [x] **Test** `test/cdn.test.js` with a mocked S3 client (head-miss puts, head-hit skips,
      non-404 rethrows, invalidate deletes).

### Layer 3 — wire `/invoice/:token` + toggle
- [x] In `srv/server.js`, read `OPENTEXT_DELIVERY_MODE` (default `stream`).
      `cdn` -> `const url = await cdn.publish(payload.nodeId); res.redirect(302, url);`
      `stream` -> existing Option A body.
- [x] Keep the `t0`/timing log; log mode + ms so the two paths are comparable.
- [ ] Verify a token still resolves and the redirect serves the PDF **end-to-end** (needs
      a provisioned bucket + AWS creds on BTP — pending deploy; feeds task 0003 benchmark).

## References
- Python: `../python/opentext-cdn-prototype/src/cdn_publisher.py` (port target),
  `docs/setup/0{1,2,3}-*.md` (bucket / key pair / distribution provisioning).
- CAP: `srv/lib/credstore.js` (`getCloudFrontPrivateKey`), `srv/server.js` (Option A handler),
  `srv/lib/token.js` (token resolve), `srv/lib/opentext.js` (`downloadDocument`).
- CLAUDE.md (Python repo): "cdn_publisher.py — S3 cache + CloudFront signed URLs" invariants.
- AWS docs: "Create a signed URL using a canned policy."
