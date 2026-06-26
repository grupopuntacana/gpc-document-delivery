import {
  describe, it, expect, vi, beforeEach,
} from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('credstore (env fallback)', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.SHARED_LINK_SECRET;
    // The secret is cached in-memory; clear it so each case starts cold
    // (vi.resetModules doesn't reset the CommonJS instance from createRequire).
    require('../srv/lib/credstore.js').clearSecretCache();
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
      /SHARED_LINK_SECRET unavailable/,
    );
  });
});

describe('opentext.pingNode', () => {
  const opentext = require('../srv/lib/opentext.js');

  function nodeResponse(name = 'Enterprise') {
    return { status: 200, data: { results: { data: { properties: { name } } } } };
  }

  beforeEach(() => {
    // The OTDS ticket is cached in-memory across requests; clear it so each case
    // starts cold and its authenticate() expectations hold.
    opentext.clearTicketCache();
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
      ([, c]) => c.method === 'GET',
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

  it('reuses the cached OTDS ticket across requests (authenticates once)', async () => {
    let ticketsIssued = 0;
    opentext.deps.executeHttpRequest.mockImplementation(async (_dest, cfg) => {
      if (cfg.method === 'POST') {
        ticketsIssued += 1;
        return { status: 200, data: { ticket: `TICKET-${ticketsIssued}` } };
      }
      return nodeResponse('Enterprise');
    });

    const a = await opentext.pingNode(2000);
    const b = await opentext.pingNode(2000);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(ticketsIssued).toBe(1); // second listing reused the cached ticket
  });

  it('listFolder requests only the needed fields and keeps only documents', async () => {
    opentext.deps.executeHttpRequest.mockImplementation(async (_dest, cfg) => {
      if (cfg.method === 'POST') return { status: 200, data: { ticket: 'T' } };
      return {
        status: 200,
        data: {
          results: [
            {
              data: {
                properties: {
                  id: 1, name: 'factura-01.pdf', type: 144, size: 2048,
                },
              },
            },
            {
              data: {
                properties: {
                  id: 2, name: 'a-subfolder', type: 0, size: 0,
                },
              },
            }, // not a doc
          ],
        },
      };
    });

    const docs = await opentext.listFolder(52480);

    // server-side field trim is requested on the OTCS list call
    const getCall = opentext.deps.executeHttpRequest.mock.calls.find(([, c]) => c.method === 'GET');
    expect(getCall[1].url).toContain('/nodes/52480/nodes?fields=');
    expect(decodeURIComponent(getCall[1].url)).toContain('properties{id,name,type,size}');

    // only the type-144 document survives, shaped for the portal
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      nodeId: 1, name: 'factura-01.pdf', sizeBytes: 2048, category: 'invoice',
    });
  });
});

describe('opentext.uploadDocument', () => {
  const opentext = require('../srv/lib/opentext.js');

  beforeEach(() => {
    opentext.clearTicketCache();
    opentext.deps.getDestination = vi.fn(async () => ({ username: 'Admin', password: 'secret' }));
    opentext.deps.executeHttpRequest = vi.fn();
  });

  it('POSTs a multipart create-node carrying OTDSTicket and returns the new node id', async () => {
    opentext.deps.executeHttpRequest.mockImplementation(async (_dest, cfg) => {
      if (cfg.method === 'POST' && cfg.url.endsWith('/authentication/credentials')) {
        return { status: 200, data: { ticket: 'TICKET-1' } };
      }
      // create-node response (v2 nested shape)
      return { status: 200, data: { results: { data: { properties: { id: 52266 } } } } };
    });

    const nodeId = await opentext.uploadDocument(52480, Buffer.from('%PDF-1.7 fake'), 'invoice.pdf', 'application/pdf');
    expect(nodeId).toBe(52266);

    const post = opentext.deps.executeHttpRequest.mock.calls.find(
      ([, c]) => c.method === 'POST' && c.url === opentext.OTCS_NODES_PATH,
    );
    expect(post).toBeTruthy();
    expect(post[1].headers.OTDSTicket).toBe('TICKET-1');
    // form-data sets a multipart boundary content-type and CSRF preflight is disabled
    expect(String(post[1].headers['content-type'])).toMatch(/^multipart\/form-data; boundary=/);
    expect(post[1].disableCsrfTokenFetch).toBe(true);
  });

  it('listFolderChildNames returns every child name (folders too), for dedup', async () => {
    opentext.deps.executeHttpRequest.mockImplementation(async (_dest, cfg) => {
      if (cfg.method === 'POST') return { status: 200, data: { ticket: 'T' } };
      return {
        status: 200,
        data: {
          results: [
            { data: { properties: { id: 1, name: 'invoice.pdf', type: 144 } } },
            { data: { properties: { id: 2, name: 'a-subfolder', type: 0 } } },
          ],
        },
      };
    });

    const names = await opentext.listFolderChildNames(52480);
    expect(names).toEqual(['invoice.pdf', 'a-subfolder']);
  });
});

describe('opentext.extractNodeId', () => {
  const opentext = require('../srv/lib/opentext.js');

  it('extracts from the nested v2 create shape', () => {
    expect(opentext.extractNodeId({ results: { data: { properties: { id: 42 } } } })).toBe(42);
  });

  it('extracts from a shallow v1 shape and coerces string ids', () => {
    expect(opentext.extractNodeId({ id: '7' })).toBe(7);
  });

  it('throws when no id is present', () => {
    expect(() => opentext.extractNodeId({ results: {} })).toThrow(/could not extract node id/);
  });
});
