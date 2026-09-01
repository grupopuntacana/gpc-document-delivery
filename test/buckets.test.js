import {
  describe, it, expect, beforeEach, afterEach,
} from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const buckets = require('../srv/lib/buckets.js');

// The registry reads OPENTEXT_BUCKETS lazily but memoizes the parse, so drop the memo after
// changing the env (same role as opentext.clearTicketCache / credstore.clearSecretCache in
// the other suites).
function loadWith(bucketsEnv) {
  if (bucketsEnv === undefined) delete process.env.OPENTEXT_BUCKETS;
  else process.env.OPENTEXT_BUCKETS = bucketsEnv;
  buckets.clearRegistryCache();
  return buckets;
}

const TWO_BUCKETS = JSON.stringify({
  invoices: { folderNode: 52480 },
  statements: { folderNode: 52481 },
});

describe('buckets registry', () => {
  const saved = process.env.OPENTEXT_BUCKETS;
  beforeEach(() => {
    delete process.env.OPENTEXT_BUCKETS;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.OPENTEXT_BUCKETS;
    else process.env.OPENTEXT_BUCKETS = saved;
  });

  describe('resolveBucket', () => {
    it('resolves each configured bucket to its own folder node', () => {
      loadWith(TWO_BUCKETS);
      expect(buckets.resolveBucket('invoices').folderNode).toBe(52480);
      expect(buckets.resolveBucket('statements').folderNode).toBe(52481);
    });

    it('coerces a string folderNode to a number (JSON config is hand-edited)', () => {
      loadWith(JSON.stringify({ invoices: { folderNode: '52480' } }));
      expect(buckets.resolveBucket('invoices').folderNode).toBe(52480);
    });

    it('throws UNKNOWN_BUCKET for an unconfigured name', () => {
      loadWith(TWO_BUCKETS);
      expect(() => buckets.resolveBucket('nope')).toThrowError(
        expect.objectContaining({ code: 'UNKNOWN_BUCKET' }),
      );
    });

    it('throws BUCKET_REQUIRED for a missing/empty name (no silent default)', () => {
      // Distinct from UNKNOWN_BUCKET: "you omitted a required field" is a different fix for
      // the caller than "that bucket does not exist", and `unknown bucket: ""` misdirects.
      loadWith(TWO_BUCKETS);
      for (const name of [undefined, null, '', '   ']) {
        expect(() => buckets.resolveBucket(name)).toThrowError(
          expect.objectContaining({ code: 'BUCKET_REQUIRED' }),
        );
      }
    });

    it('the BUCKET_REQUIRED message names the field, not an empty bucket', () => {
      loadWith(TWO_BUCKETS);
      let err;
      try {
        buckets.resolveBucket(undefined);
      } catch (e) {
        err = e;
      }
      expect(err.message).toMatch(/bucket is required/);
      expect(err.message).not.toContain('unknown');
    });

    it('caps a long bucket name in the error message', () => {
      // The name is caller-supplied and echoed into the 400; `bucket` has no length facet
      // in the .cds, so bound the reflection here too.
      loadWith(TWO_BUCKETS);
      let err;
      try {
        buckets.resolveBucket('A'.repeat(5000));
      } catch (e) {
        err = e;
      }
      expect(err.message.length).toBeLessThan(200);
    });

    it('does not leak the configured bucket names into the error message', () => {
      // The message reaches an authenticated caller as a 400; naming the other tenants'
      // buckets would turn a typo into namespace enumeration (0007 adds the write ACL).
      loadWith(TWO_BUCKETS);
      let err;
      try {
        buckets.resolveBucket('nope');
      } catch (e) {
        err = e;
      }
      expect(err.message).not.toContain('statements');
    });

    it('rejects a name matching an Object.prototype key (no prototype pollution)', () => {
      loadWith(TWO_BUCKETS);
      for (const name of ['constructor', 'toString', '__proto__']) {
        expect(() => buckets.resolveBucket(name)).toThrowError(
          expect.objectContaining({ code: 'UNKNOWN_BUCKET' }),
        );
      }
    });

    it('returns a copy so a caller cannot mutate the registry', () => {
      loadWith(TWO_BUCKETS);
      buckets.resolveBucket('invoices').folderNode = 999;
      expect(buckets.resolveBucket('invoices').folderNode).toBe(52480);
    });
  });

  describe('configuration errors', () => {
    it('an unset OPENTEXT_BUCKETS means no bucket resolves', () => {
      loadWith(undefined);
      expect(() => buckets.resolveBucket('invoices')).toThrowError(
        expect.objectContaining({ code: 'UNKNOWN_BUCKET' }),
      );
    });

    it('malformed JSON throws a config error, not UNKNOWN_BUCKET', () => {
      // Must be distinguishable: a bad deploy config is a 500, a bad caller name is a 400.
      loadWith('{not json');
      expect(() => buckets.resolveBucket('invoices')).toThrowError(
        expect.objectContaining({ code: 'BUCKET_CONFIG_INVALID' }),
      );
    });

    it('a bucket entry without a usable folderNode is a config error', () => {
      loadWith(JSON.stringify({ invoices: { folderNode: 'abc' } }));
      expect(() => buckets.resolveBucket('invoices')).toThrowError(
        expect.objectContaining({ code: 'BUCKET_CONFIG_INVALID' }),
      );
    });

    it('rejects a folderNode that only coerces to a number (boolean, array)', () => {
      // Number(true) === 1 and Number([5816]) === 5816 both pass an isInteger check, so a
      // fat-fingered config would silently route documents to the wrong node instead of
      // failing the deploy — the whole point of validating eagerly.
      for (const folderNode of [true, [5816], [], {}]) {
        loadWith(JSON.stringify({ invoices: { folderNode } }));
        expect(() => buckets.resolveBucket('invoices')).toThrowError(
          expect.objectContaining({ code: 'BUCKET_CONFIG_INVALID' }),
        );
      }
    });

    it('accepts a numeric folderNode given as a JSON string', () => {
      // Hand-edited config / mtaext values arrive as strings; those must still work.
      loadWith(JSON.stringify({ invoices: { folderNode: '5816' } }));
      expect(buckets.resolveBucket('invoices').folderNode).toBe(5816);
    });

    it('a non-object JSON payload is a config error', () => {
      loadWith('["invoices"]');
      expect(() => buckets.resolveBucket('invoices')).toThrowError(
        expect.objectContaining({ code: 'BUCKET_CONFIG_INVALID' }),
      );
    });

    it('does not read the env until first use (config errors fail a request, not the boot)', () => {
      // The only test that needs a genuine fresh import — it asserts on what `require`
      // itself does, which clearRegistryCache cannot reproduce.
      process.env.OPENTEXT_BUCKETS = '{not json';
      delete require.cache[require.resolve('../srv/lib/buckets.js')];
      expect(() => require('../srv/lib/buckets.js')).not.toThrow();
    });
  });
});
