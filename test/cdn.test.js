import {
  describe, it, expect, beforeEach, vi,
} from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);

// Throwaway signing key so publish() can produce a real signed URL without the real key.
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' });

// Minimal fake @aws-sdk/client-s3: command classes tag themselves; the client's send()
// records calls and dispatches on the tag. head() is overridable per test.
function fakeSdk(sent, headBehavior) {
  class Cmd {
    constructor(input) {
      this.input = input;
    }
  }
  class HeadObjectCommand extends Cmd {
    get _t() {
      return 'head';
    }
  }
  class PutObjectCommand extends Cmd {
    get _t() {
      return 'put';
    }
  }
  class DeleteObjectCommand extends Cmd {
    get _t() {
      return 'delete';
    }
  }
  class S3Client {
    constructor(cfg) {
      this.cfg = cfg;
    }

    async send(cmd) {
      sent.push({ type: cmd._t, input: cmd.input });
      if (cmd._t === 'head') return headBehavior();
      return {};
    }
  }
  return {
    S3Client, HeadObjectCommand, PutObjectCommand, DeleteObjectCommand,
  };
}

function notFound() {
  const err = new Error('Not Found');
  err.name = 'NotFound';
  err.$metadata = { httpStatusCode: 404 };
  throw err;
}

describe('cdn (S3 write-through cache)', () => {
  let cdn;
  let cloudfront;
  let opentext;
  let sent;

  beforeEach(() => {
    process.env.AWS_REGION = 'us-east-1';
    process.env.S3_BUCKET = 'opentext-cdn-cache-gpc';
    process.env.AWS_ACCESS_KEY_ID = 'AKIA-TEST';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret-test';
    process.env.CLOUDFRONT_DOMAIN = 'd3ef18l0vjlle9.cloudfront.net';
    process.env.CLOUDFRONT_KEY_PAIR_ID = 'KOZINHBBRK0NV';
    process.env.CLOUDFRONT_PRIVATE_KEY = PEM;

    for (const m of ['cdn', 'cloudfront', 'credstore', 'opentext']) {
      delete require.cache[require.resolve(`../srv/lib/${m}.js`)];
    }
    cdn = require('../srv/lib/cdn.js');
    cloudfront = require('../srv/lib/cloudfront.js');
    opentext = require('../srv/lib/opentext.js');
    cloudfront.clearKeyCache();
    cdn.clearS3Cache();
    sent = [];

    opentext.downloadDocument = vi.fn(async () => ({
      buffer: Buffer.from('%PDF-1.7 fake'),
      contentType: 'application/pdf',
      fileName: 'factura-01.pdf',
    }));
    opentext.getNodeName = vi.fn(async () => 'factura-01.pdf');
  });

  it('cache MISS: downloads from OpenText, PutObject with cache-only metadata, returns signed URL', async () => {
    cdn.deps.loadS3Sdk = () => fakeSdk(sent, notFound);

    const url = await cdn.publish(2000);

    const head = sent.find((c) => c.type === 'head');
    const put = sent.find((c) => c.type === 'put');
    expect(head.input).toMatchObject({ Bucket: 'opentext-cdn-cache-gpc', Key: 'documents/2000.pdf' });
    expect(opentext.downloadDocument).toHaveBeenCalledWith(2000);
    expect(put.input).toMatchObject({
      Bucket: 'opentext-cdn-cache-gpc',
      Key: 'documents/2000.pdf',
      ContentType: 'application/pdf',
      ContentDisposition: 'inline; filename="factura-01.pdf"',
      Metadata: {
        'opentext-node-id': '2000',
        'original-filename': 'factura-01.pdf',
        'source-of-truth': 'opentext',
        'cache-only': 'true',
      },
    });
    expect(url).toContain('https://d3ef18l0vjlle9.cloudfront.net/documents/2000.pdf?Expires=');
    expect(url).toContain('&Key-Pair-Id=KOZINHBBRK0NV');
  });

  it('cache MISS: a non-PDF (camera photo) is cached with its real type + filename', async () => {
    cdn.deps.loadS3Sdk = () => fakeSdk(sent, notFound);
    // OTCS reports a generic type but the node name carries the real extension — the cdn
    // path must recover the content-type so CloudFront serves it as an image, not a PDF.
    opentext.downloadDocument = vi.fn(async () => ({
      buffer: Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]),
      contentType: 'application/octet-stream',
      fileName: null,
    }));
    opentext.getNodeName = vi.fn(async () => 'rambo-thumbs-up.png');

    await cdn.publish(172488);

    const put = sent.find((c) => c.type === 'put');
    expect(put.input).toMatchObject({
      ContentType: 'image/png',
      ContentDisposition: 'inline; filename="rambo-thumbs-up.png"',
    });
  });

  it('cache HIT: skips download + PutObject, still returns a signed URL', async () => {
    cdn.deps.loadS3Sdk = () => fakeSdk(sent, () => ({ ContentLength: 123 }));

    const url = await cdn.publish(2000);

    expect(sent.some((c) => c.type === 'head')).toBe(true);
    expect(sent.some((c) => c.type === 'put')).toBe(false);
    expect(opentext.downloadDocument).not.toHaveBeenCalled();
    expect(url).toContain('/documents/2000.pdf?Expires=');
  });

  it('objectExists rethrows non-404 errors (does not swallow real failures)', async () => {
    cdn.deps.loadS3Sdk = () => fakeSdk(sent, () => {
      const err = new Error('AccessDenied');
      err.name = 'AccessDenied';
      err.$metadata = { httpStatusCode: 403 };
      throw err;
    });
    await expect(cdn.publish(2000)).rejects.toThrow(/AccessDenied/);
  });

  it('falls back to the SDK default provider chain when no static keys are configured', async () => {
    // No Credential Store binding and no env keys -> like boto3 with only AWS_PROFILE.
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    require('../srv/lib/credstore.js').clearAwsCache();
    cdn.clearS3Cache();

    let builtWith;
    cdn.deps.loadS3Sdk = () => {
      const sdk = fakeSdk(sent, () => ({ ContentLength: 1 }));
      const RealClient = sdk.S3Client;
      sdk.S3Client = class extends RealClient {
        constructor(cfg) {
          super(cfg);
          builtWith = cfg;
        }
      };
      return sdk;
    };

    await cdn.publish(2000); // cache hit; just exercises client construction
    expect(builtWith.region).toBe('us-east-1');
    // credentials omitted -> SDK resolves them itself (profile / role / env).
    expect(builtWith.credentials).toBeUndefined();
  });

  it('invalidate issues a DeleteObject for the node key', async () => {
    cdn.deps.loadS3Sdk = () => fakeSdk(sent, () => ({}));
    await cdn.invalidate(2000);
    const del = sent.find((c) => c.type === 'delete');
    expect(del.input).toMatchObject({ Bucket: 'opentext-cdn-cache-gpc', Key: 'documents/2000.pdf' });
  });
});
