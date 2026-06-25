import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);

// A throwaway RSA key pair — NEVER the real CloudFront key. PKCS#1 v1.5 + SHA-1 is
// deterministic, so signing a fixed policy is reproducible and cross-checkable.
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' });

describe('cloudfront (canned-policy signing, Python-compatible)', () => {
  let cloudfront;
  beforeEach(() => {
    process.env.CLOUDFRONT_DOMAIN = 'd3ef18l0vjlle9.cloudfront.net';
    process.env.CLOUDFRONT_KEY_PAIR_ID = 'KOZINHBBRK0NV';
    process.env.SIGNED_URL_TTL_SECONDS = '300';
    process.env.CLOUDFRONT_PRIVATE_KEY = PEM;
    delete require.cache[require.resolve('../srv/lib/cloudfront.js')];
    delete require.cache[require.resolve('../srv/lib/credstore.js')];
    cloudfront = require('../srv/lib/cloudfront.js');
    cloudfront.clearKeyCache();
  });
  afterEach(() => {
    delete process.env.CLOUDFRONT_PRIVATE_KEY;
  });

  it('s3Key matches the Python _s3_key layout', () => {
    expect(cloudfront.s3Key(2000)).toBe('documents/2000.pdf');
  });

  it('cannedPolicy is byte-exact (compact, fixed key order)', () => {
    const url = 'https://cdn.example.net/documents/2000.pdf';
    expect(cloudfront.cannedPolicy(url, 1718804000)).toBe(
      `{"Statement":[{"Resource":"${url}","Condition":{"DateLessThan":{"AWS:EpochTime":1718804000}}}]}`
    );
  });

  it('awsBase64 uses the CloudFront alphabet (+->-, =->_, /->~)', () => {
    // Bytes chosen so standard base64 contains +, / and = padding.
    const buf = Buffer.from([0xfb, 0xff, 0xbf, 0xfa]); // base64: "+/+/+g==" -> awsBase64
    expect(cloudfront.awsBase64(buf)).toBe('-~-~-g__');
  });

  it('signCloudFrontUrl: signature is the canned policy signed with RSA-SHA1, AWS-base64', () => {
    const url = 'https://cdn.example.net/documents/2000.pdf';
    const expires = 1718804000;
    const signed = cloudfront.signCloudFrontUrl(url, PEM, 'KEYPAIR-X', expires);

    // Query layout + order matches the Python signer.
    const sep = url.includes('?') ? '&' : '?';
    const expectedPrefix = `${url}${sep}Expires=${expires}&Signature=`;
    expect(signed.startsWith(expectedPrefix)).toBe(true);
    expect(signed.endsWith('&Key-Pair-Id=KEYPAIR-X')).toBe(true);

    // Independent oracle: re-derive the signature WITHOUT going through the module's
    // awsBase64, proving determinism / byte-identity against any other PKCS1v15+SHA1 signer.
    const policy = `{"Statement":[{"Resource":"${url}","Condition":{"DateLessThan":{"AWS:EpochTime":${expires}}}}]}`;
    const raw = crypto.createSign('RSA-SHA1').update(policy).sign(PEM);
    const oracle = raw
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/=/g, '_')
      .replace(/\//g, '~');
    const sigParam = new URL(signed).searchParams.get('Signature');
    // URL parsing turns '~' back fine, but '-'/'_' are safe; compare the raw slice instead.
    const sigSlice = signed.slice(expectedPrefix.length, signed.indexOf('&Key-Pair-Id='));
    expect(sigSlice).toBe(oracle);
    expect(sigParam).not.toBeNull();
  });

  it('round-trips: the signature verifies against the public key', () => {
    const url = 'https://cdn.example.net/documents/2000.pdf';
    const expires = 1718804000;
    const signed = cloudfront.signCloudFrontUrl(url, PEM, 'KP', expires);
    const sigSlice = signed.slice(
      `${url}?Expires=${expires}&Signature=`.length,
      signed.indexOf('&Key-Pair-Id=')
    );
    // Reverse the AWS alphabet back to standard base64 to recover the signature bytes.
    const std = sigSlice.replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/');
    const raw = Buffer.from(std, 'base64');
    const policy = cloudfront.cannedPolicy(url, expires);
    const ok = crypto.createVerify('RSA-SHA1').update(policy).verify(publicKey, raw);
    expect(ok).toBe(true);
  });

  it('signedUrlForNode builds the CDN URL from env and signs with the credstore key', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const url = await cloudfront.signedUrlForNode(2000);
    expect(url.startsWith('https://d3ef18l0vjlle9.cloudfront.net/documents/2000.pdf?Expires=')).toBe(
      true
    );
    expect(url).toContain('&Key-Pair-Id=KOZINHBBRK0NV');
    const expires = Number(new URL(url).searchParams.get('Expires'));
    expect(expires).toBeGreaterThanOrEqual(nowSec + 300 - 2);
    expect(expires).toBeLessThanOrEqual(nowSec + 300 + 2);
  });
});
