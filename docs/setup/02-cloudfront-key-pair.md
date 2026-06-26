Bucket is good. **Step 2 — CloudFront signing key pair.**

CloudFront signed URLs need an RSA-2048 keypair: private key stays with the app, public key goes to CloudFront via a Public Key + Key Group.

Generate the keypair locally (private key path is already in `.gitignore` via `*.pem`):

```bash
mkdir -p secrets
openssl genrsa -out secrets/cloudfront_private_key.pem 2048
openssl rsa -pubout -in secrets/cloudfront_private_key.pem -out secrets/cloudfront_public_key.pem
chmod 600 secrets/cloudfront_private_key.pem
```

Upload the public key to CloudFront. The `CallerReference` just needs to be unique:

```bash
aws cloudfront create-public-key --public-key-config "{
  \"CallerReference\": \"opentext-cdn-$(date +%s)\",
  \"Name\": \"opentext-cdn-signing-key\",
  \"EncodedKey\": \"$(cat secrets/cloudfront_public_key.pem | awk '{printf "%s\\n", $0}')\",
  \"Comment\": \"Signs URLs for the OpenText CDN prototype\"
}"
```

Capture the returned `Id` (looks like `K1ABC...`) — that's the value that goes into the URL as `Key-Pair-Id`. Save it as a shell var:

```bash
export PUBLIC_KEY_ID=<Id from the response>
```

Create a Key Group containing that public key (distributions trust key groups, not individual keys):

```bash
aws cloudfront create-key-group --key-group-config "{
  \"Name\": \"opentext-cdn-key-group\",
  \"Items\": [\"$PUBLIC_KEY_ID\"],
  \"Comment\": \"Trusted signers for opentext-cdn distribution\"
}"
```

Capture the returned key group `Id` too:

```bash
export KEY_GROUP_ID=<Id from the response>
```

Verify:

```bash
aws cloudfront get-public-key --id "$PUBLIC_KEY_ID" --query 'PublicKey.PublicKeyConfig.Name'
aws cloudfront get-key-group --id "$KEY_GROUP_ID" --query 'KeyGroup.KeyGroupConfig.Items'
```

Paste back the `Id`s from `create-public-key` and `create-key-group` (or any errors). Next step (3) is the Origin Access Control + the distribution itself.

---

> **Origin:** Imported from the OpenText CDN Python prototype (`opentext-cdn-prototype`). This is the consolidated, self-contained copy — the prototype repo is archival. Benchmark/latency figures are from the prototype's May 2026 measurement run and have not been re-measured against the CAP implementation. See [docs/README.md → Origins & related work](../README.md#origins-and-related-work) for the prototype's role.
