**Step 1 — Private S3 bucket as CloudFront origin.**

Set vars (edit `BUCKET` if you want a different name; S3 bucket names are global):

```bash
export AWS_PROFILE=gpc
export REGION=us-east-1
export BUCKET=opentext-cdn-cache-gpc
```

Create the bucket (the `LocationConstraint` arg is omitted for `us-east-1` — if you use any other region, add `--create-bucket-configuration LocationConstraint=$REGION`):

```bash
aws s3api create-bucket --bucket "$BUCKET" --region "$REGION"
```

Block all public access (CloudFront will reach it privately via OAC):

```bash
aws s3api put-public-access-block \
  --bucket "$BUCKET" \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
```

Default SSE-S3 encryption:

```bash
aws s3api put-bucket-encryption \
  --bucket "$BUCKET" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
```

30-day lifecycle (delete cached objects under `documents/`):

```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket "$BUCKET" \
  --lifecycle-configuration '{
    "Rules":[{
      "ID":"expire-cached-pdfs",
      "Status":"Enabled",
      "Filter":{"Prefix":"documents/"},
      "Expiration":{"Days":30}
    }]
  }'
```

Tag the bucket to make the "cache, not source of truth" intent explicit:

```bash
aws s3api put-bucket-tagging \
  --bucket "$BUCKET" \
  --tagging 'TagSet=[
    {Key=role,Value=cache-only},
    {Key=source-of-truth,Value=opentext},
    {Key=project,Value=opentext-cdn-prototype}
  ]'
```

Verify:

```bash
aws s3api get-bucket-location --bucket "$BUCKET"
aws s3api get-bucket-tagging --bucket "$BUCKET"
aws s3api get-bucket-lifecycle-configuration --bucket "$BUCKET"
```

Paste back the verify output (or any errors) and I'll send Step 2 (CloudFront key pair).

---

> **Origin:** Imported from the OpenText CDN Python prototype (`opentext-cdn-prototype`). This is the consolidated, self-contained copy — the prototype repo is archival. Benchmark/latency figures are from the prototype's May 2026 measurement run and have not been re-measured against the CAP implementation. See [docs/README.md → Origins & related work](../README.md#origins-and-related-work) for the prototype's role.
