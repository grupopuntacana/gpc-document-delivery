import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// SHARED_LINK_SECRET is needed so the service boots (makeToken in documents()); whoami itself
// only reads req.user, but the server must come up.
process.env.SHARED_LINK_SECRET = 'x'.repeat(64);

const cds = require('@sap/cds');

const { GET, axios } = cds.test(process.cwd());

describe('PortalService.whoami', () => {
  it('returns the authenticated user resolved from req.user', async () => {
    axios.defaults.auth = { username: 'alice', password: '' };
    const { data } = await GET('/odata/v4/portal/whoami()');
    // mocked auth has no name/email claims: name falls back to the id, email stays null
    expect(data.id).toBe('alice');
    expect(data.name).toBe('alice');
    expect(data.email ?? null).toBeNull();
  });

  it('requires authentication', async () => {
    delete axios.defaults.auth;
    await expect(GET('/odata/v4/portal/whoami()')).rejects.toMatchObject({
      response: { status: 401 },
    });
  });
});

// Unit-test the claim composition directly — the present-claims (prod IAS) path can't be
// exercised through mocked auth, which has no token claims.
describe('toUserView', () => {
  const { toUserView } = require('../srv/portal-service.js');

  it('joins given/family name and returns email from attr claims', () => {
    expect(toUserView({ id: 'u1', attr: { given_name: 'Ada', family_name: 'Lovelace', email: 'ada@acme.com' } }))
      .toEqual({ id: 'u1', name: 'Ada Lovelace', email: 'ada@acme.com' });
  });

  it('also reads claims exposed at the top level (some CAP setups)', () => {
    expect(toUserView({
      id: 'u2', given_name: 'Grace', family_name: 'Hopper', email: 'grace@acme.com',
    }))
      .toEqual({ id: 'u2', name: 'Grace Hopper', email: 'grace@acme.com' });
  });

  it('falls back to id for name and null for email when no claims are present', () => {
    expect(toUserView({ id: 'alice' })).toEqual({ id: 'alice', name: 'alice', email: null });
  });
});
