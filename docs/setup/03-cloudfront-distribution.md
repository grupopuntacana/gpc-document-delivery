**Step 3 — Origin Access Control + CloudFront distribution + bucket policy.**

First, create an Origin Access Control (modern replacement for OAI — CloudFront uses this to authenticate to the private bucket):

```bash
aws cloudfront create-origin-access-control --origin-access-control-config '{
  "Name": "opentext-cdn-oac",
  "Description": "OAC for OpenText CDN prototype bucket",
  "SigningProtocol": "sigv4",
  "SigningBehavior": "always",
  "OriginAccessControlOriginType": "s3"
}'
```

Capture the returned `Id` (looks like `E1ABC...`):

```bash
export OAC_ID=<Id from the response>
```

Confirm the bucket variables are still set in your shell (they may not survive a new terminal):

```bash
export AWS_PROFILE=gpc
export BUCKET=opentext-cdn-cache-gpc
export REGION=us-east-1
# also: PUBLIC_KEY_ID, KEY_GROUP_ID, OAC_ID from earlier steps
echo "$BUCKET / $PUBLIC_KEY_ID / $KEY_GROUP_ID / $OAC_ID"
```

Write the distribution config to a file (easier to read than inline JSON):

```bash
cat > /tmp/cf-dist.json <<EOF
{
  "CallerReference": "opentext-cdn-$(date +%s)",
  "Comment": "OpenText CDN prototype",
  "Enabled": true,
  "PriceClass": "PriceClass_100",
  "Origins": {
    "Quantity": 1,
    "Items": [{
      "Id": "s3-origin",
      "DomainName": "${BUCKET}.s3.${REGION}.amazonaws.com",
      "S3OriginConfig": {"OriginAccessIdentity": ""},
      "OriginAccessControlId": "${OAC_ID}",
      "CustomHeaders": {"Quantity": 0},
      "ConnectionAttempts": 3,
      "ConnectionTimeout": 10,
      "OriginShield": {"Enabled": false}
    }]
  },
  "DefaultCacheBehavior": {
    "TargetOriginId": "s3-origin",
    "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": {
      "Quantity": 2,
      "Items": ["GET", "HEAD"],
      "CachedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]}
    },
    "Compress": true,
    "CachePolicyId": "658327ea-f89d-4fab-a63d-7e88639e58f6",
    "TrustedKeyGroups": {
      "Enabled": true,
      "Quantity": 1,
      "Items": ["${KEY_GROUP_ID}"]
    },
    "SmoothStreaming": false,
    "FieldLevelEncryptionId": ""
  },
  "ViewerCertificate": {"CloudFrontDefaultCertificate": true},
  "HttpVersion": "http2",
  "IsIPV6Enabled": true
}
EOF
```

(`658327ea-f89d-4fab-a63d-7e88639e58f6` is AWS's managed `CachingOptimized` cache policy id — universal, you don't need to create one.)

Create the distribution:

```bash
aws cloudfront create-distribution --distribution-config file:///tmp/cf-dist.json
```

Capture the response — you need three values:

```bash
export DISTRIBUTION_ID=<.Distribution.Id, e.g. E1XYZ...>
export DISTRIBUTION_DOMAIN=<.Distribution.DomainName, e.g. d1234.cloudfront.net>
export DISTRIBUTION_ARN=<.Distribution.ARN, e.g. arn:aws:cloudfront::ACCT:distribution/E1XYZ...>
```

(Or pull them in one shot with `--query`:)

```bash
aws cloudfront get-distribution --id "$DISTRIBUTION_ID" \
  --query '{Id:Distribution.Id,Domain:Distribution.DomainName,Arn:Distribution.ARN,Status:Distribution.Status}'
```

Now attach the bucket policy granting CloudFront's service principal `GetObject`, scoped to this specific distribution by `AWS:SourceArn`:

```bash
cat > /tmp/bucket-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowCloudFrontServicePrincipal",
    "Effect": "Allow",
    "Principal": {"Service": "cloudfront.amazonaws.com"},
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::${BUCKET}/*",
    "Condition": {
      "StringEquals": {"AWS:SourceArn": "${DISTRIBUTION_ARN}"}
    }
  }]
}
EOF
aws s3api put-bucket-policy --bucket "$BUCKET" --policy file:///tmp/bucket-policy.json
```

Verify the policy is attached:

```bash
aws s3api get-bucket-policy --bucket "$BUCKET" --query Policy --output text | python3 -m json.tool
```

The distribution will be in `InProgress` for ~5–15 minutes before flipping to `Deployed`. You don't have to wait — paste back the create response (or just `DISTRIBUTION_ID` / `DISTRIBUTION_DOMAIN`) and any errors, and I'll send Step 4 (filling in `.env` and running a live end-to-end test).

---

> **Origin:** Imported from the OpenText CDN Python prototype (`opentext-cdn-prototype`). This is the consolidated, self-contained copy — the prototype repo is archival. Benchmark/latency figures are from the prototype's May 2026 measurement run and have not been re-measured against the CAP implementation. See [docs/README.md → Origins & related work](../README.md#origins-and-related-work) for the prototype's role.
