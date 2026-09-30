'use strict';

/**
 * S3 write-through cache in front of OpenText — CAP port of Python
 * `src/cdn_publisher.py` (`publish`, `invalidate`).
 *
 * Layer 2 of Option B. Architecture invariant (mirrors the Python doc): **S3 is a
 * cache, not a store of record.**
 *   - On a cache miss we fetch the PDF from OpenText and `PutObject` it on the fly.
 *   - Objects carry `cache-only=true` / `source-of-truth=opentext` metadata so nobody
 *     mistakes the bucket for the system of record (a lifecycle policy expires them).
 *   - The bucket is private; callers only ever receive a short-lived CloudFront signed
 *     URL (Layer 1, `cloudfront.js`).
 *
 * Unlike Layer 1, this layer needs AWS credentials (for S3 read/write). They come from
 * the Credential Store via `credstore.getAwsCredentials()`, with an env fallback for
 * local/hybrid runs. The S3 client is built lazily and memoized, and is reachable via
 * the `deps` seam so tests can inject a mock without standing up real AWS.
 */

const LOG = require('@sap/cds').log('cdn');
const credstore = require('./credstore');
const cloudfront = require('./cloudfront');
const opentext = require('./opentext');

function awsRegion() {
  return process.env.AWS_REGION || 'us-east-1';
}
function s3Bucket() {
  const b = process.env.S3_BUCKET || 'opentext-cdn-cache-gpc';
  return b;
}

// Lazily-built, memoized S3 client. Routed through `deps` so unit tests can patch the
// S3 client (and the SDK import) without mocking AWS internals.
const deps = {
  // Resolves to an `@aws-sdk/client-s3` module; overridable in tests.
  loadS3Sdk: () => require('@aws-sdk/client-s3'),
};

let _s3Promise = null;

/**
 * Build (once) and return an S3 client.
 *
 * Credential resolution mirrors the Python prototype's ergonomics. boto3 there is built
 * with NO explicit credentials and resolves them via its default chain — locally that's
 * `AWS_PROFILE` / `~/.aws/credentials`. We do the same: when explicit static keys are
 * available (Credential Store on BTP, or `AWS_ACCESS_KEY_ID`/`_SECRET` env) we pass them;
 * otherwise we omit `credentials` and let the AWS SDK's default provider chain take over
 * (so a developer's `AWS_PROFILE` / shared-credentials file just works, like boto3).
 *
 * On BTP there is no shared-credentials file and no AWS IAM role, so the Credential Store
 * path is the one that actually supplies creds in the deployed app.
 */
async function getS3() {
  if (_s3Promise) return _s3Promise;
  _s3Promise = (async () => {
    const { S3Client } = deps.loadS3Sdk();
    let credentials;
    try {
      const { accessKeyId, secretAccessKey } = await credstore.getAwsCredentials();
      credentials = { accessKeyId, secretAccessKey };
    } catch {
      // No explicit keys (unbound + no env keys) — fall back to the SDK default provider
      // chain (AWS_PROFILE / ~/.aws/credentials / instance role), matching boto3 locally.
      credentials = undefined;
    }
    return new S3Client({ region: awsRegion(), ...(credentials ? { credentials } : {}) });
  })();
  _s3Promise.catch(() => {
    _s3Promise = null;
  });
  return _s3Promise;
}

/** Drop the memoized S3 client (tests / forced refresh after a credential rotation). */
function clearS3Cache() {
  _s3Promise = null;
}

/** True if the object already exists in the cache (HeadObject 200), false on a 404/miss. */
async function objectExists(key) {
  const { HeadObjectCommand } = deps.loadS3Sdk();
  const s3 = await getS3();
  try {
    await s3.send(new HeadObjectCommand({ Bucket: s3Bucket(), Key: key }));
    return true;
  } catch (err) {
    // S3 head returns 404 (or NotFound/NoSuchKey) on a miss; anything else is a real error.
    const code = err && (err.name || (err.$metadata && err.$metadata.httpStatusCode));
    if (
      code === 'NotFound'
      || code === 'NoSuchKey'
      || code === 404
      || (err && err.$metadata && err.$metadata.httpStatusCode === 404)
    ) {
      return false;
    }
    throw err;
  }
}

