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
    // form-data sets a multipart boundary content-type; body is a materialized Buffer
    expect(String(post[1].headers['content-type'])).toMatch(/^multipart\/form-data; boundary=/);
    expect(Buffer.isBuffer(post[1].data)).toBe(true);
    // the `body` form field carries the non-empty JSON string OTCS requires
    // (guards the "Body must be a non-empty String" 400 regression)
    const payload = post[1].data.toString('utf8');
    expect(payload).toContain('name="body"');
    expect(payload).toContain('"type":144');
    expect(payload).toContain('"name":"invoice.pdf"');
    expect(payload).toContain('filename="invoice.pdf"');
    // CSRF preflight is disabled via the SDK's third options arg, not a config field
    expect(post[2]).toMatchObject({ fetchCsrfToken: false });
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

describe('opentext content-type / filename derivation', () => {
  const opentext = require('../srv/lib/opentext.js');

  it('extensionForType maps known types and falls back gracefully', () => {
    expect(opentext.extensionForType('application/pdf')).toBe('pdf');
    expect(opentext.extensionForType('image/jpeg')).toBe('jpg');
    expect(opentext.extensionForType('image/png; charset=binary')).toBe('png');
    expect(opentext.extensionForType('image/svg+xml')).toBe('svg'); // subtype fallback
    expect(opentext.extensionForType('')).toBe('bin'); // unknown → bin
    expect(opentext.extensionForType(undefined)).toBe('bin');
  });

  it('downloadFileName prefers the stored name, else synthesizes from the type', () => {
    expect(opentext.downloadFileName(2000, 'image/jpeg', 'photo.jpg')).toBe('photo.jpg');
    expect(opentext.downloadFileName(2000, 'image/jpeg', null)).toBe('document-2000.jpg');
    expect(opentext.downloadFileName(2000, 'application/pdf', '')).toBe('document-2000.pdf');
    // strips characters that would break the Content-Disposition header
    expect(opentext.downloadFileName(1, 'text/plain', 'a"\r\nb.txt')).toBe('a___b.txt');
  });

  it('filenameFromDisposition parses quoted, unquoted and RFC 5987 forms', () => {
    const f = opentext.filenameFromDisposition;
    expect(f(null)).toBeNull();
    expect(f('inline; filename="photo.jpg"')).toBe('photo.jpg');
    expect(f('attachment; filename=photo.jpg')).toBe('photo.jpg');
    // quoted value containing a semicolon must survive
    expect(f('attachment; filename="a;b.txt"')).toBe('a;b.txt');
    // RFC 5987 with empty and with language tag, percent-decoded
    expect(f("attachment; filename*=UTF-8''inv%20oice.pdf")).toBe('inv oice.pdf');
    expect(f("attachment; filename*=UTF-8'en'r%C3%A9sum%C3%A9.pdf")).toBe('résumé.pdf');
  });

  it('resolveContentType recovers a renderable type when OTCS reports a generic one', () => {
    const r = opentext.resolveContentType;
    // trusts a specific upstream type (preserving any charset suffix)
    expect(r('image/png', 'x.png')).toBe('image/png');
    expect(r('text/plain; charset=utf-8', 'x.txt')).toBe('text/plain; charset=utf-8');
    // recovers from the extension when upstream is generic/missing
    expect(r('application/octet-stream', 'photo.jpg')).toBe('image/jpeg');
    expect(r('', 'scan.PDF')).toBe('application/pdf');
    expect(r(undefined, 'note.heic')).toBe('image/heic');
    // trims whitespace on a trusted upstream type
    expect(r(' image/png ', 'x.png')).toBe('image/png');
    // SVG is deliberately NOT recovered (would run inline <script>) — stays a download
    expect(r('application/octet-stream', 'evil.svg')).toBe('application/octet-stream');
    // unknown extension stays generic
    expect(r('application/octet-stream', 'archive.xyz')).toBe('application/octet-stream');
    expect(r(null, 'noext')).toBe('application/octet-stream');
  });

  it('downloadDocument returns the filename and recovers content-type from a generic one', async () => {
    opentext.clearTicketCache();
    opentext.deps.getDestination = vi.fn(async () => ({ username: 'Admin', password: 'secret' }));
    opentext.deps.executeHttpRequest = vi.fn(async (_dest, cfg) => {
      if (cfg.method === 'POST') return { status: 200, data: { ticket: 'T' } };
      return {
        status: 200,
        data: Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), // real JPEG signature
        // OTCS reports a generic type but names the file — the bug behind "Failed to load PDF"
        headers: {
          'content-type': 'application/octet-stream',
          'content-disposition': 'inline; filename="invoice-photo.jpg"',
        },
      };
    });

    const { contentType, fileName, buffer } = await opentext.downloadDocument(7777);
    expect(contentType).toBe('image/jpeg'); // recovered, not octet-stream → renders inline
    expect(fileName).toBe('invoice-photo.jpg');
    expect(buffer[0]).toBe(0xFF);
  });
});

describe('version (build version resolver)', () => {
  beforeEach(() => {
    delete process.env.APP_VERSION;
    // appVersion() caches its first result; drop the module so each case is cold.
    delete require.cache[require.resolve('../srv/lib/version.js')];
  });

  it('returns APP_VERSION when set (the deploy/tag value)', () => {
    process.env.APP_VERSION = 'v1.2.3';
    expect(require('../srv/lib/version.js').appVersion()).toBe('v1.2.3');
  });

  it('falls back to the package.json version when APP_VERSION is unset', () => {
    expect(require('../srv/lib/version.js').appVersion()).toBe(require('../package.json').version);
  });
});
