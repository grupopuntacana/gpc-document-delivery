import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('credstore (env fallback)', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.SHARED_LINK_SECRET;
  });

  it('reads SHARED_LINK_SECRET from env when no binding is present', async () => {
    process.env.SHARED_LINK_SECRET = 'x'.repeat(64);
    const credstore = require('../srv/lib/credstore.js');
    expect(credstore.isBound()).toBe(false);
    expect(await credstore.getSharedLinkSecret()).toHaveLength(64);
  });

  it('throws a clear error when secret is unavailable', async () => {
    const credstore = require('../srv/lib/credstore.js');
    await expect(credstore.getSharedLinkSecret()).rejects.toThrow(
      /SHARED_LINK_SECRET unavailable/
    );
  });
});

describe('opentext.pingNode', () => {
  const opentext = require('../srv/lib/opentext.js');

  function nodeResponse(name = 'Enterprise') {
    return { status: 200, data: { results: { data: { properties: { name } } } } };
  }

  beforeEach(() => {
    opentext.deps.getDestination = vi.fn(async () => ({
      username: 'Admin',
      password: 'secret',
    }));
    opentext.deps.executeHttpRequest = vi.fn();
  });

  it('sends OTDSTicket on the OTCS call and returns the node title', async () => {
    opentext.deps.executeHttpRequest.mockImplementation(async (_dest, cfg) => {
      if (cfg.method === 'POST') return { status: 200, data: { ticket: 'TICKET-1' } };
      return nodeResponse('Enterprise');
    });

    const result = await opentext.pingNode(2000);

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.nodeTitle).toBe('Enterprise');

    const getCall = opentext.deps.executeHttpRequest.mock.calls.find(
      ([, c]) => c.method === 'GET'
    );
    expect(getCall[1].headers.OTDSTicket).toBe('TICKET-1');
    expect(getCall[1].url).toContain('/nodes/2000');
  });

  it('re-authenticates exactly once on a 401, then succeeds', async () => {
    let getCount = 0;
    let ticketsIssued = 0;
    opentext.deps.executeHttpRequest.mockImplementation(async (_dest, cfg) => {
      if (cfg.method === 'POST') {
        ticketsIssued += 1;
        return { status: 200, data: { ticket: `TICKET-${ticketsIssued}` } };
      }
      getCount += 1;
      if (getCount === 1) {
        const err = new Error('Unauthorized');
        err.response = { status: 401 };
        throw err;
      }
      return nodeResponse('Enterprise');
    });

    const result = await opentext.pingNode(2000);

    expect(result.ok).toBe(true);
    expect(ticketsIssued).toBe(2); // initial + one retry
    expect(getCount).toBe(2);
  });

  it('does not retry on non-401 errors', async () => {
    let getCount = 0;
    opentext.deps.executeHttpRequest.mockImplementation(async (_dest, cfg) => {
      if (cfg.method === 'POST') return { status: 200, data: { ticket: 'T' } };
      getCount += 1;
      const err = new Error('Server error');
      err.response = { status: 500 };
      throw err;
    });

    await expect(opentext.pingNode(2000)).rejects.toThrow();
    expect(getCount).toBe(1); // no retry
  });
});