/**
 * Ensure the node's bytes are in the S3 cache, then return a CloudFront signed URL for it.
 * Mirrors Python `CDNPublisher.publish`: HeadObject -> on miss, download from OpenText
 * and PutObject with cache-only metadata -> sign.
 *
 * Any file type is supported (not just PDF). The real content-type and the stored filename
 * are baked onto the S3 object as `ContentType` / `ContentDisposition`; CloudFront forwards
 * both as response headers, so the browser renders the file inline and "Save As" gets the
 * right name — for this miss and every later cache hit (the object already carries them).
 * The `.pdf` suffix in the S3 key (`cloudfront.s3Key`) is now just a legacy cache-key
 * convention, not a content claim — the headers, not the key, drive what the browser sees.
 * @param {number} nodeId
 * @returns {Promise<string>} a short-lived CloudFront signed URL (cache hit on next call)
 */
async function publish(nodeId) {
  const key = cloudfront.s3Key(nodeId);
  return publishObject({
    key,
    label: `node=${nodeId}`,
    metadata: { 'opentext-node-id': String(nodeId) },
    load: async () => {
      const [{ buffer, contentType, fileName }, originalName] = await Promise.all([
        opentext.downloadDocument(nodeId),
        opentext.getNodeName(nodeId),
      ]);
      // The OTCS node name is the authoritative filename; fall back to the download's
      // Content-Disposition name when the name lookup couldn't read it. Recover the type from
      // that name if the download reported a generic octet-stream (as the stream path does).
      const displayName = originalName || fileName;
      return {
        buffer,
        contentType: opentext.resolveContentType(contentType, displayName),
        fileName: opentext.downloadFileName(nodeId, contentType, displayName),
      };
    },
  });
}

/**
 * The source-agnostic core of `publish` (ADR 0009): HeadObject → on a miss, `load()` the bytes
 * from the system of record and PutObject them with cache-only metadata → sign. `publish(nodeId)`
 * is the OpenText-node flavour; ArchiveLink rows call this directly with their own key + loader.
 *
 * @param {object} args
 * @param {string} args.key         S3 object key
 * @param {string} args.label       log label, e.g. `node=2000` / `archive=C1/0AFF…`
 * @param {object} args.metadata    extra S3 user metadata identifying the source object
 * @param {() => Promise<{buffer:Buffer, contentType:string, fileName:string}>} args.load
 * @param {string} [args.sourceOfTruth] recorded on the object; defaults to `opentext`
 * @returns {Promise<string>} a short-lived CloudFront signed URL
 */
async function publishObject({
  key, label, metadata, load, sourceOfTruth = 'opentext',
}) {
  if (await objectExists(key)) {
    LOG.debug(`cache hit for ${label}`);
  } else {
    LOG.info(`cache miss for ${label} — fetching from ${sourceOfTruth}`);
    const { PutObjectCommand } = deps.loadS3Sdk();
    const s3 = await getS3();
    const { buffer, contentType, fileName } = await load();
    await s3.send(
      new PutObjectCommand({
        Bucket: s3Bucket(),
        Key: key,
        Body: buffer,
        ContentType: contentType,
        ContentDisposition: opentext.contentDisposition(contentType, fileName),
        Metadata: {
          ...metadata,
          // S3 user metadata must be US-ASCII; encode so a non-ASCII name (résumé.pdf) is safe.
          'original-filename': encodeURIComponent(fileName),
          'source-of-truth': sourceOfTruth,
          'cache-only': 'true',
        },
      }),
    );
    LOG.info(`cached ${label} bytes=${buffer.length} type=${contentType} key=${key}`);
  }
  return cloudfront.signedUrlForKey(key);
}

/**
 * Remove a node from the S3 cache (best-effort). CloudFront invalidation is intentionally
 * NOT done here — invalidations are billed and slow, and a short signed-URL TTL plus a
 * lifecycle policy already bound staleness. Kept for parity with Python `invalidate`.
 * @param {number} nodeId
 */
async function invalidate(nodeId) {
  const key = cloudfront.s3Key(nodeId);
  const { DeleteObjectCommand } = deps.loadS3Sdk();
  const s3 = await getS3();
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: s3Bucket(), Key: key }));
    LOG.info(`invalidated cache for node=${nodeId} key=${key}`);
  } catch (err) {
    LOG.warn(`S3 delete failed for ${key}: ${err.message}`);
  }
}

module.exports = {
  publish,
  publishObject,
  invalidate,
  // exported for unit tests
  deps,
  objectExists,
  getS3,
  clearS3Cache,
  awsRegion,
  s3Bucket,
};
