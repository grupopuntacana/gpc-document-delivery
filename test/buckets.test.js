import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const buckets = require('../srv/lib/buckets.js');
const opentext = require('../srv/lib/opentext.js');

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
    it('resolves each configured bucket to its own folder node', async () => {
      loadWith(TWO_BUCKETS);
      expect((await buckets.resolveBucket('invoices')).folderNode).toBe(52480);
      expect((await buckets.resolveBucket('statements')).folderNode).toBe(52481);
    });

    it('coerces a string folderNode to a number (JSON config is hand-edited)', async () => {
      loadWith(JSON.stringify({ invoices: { folderNode: '52480' } }));
      expect((await buckets.resolveBucket('invoices')).folderNode).toBe(52480);
    });

    it('throws UNKNOWN_BUCKET for an unconfigured name', async () => {
      loadWith(TWO_BUCKETS);
      await expect(buckets.resolveBucket('nope')).rejects.toThrowError(
        expect.objectContaining({ code: 'UNKNOWN_BUCKET' }),
      );
    });

    it('throws BUCKET_REQUIRED for a missing/empty name (no silent default)', async () => {
      // Distinct from UNKNOWN_BUCKET: "you omitted a required field" is a different fix for
      // the caller than "that bucket does not exist", and `unknown bucket: ""` misdirects.
      loadWith(TWO_BUCKETS);
      await Promise.all([undefined, null, '', '   '].map((name) => expect(
        buckets.resolveBucket(name),
      ).rejects.toThrowError(expect.objectContaining({ code: 'BUCKET_REQUIRED' }))));
    });

    it('the BUCKET_REQUIRED message names the field, not an empty bucket', async () => {
      loadWith(TWO_BUCKETS);
      let err;
      try {
        await buckets.resolveBucket(undefined);
      } catch (e) {
        err = e;
      }
      expect(err.message).toMatch(/bucket is required/);
      expect(err.message).not.toContain('unknown');
    });

    it('caps a long bucket name in the error message', async () => {
      // The name is caller-supplied and echoed into the 400; `bucket` has no length facet
      // in the .cds, so bound the reflection here too.
      loadWith(TWO_BUCKETS);
      let err;
      try {
        await buckets.resolveBucket('A'.repeat(5000));
      } catch (e) {
        err = e;
      }
      expect(err.message.length).toBeLessThan(200);
    });

    it('does not leak the configured bucket names into the error message', async () => {
      // The message reaches an authenticated caller as a 400; naming the other tenants'
      // buckets would turn a typo into namespace enumeration (0007 adds the write ACL).
      loadWith(TWO_BUCKETS);
      let err;
      try {
        await buckets.resolveBucket('nope');
      } catch (e) {
        err = e;
      }
      expect(err.message).not.toContain('statements');
    });

    it('rejects a name matching an Object.prototype key (no prototype pollution)', async () => {
      loadWith(TWO_BUCKETS);
      await Promise.all(['constructor', 'toString', '__proto__'].map((name) => expect(
        buckets.resolveBucket(name),
      ).rejects.toThrowError(expect.objectContaining({ code: 'UNKNOWN_BUCKET' }))));
    });

    it('returns a copy so a caller cannot mutate the registry', async () => {
      loadWith(TWO_BUCKETS);
      (await buckets.resolveBucket('invoices')).folderNode = 999;
      expect((await buckets.resolveBucket('invoices')).folderNode).toBe(52480);
    });
  });

  describe('self-provisioned buckets (0006)', () => {
    // The registry calls opentext.findOrCreateFolder for a { parentNode, folderName } entry.
    // Stub it directly: what matters here is the registry's contract (resolve once, memoize,
    // tag failures) — the OTCS call itself is covered in test/selftest.test.js.
    const SELF_PROV = JSON.stringify({
      statements: { parentNode: 5816, folderName: 'statements' },
    });
    let spy;

    beforeEach(() => {
      spy = vi.spyOn(opentext, 'findOrCreateFolder');
    });
    afterEach(() => {
      spy.mockRestore();
    });

    it('resolves parentNode + folderName to the folder id find-or-create returns', async () => {
      spy.mockResolvedValue(77001);
      loadWith(SELF_PROV);
      expect((await buckets.resolveBucket('statements')).folderNode).toBe(77001);
      expect(spy).toHaveBeenCalledWith(5816, 'statements');
    });

    it('memoizes the resolved id — a second resolve makes no OpenText call', async () => {
      // AC-2: two uploads to the same bucket must produce exactly one folder create.
      spy.mockResolvedValue(77002);
      loadWith(SELF_PROV);
      await buckets.resolveBucket('statements');
      await buckets.resolveBucket('statements');
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('shares one find-or-create across a concurrent burst on a cold bucket', async () => {
      // The promise is cached before the await, so parallel first-uploads cannot both create.
      spy.mockResolvedValue(77003);
      loadWith(SELF_PROV);
      const all = await Promise.all([
        buckets.resolveBucket('statements'),
        buckets.resolveBucket('statements'),
        buckets.resolveBucket('statements'),
      ]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(all.map((r) => r.folderNode)).toEqual([77003, 77003, 77003]);
    });

    it('tags a find-or-create failure FOLDER_PROVISION_FAILED (502, not a 500)', async () => {
      // Any upstream failure — refused create, dead tunnel, same-named non-folder — is
      // OpenText's, not our config's, so the handler must not blame the deployment.
      spy.mockRejectedValue(new Error('OTCS said no'));
      loadWith(SELF_PROV);
      await expect(buckets.resolveBucket('statements')).rejects.toThrowError(
        expect.objectContaining({ code: 'FOLDER_PROVISION_FAILED' }),
      );
    });

    it('keeps the underlying failure as `cause` so describeError can report it', async () => {
      const cause = new Error('OTCS said no');
      spy.mockRejectedValue(cause);
      loadWith(SELF_PROV);
      const err = await buckets.resolveBucket('statements').catch((e) => e);
      expect(err.cause).toBe(cause);
      expect(opentext.describeError(err)).toContain('OTCS said no');
    });

    it('does not cache a failure — the next upload retries', async () => {
      loadWith(SELF_PROV);
      spy.mockRejectedValueOnce(new Error('transient'));
      await buckets.resolveBucket('statements').catch(() => {});
      spy.mockResolvedValue(77004);
      expect((await buckets.resolveBucket('statements')).folderNode).toBe(77004);
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('a folderNode bucket never touches OpenText', async () => {
      loadWith(TWO_BUCKETS);
      await buckets.resolveBucket('invoices');
      expect(spy).not.toHaveBeenCalled();
    });

    it('clearRegistryCache drops the memoized folder id', async () => {
      spy.mockResolvedValue(77005);
      loadWith(SELF_PROV);
      await buckets.resolveBucket('statements');
      loadWith(SELF_PROV);
      await buckets.resolveBucket('statements');
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });

  describe('configuration errors', () => {
    it('an unset OPENTEXT_BUCKETS means no bucket resolves', async () => {
      loadWith(undefined);
      await expect(buckets.resolveBucket('invoices')).rejects.toThrowError(
        expect.objectContaining({ code: 'UNKNOWN_BUCKET' }),
      );
    });

    it('malformed JSON throws a config error, not UNKNOWN_BUCKET', async () => {
      // Must be distinguishable: a bad deploy config is a 500, a bad caller name is a 400.
      loadWith('{not json');
      await expect(buckets.resolveBucket('invoices')).rejects.toThrowError(
        expect.objectContaining({ code: 'BUCKET_CONFIG_INVALID' }),
      );
    });

    it('a bucket entry without a usable folderNode is a config error', async () => {
      loadWith(JSON.stringify({ invoices: { folderNode: 'abc' } }));
      await expect(buckets.resolveBucket('invoices')).rejects.toThrowError(
        expect.objectContaining({ code: 'BUCKET_CONFIG_INVALID' }),
      );
    });

    it('rejects a folderNode that only coerces to a number (boolean, array)', async () => {
      // Number(true) === 1 and Number([5816]) === 5816 both pass an isInteger check, so a
      // fat-fingered config would silently route documents to the wrong node instead of
      // failing the deploy — the whole point of validating eagerly.
      // Sequential on purpose: each case re-loads the env, so these cannot overlap.
      for (const folderNode of [true, [5816], [], {}]) {
        loadWith(JSON.stringify({ invoices: { folderNode } }));
        // eslint-disable-next-line no-await-in-loop
        await expect(buckets.resolveBucket('invoices')).rejects.toThrowError(
          expect.objectContaining({ code: 'BUCKET_CONFIG_INVALID' }),
        );
      }
    });

    it('accepts a numeric folderNode given as a JSON string', async () => {
      // Hand-edited config / mtaext values arrive as strings; those must still work.
      loadWith(JSON.stringify({ invoices: { folderNode: '5816' } }));
      expect((await buckets.resolveBucket('invoices')).folderNode).toBe(5816);
    });

    it('a non-object JSON payload is a config error', async () => {
      loadWith('["invoices"]');
      await expect(buckets.resolveBucket('invoices')).rejects.toThrowError(
        expect.objectContaining({ code: 'BUCKET_CONFIG_INVALID' }),
      );
    });

    it('does not read the env until first use (config errors fail a request, not the boot)', async () => {
      // The only test that needs a genuine fresh import — it asserts on what `require`
      // itself does, which clearRegistryCache cannot reproduce.
      process.env.OPENTEXT_BUCKETS = '{not json';
      delete require.cache[require.resolve('../srv/lib/buckets.js')];
      expect(() => require('../srv/lib/buckets.js')).not.toThrow();
    });
  });

  describe('writer ACL (0007)', () => {
    const ACL_BUCKETS = JSON.stringify({
      invoices: { folderNode: 52480, allowedWriters: ['app-a'] },
      statements: { folderNode: 52481, allowedWriters: ['app-b', 'app-a'] },
      orphan: { folderNode: 52482 },
      revoked: { folderNode: 52483, allowedWriters: [] },
    });

    it('grants a bucket only to its listed writers', () => {
      const b = loadWith(ACL_BUCKETS);
      expect(b.mayWrite('app-a', 'invoices')).toBe(true);
      expect(b.mayWrite('app-b', 'invoices')).toBe(false);
    });

    it('grants a bucket to every writer it lists', () => {
      const b = loadWith(ACL_BUCKETS);
      expect(b.mayWrite('app-a', 'statements')).toBe(true);
      expect(b.mayWrite('app-b', 'statements')).toBe(true);
    });

    it('a bucket with no allowedWriters accepts NO writer (never open by default)', () => {
      // The guard against the failure mode this slice exists to prevent: an un-granted
      // bucket must not be writable by anyone, including an app granted elsewhere.
      const b = loadWith(ACL_BUCKETS);
      expect(b.mayWrite('app-a', 'orphan')).toBe(false);
      expect(b.mayWrite('app-b', 'orphan')).toBe(false);
    });

    it('an explicitly empty allowedWriters is un-writable, not a config error', () => {
      // Revoking every writer is a legitimate operator intent; it must not 500.
      const b = loadWith(ACL_BUCKETS);
      expect(() => b.mayWrite('app-a', 'revoked')).not.toThrow();
      expect(b.mayWrite('app-a', 'revoked')).toBe(false);
    });

    it('denies an absent azp (DoD-2: provenance must be present)', () => {
      const b = loadWith(ACL_BUCKETS);
      ['', '   ', undefined, null, 0, {}].forEach((azp) => {
        expect(b.mayWrite(azp, 'invoices')).toBe(false);
      });
    });

    it('denies an unknown bucket without throwing (the predicate is total)', () => {
      const b = loadWith(ACL_BUCKETS);
      expect(b.mayWrite('app-a', 'no-such-bucket')).toBe(false);
      expect(b.mayWrite('app-a', '')).toBe(false);
      expect(b.mayWrite('app-a', undefined)).toBe(false);
    });

    it('treats prototype keys as ordinary misses', () => {
      const b = loadWith(ACL_BUCKETS);
      expect(b.mayWrite('app-a', 'constructor')).toBe(false);
      expect(b.mayWrite('app-a', '__proto__')).toBe(false);
    });

    it('matches the azp exactly, case-sensitively (client ids are)', () => {
      const b = loadWith(ACL_BUCKETS);
      expect(b.mayWrite('app-a ', 'invoices')).toBe(true); // trimmed
      expect(b.mayWrite(' app-a', 'invoices')).toBe(true);
      expect(b.mayWrite('app-', 'invoices')).toBe(false); // no prefix match
      expect(b.mayWrite('app-aa', 'invoices')).toBe(false);
      expect(b.mayWrite('APP-A', 'invoices')).toBe(false); // no case folding
    });

    it('de-duplicates a repeated writer without complaining', () => {
      const b = loadWith(JSON.stringify({
        invoices: { folderNode: 52480, allowedWriters: ['app-a', 'app-a'] },
      }));
      expect(b.mayWrite('app-a', 'invoices')).toBe(true);
    });

    it('coexists with parentNode + folderName without tripping the "not both" check', () => {
      const b = loadWith(JSON.stringify({
        archive: { parentNode: 5816, folderName: 'archive', allowedWriters: ['app-a'] },
      }));
      expect(b.mayWrite('app-a', 'archive')).toBe(true);
      expect(b.mayWrite('app-b', 'archive')).toBe(false);
    });

    it('never touches OpenText, even for a self-provisioned bucket', () => {
      // What makes "no folder is touched on a denied write" structural rather than a matter
      // of statement ordering in the handler.
      const spy = vi.spyOn(opentext, 'findOrCreateFolder');
      try {
        const b = loadWith(JSON.stringify({
          archive: { parentNode: 5816, folderName: 'archive', allowedWriters: ['app-a'] },
        }));
        expect(b.mayWrite('app-a', 'archive')).toBe(true);
        expect(b.mayWrite('app-b', 'archive')).toBe(false);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it('rejects a malformed allowedWriters as a config error', () => {
      const bad = ['app-a', {}, 123, true, ['app-a', null], ['app-a', ''], ['   '], [42]];
      bad.forEach((allowedWriters) => {
        const b = loadWith(JSON.stringify({ invoices: { folderNode: 52480, allowedWriters } }));
        expect(() => b.mayWrite('app-a', 'invoices')).toThrow(/allowedWriters/);
      });
    });

    it('does not expose allowedWriters through resolveBucket', async () => {
      // resolveBucket hands out a fresh object; leaking the live Set would let a caller
      // mutate the registry.
      const b = loadWith(ACL_BUCKETS);
      const resolved = await b.resolveBucket('invoices');
      expect(resolved).toEqual({ folderNode: 52480 });
      expect(resolved.allowedWriters).toBeUndefined();
    });
  });
});
