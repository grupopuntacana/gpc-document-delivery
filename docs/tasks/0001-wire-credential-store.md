# 0001 — Wire the SAP Credential Store (replace env-fallback secret)

**Status:** todo
**Depends on:** none (Credential Store entitlement approved)
**Unblocks:** Milestone 3 (CloudFront/S3 — the store will also hold the AWS/CloudFront key)

## Context

`SHARED_LINK_SECRET` is currently injected as an app env var via `secrets.mtaext`
(the deferred-Credential-Store validation path). `srv/lib/credstore.js` already
falls back to env when no `credstore` binding exists and **auto-detects** a real
binding when present — so this task is wiring + config only, **no code change**.

The entitled plan on the `gpc-dev-buildcode` subaccount is **`proxy`** (free) —
confirmed via `cf marketplace -e credstore`. The `mta.yaml` comment guesses
`free`; use `proxy`.

## Acceptance criteria

- [ ] Deployed `POST /odata/v4/selftest/checkSecret` returns `source: "credstore"`
      with `secretLen: 64` (currently returns `source: "env"`).
- [ ] No `SHARED_LINK_SECRET` value remains in `secrets.mtaext` or app env.
- [ ] `SHARED_LINK_SECRET` in the store is **byte-identical** to the Python
      `.env` value (else every existing sharing token breaks).
- [ ] Portal still lists documents and `/invoice/:token` still resolves (token
      HMAC unchanged).

## Checklist

### 1. Enable the service in `mta.yaml`
- [ ] Uncomment the `gpc-docdelivery-credstore` **resource** block.
- [ ] Set its `service-plan: proxy` (not `free`).
- [ ] Uncomment the `- name: gpc-docdelivery-credstore` line under the srv
      module `requires`.

### 2. Deploy (creates + binds the instance)
- [ ] `cds up --overlay secrets.mtaext` (keeps the env secret as fallback during
      the transition).

### 3. Create the store entries
> `CREDSTORE_NAMESPACE` defaults to `gpc-document-delivery` (see `credstore.js`).
> The reader expects a `password` entry named `SHARED_LINK_SECRET` and a `key`
> entry named `CloudFrontPrivateKey` under that namespace.
- [ ] `password` → **SHARED_LINK_SECRET** = the 64-char value (mirror of
      `../python/opentext-cdn-prototype/.env`).
- [ ] `key` → **CloudFrontPrivateKey** = contents of
      `../python/opentext-cdn-prototype/secrets/cloudfront_private_key.pem`
      (optional now; required for Milestone 3 — load it in this pass to save a round trip).
- [ ] Create via the BTP cockpit (Credential Store tile) **or** the `cf csv-set-value`
      plugin, e.g.:
      ```bash
      cf csv-set-value <credstore-instance> gpc-document-delivery password SHARED_LINK_SECRET --value '<64-char>'
      cf csv-set-value <credstore-instance> gpc-document-delivery key CloudFrontPrivateKey --value "$(cat ../python/opentext-cdn-prototype/secrets/cloudfront_private_key.pem)"
      ```

### 4. Verify
- [ ] Call `checkSecret` on the deployed app → `source:"credstore"`, `secretLen:64`.
- [ ] Confirm the portal + a `/invoice/:token` round-trip still work.

### 5. Remove the env fallback
- [ ] Delete the `SHARED_LINK_SECRET` line from `secrets.mtaext` (keep
      `OPENTEXT_FOLDER_ID`).
- [ ] Redeploy and re-confirm `checkSecret.source` is still `credstore`.

## References

- `srv/lib/credstore.js` — REST reader (Basic auth + namespace header, JWE decrypt),
  env fallback, `isBound()`.
- `srv/delivery-service.{cds,js}` — `checkSecret` action.
- `README.md` → "Secrets during validation" + "Credential Store" sections.
- `mta.yaml` — commented `gpc-docdelivery-credstore` resource + srv `requires` line.
- Cross-side interop: secret must match Python `token_redirect.py` (ADR 0001 token format).
