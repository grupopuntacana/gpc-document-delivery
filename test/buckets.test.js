import {
  describe, it, expect, beforeEach, afterEach,
} from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// The registry reads OPENTEXT_BUCKETS lazily, but memoizes the parse — so each test
// re-requires the module after setting the env (same pattern as token.test.js).
function loadWith(bucketsEnv) {
  if (bucketsEnv === undefined) delete process.env.OPENTEXT_BUCKETS;
  else process.env.OPENTEXT_BUCKETS = bucketsEnv;
  delete require.cache[require.resolve('../srv/lib/buckets.js')];
  return require('../srv/lib/buckets.js');
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
      const buckets = loadWith(TWO_BUCKETS);
      expect(buckets.resolveBucket('invoices').folderNode).toBe(52480);
      expect(buckets.resolveBucket('statements').folderNode).toBe(52481);
    });

    it('coerces a string folderNode to a number (JSON config is hand-edited)', () => {
      const buckets = loadWith(JSON.stringify({ invoices: { folderNode: '52480' } }));
      expect(buckets.resolveBucket('invoices').folderNode).toBe(52480);
    });

    it('throws UNKNOWN_BUCKET for an unconfigured name', () => {
      const buckets = loadWith(TWO_BUCKETS);
      expect(() => buckets.resolveBucket('nope')).toThrowError(
        expect.objectContaining({ code: 'UNKNOWN_BUCKET' }),
      );
    });

    it('throws UNKNOWN_BUCKET for a missing/empty name (no silent default)', () => {
      const buckets = loadWith(TWO_BUCKETS);
      for (const name of [undefined, null, '', '   ']) {
        expect(() => buckets.resolveBucket(name)).toThrowError(
          expect.objectContaining({ code: 'UNKNOWN_BUCKET' }),
        );
      }
    });

    it('does not leak the configured bucket names into the error message', () => {
      // The message reaches an authenticated caller as a 400; naming the other tenants'
      // buckets would turn a typo into namespace enumeration (0007 adds the write ACL).
      const buckets = loadWith(TWO_BUCKETS);
      let err;
      try {
        buckets.resolveBucket('nope');
      } catch (e) {
        err = e;
      }
      expect(err.message).not.toContain('statements');
    });

    it('rejects a name matching an Object.prototype key (no prototype pollution)', () => {
      const buckets = loadWith(TWO_BUCKETS);
      for (const name of ['constructor', 'toString', '__proto__']) {
        expect(() => buckets.resolveBucket(name)).toThrowError(
          expect.objectContaining({ code: 'UNKNOWN_BUCKET' }),
        );
      }
    });

    it('returns a copy so a caller cannot mutate the registry', () => {
      const buckets = loadWith(TWO_BUCKETS);
      buckets.resolveBucket('invoices').folderNode = 999;
      expect(buckets.resolveBucket('invoices').folderNode).toBe(52480);
    });
  });

  describe('configuration errors', () => {
    it('an unset OPENTEXT_BUCKETS means no bucket resolves', () => {
      const buckets = loadWith(undefined);
      expect(() => buckets.resolveBucket('invoices')).toThrowError(
        expect.objectContaining({ code: 'UNKNOWN_BUCKET' }),
      );
    });

    it('malformed JSON throws a config error, not UNKNOWN_BUCKET', () => {
      // Must be distinguishable: a bad deploy config is a 500, a bad caller name is a 400.
      const buckets = loadWith('{not json');
      expect(() => buckets.resolveBucket('invoices')).toThrowError(
        expect.objectContaining({ code: 'BUCKET_CONFIG_INVALID' }),
      );
    });

    it('a bucket entry without a usable folderNode is a config error', () => {
      const buckets = loadWith(JSON.stringify({ invoices: { folderNode: 'abc' } }));
      expect(() => buckets.resolveBucket('invoices')).toThrowError(
        expect.objectContaining({ code: 'BUCKET_CONFIG_INVALID' }),
      );
    });

    it('a non-object JSON payload is a config error', () => {
      const buckets = loadWith('["invoices"]');
      expect(() => buckets.resolveBucket('invoices')).toThrowError(
        expect.objectContaining({ code: 'BUCKET_CONFIG_INVALID' }),
      );
    });

    it('does not read the env until first use (config errors fail a request, not the boot)', () => {
      process.env.OPENTEXT_BUCKETS = '{not json';
      delete require.cache[require.resolve('../srv/lib/buckets.js')];
      expect(() => require('../srv/lib/buckets.js')).not.toThrow();
    });
  });
});
