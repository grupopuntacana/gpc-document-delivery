import {
  describe, it, expect, beforeEach,
} from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Fixed secret for deterministic cross-side checks (mirrors Python .env value in tests).
const SECRET = 'test-secret-do-not-use-in-prod-0123456789abcdef';

describe('token (HMAC mint/verify, Python-compatible)', () => {
  let token;
  beforeEach(() => {
    process.env.SHARED_LINK_SECRET = SECRET;
    delete require.cache[require.resolve('../srv/lib/token.js')];
    delete require.cache[require.resolve('../srv/lib/credstore.js')];
    token = require('../srv/lib/token.js');
  });

  it('produces compact, sorted-keys JSON exactly like Python json.dumps', () => {
    expect(token.canonicalPayload(2000, 1718804000, null)).toBe('{"e":1718804000,"n":2000}');
    expect(token.canonicalPayload(2000, 1718804000, 'cust-1')).toBe(
      '{"c":"cust-1","e":1718804000,"n":2000}',
    );
  });

  it('round-trips mint -> resolve', async () => {
    const t = await token.makeToken(2000, { ttlDays: 7, customerId: 'cust-1' });
    const payload = await token.resolveToken(t);
    expect(payload.nodeId).toBe(2000);
    expect(payload.customerId).toBe('cust-1');
    expect(payload.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects a tampered signature', async () => {
    const t = await token.makeToken(2000, { ttlDays: 7 });
    const [p] = t.split('.');
    await expect(token.resolveToken(`${p}.AAAA`)).rejects.toThrow(/signature/);
  });

  it('rejects an expired token', async () => {
    const t = await token.makeToken(2000, { ttlDays: -1 });
    await expect(token.resolveToken(t)).rejects.toThrow(/expired/);
  });

  it('rejects malformed input', async () => {
    await expect(token.resolveToken('nodot')).rejects.toThrow(/malformed/);
  });
});
