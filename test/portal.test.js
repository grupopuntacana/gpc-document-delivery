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
    // mocked hybrid auth has no name/email claims, so they fall back to the id
    expect(data.id).toBe('alice');
    expect(data.name).toBe('alice');
    expect(data.email).toBe('alice');
  });

  it('requires authentication', async () => {
    delete axios.defaults.auth;
    await expect(GET('/odata/v4/portal/whoami()')).rejects.toMatchObject({
      response: { status: 401 },
    });
  });
});
