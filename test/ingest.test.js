import {
  describe, it, expect, vi, beforeAll, beforeEach,
} from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// The IngestService action talks to OpenText only through `opentext.deps`, so we mock the
// transport (same pattern as selftest.test.js) and drive the action via cds.test's HTTP
// client. SHARED_LINK_SECRET is needed so makeToken can mint the returned sharing token.
process.env.SHARED_LINK_SECRET = 'x'.repeat(64);
process.env.OPENTEXT_FOLDER_ID = '52480';
// Two buckets on DIFFERENT folder nodes — the point of the slice is that each lands in its
// own OpenText folder. Set before the service boots so the registry sees it.
const INVOICES_FOLDER = 52480;
const STATEMENTS_FOLDER = 52481;
process.env.OPENTEXT_BUCKETS = JSON.stringify({
  invoices: { folderNode: INVOICES_FOLDER },
  statements: { folderNode: STATEMENTS_FOLDER },
});

const cds = require('@sap/cds');
const opentext = require('../srv/lib/opentext.js');

const { GET, POST, axios } = cds.test(process.cwd());
// Anonymous test client — the service requires an authenticated user; cds mock auth accepts
// basic creds. Use the default privileged 'alice' from cds mocked auth.
axios.defaults.auth = { username: 'alice', password: '' };

describe('IngestService.uploadDocument', () => {
  beforeAll(() => {
    // surface a clear failure instead of a hang if the server didn't boot
    expect(typeof POST).toBe('function');
    expect(typeof GET).toBe('function');
  });

  beforeEach(() => {
    opentext.clearTicketCache();
    opentext.deps.getDestination = vi.fn(async () => ({ username: 'Admin', password: 'secret' }));
    opentext.deps.executeHttpRequest = vi.fn();
  });

  // Captures the create-node POST configs so tests can assert what was actually sent to OTCS
  // (not just the response shape). `creates` collects each create-node cfg in call order;
  // `lists` collects the folder-listing GETs (the dedup read) so a test can assert WHICH
  // folder was consulted, not just which one was written to.
  function mockTransport({ existingNames = [], newId = 9001 } = {}) {
    const creates = [];
    const lists = [];
    opentext.deps.executeHttpRequest.mockImplementation(async (_dest, cfg) => {
      if (cfg.method === 'POST' && cfg.url.endsWith('/authentication/credentials')) {
        return { status: 200, data: { ticket: 'T' } };
      }
      if (cfg.method === 'GET') {
        lists.push(cfg);
        return {
          status: 200,
          data: {
            results: existingNames.map((name, i) => ({
              data: { properties: { id: 100 + i, name, type: 144 } },
            })),
          },
        };
      }
      // create-node
      creates.push(cfg);
      return { status: 200, data: { results: { data: { properties: { id: newId } } } } };
    });
    return { creates, lists };
  }

  /** The `parent_id` the handler actually sent in the create-node multipart body. */
  const parentIdOf = (cfg) => JSON.parse(
    cfg.data.toString('utf8').match(/\{"parent_id".*?\}/)[0],
  ).parent_id;

  const b64 = (s) => Buffer.from(s).toString('base64');

  it('uploads, returns nodeId + name + a token', async () => {
    mockTransport({ existingNames: [], newId: 9001 });
    const { data } = await POST('/odata/v4/ingest/uploadDocument', {
      bucket: 'invoices',
      fileName: 'invoice.pdf',
      contentType: 'application/pdf',
      contentBase64: b64('%PDF-1.7 hello'),
    });
    expect(data.nodeId).toBe(9001);
    expect(data.name).toBe('invoice.pdf');
    expect(data.token).toMatch(/^[^.]+\.[^.]+$/); // base64url(payload).base64url(sig)
  });

  it('de-duplicates a colliding filename with an 8-hex UUID suffix', async () => {
    const { creates } = mockTransport({ existingNames: ['invoice.pdf'], newId: 9002 });
    const { data } = await POST('/odata/v4/ingest/uploadDocument', {
      bucket: 'invoices',
      fileName: 'invoice.pdf',
      contentBase64: b64('%PDF-1.7 hello'),
    });
    expect(data.name).toMatch(/^invoice_[0-9a-f]{8}\.pdf$/);
    expect(data.name).not.toBe('invoice.pdf');

    // the RENAMED name must be what we actually POST to OTCS, not the original — guards a
    // refactor silently storing 'invoice.pdf' while returning the renamed name to the client
    const payload = creates[0].data.toString('utf8');
    expect(payload).toContain(`"name":"${data.name}"`);
    expect(payload).toContain(`filename="${data.name}"`);
  });

  it('defaults contentType to application/octet-stream when omitted', async () => {
    const { creates } = mockTransport({ newId: 9003 });
    await POST('/odata/v4/ingest/uploadDocument', {
      bucket: 'invoices',
      fileName: 'invoice.pdf',
      contentBase64: b64('%PDF-1.7 hello'),
    });
    expect(creates[0].data.toString('utf8')).toContain('Content-Type: application/octet-stream');
  });

  it('accepts a non-PDF file (e.g. a camera photo) with its own content type', async () => {
    const { creates } = mockTransport({ newId: 9004 });
    const { data } = await POST('/odata/v4/ingest/uploadDocument', {
      bucket: 'invoices',
      fileName: 'photo.jpg',
      contentType: 'image/jpeg',
      contentBase64: b64('\xFF\xD8\xFF fake-jpeg'),
    });
    expect(data.nodeId).toBe(9004);
    expect(creates[0].data.toString('utf8')).toContain('Content-Type: image/jpeg');
    expect(creates[0].data.toString('utf8')).toContain('filename="photo.jpg"');
  });

  it('rejects an empty file', async () => {
    mockTransport();
    await expect(
      POST('/odata/v4/ingest/uploadDocument', { bucket: 'invoices', fileName: 'x.pdf', contentBase64: '' }),
    ).rejects.toMatchObject({ response: { status: 400 } });
  });

  it('translates an OpenText failure into a 502', async () => {
    // create-node fails → IngestService should surface describeError() as a 502, not a 500.
    opentext.deps.executeHttpRequest.mockImplementation(async (_dest, cfg) => {
      if (cfg.method === 'POST' && cfg.url.endsWith('/authentication/credentials')) {
        return { status: 200, data: { ticket: 'T' } };
      }
      if (cfg.method === 'GET') return { status: 200, data: { results: [] } };
      const err = new Error('Internal Server Error');
      err.response = { status: 500, data: 'boom' };
      throw err;
    });
    await expect(
      POST('/odata/v4/ingest/uploadDocument', {
        bucket: 'invoices',
        fileName: 'invoice.pdf',
        contentBase64: b64('%PDF-1.7 hello'),
      }),
    ).rejects.toMatchObject({ response: { status: 502 } });
  });

  describe('bucket -> folder routing (0005)', () => {
    it('routes two buckets to their own OpenText parent folders', async () => {
      const a = mockTransport({ newId: 9101 });
      await POST('/odata/v4/ingest/uploadDocument', {
        bucket: 'invoices',
        fileName: 'invoice.pdf',
        contentBase64: b64('%PDF-1.7 hello'),
      });
      expect(parentIdOf(a.creates[0])).toBe(INVOICES_FOLDER);

      const b = mockTransport({ newId: 9102 });
      await POST('/odata/v4/ingest/uploadDocument', {
        bucket: 'statements',
        fileName: 'invoice.pdf',
        contentBase64: b64('%PDF-1.7 hello'),
      });
      expect(parentIdOf(b.creates[0])).toBe(STATEMENTS_FOLDER);

      // the whole point of the slice: same filename, different folders
      expect(parentIdOf(a.creates[0])).not.toBe(parentIdOf(b.creates[0]));
    });

    it('de-duplicates within the named bucket, not the legacy folder', async () => {
      // The dedup READ must consult the bucket's own folder — otherwise a name taken in
      // one bucket would rename an upload in another.
      const { lists } = mockTransport({ existingNames: [], newId: 9103 });
      await POST('/odata/v4/ingest/uploadDocument', {
        bucket: 'statements',
        fileName: 'invoice.pdf',
        contentBase64: b64('%PDF-1.7 hello'),
      });
      expect(lists[0].url).toContain(String(STATEMENTS_FOLDER));
      expect(lists[0].url).not.toContain(String(INVOICES_FOLDER));
    });

    it('rejects an unknown bucket with 400 before any OpenText call', async () => {
      mockTransport();
      await expect(
        POST('/odata/v4/ingest/uploadDocument', {
          bucket: 'no-such-bucket',
          fileName: 'invoice.pdf',
          contentBase64: b64('%PDF-1.7 hello'),
        }),
      ).rejects.toMatchObject({ response: { status: 400 } });
      expect(opentext.deps.executeHttpRequest).not.toHaveBeenCalled();
    });

    it('rejects a missing bucket with 400 — no silent fallback to the legacy folder', async () => {
      mockTransport();
      const err = await POST('/odata/v4/ingest/uploadDocument', {
        fileName: 'invoice.pdf',
        contentBase64: b64('%PDF-1.7 hello'),
      }).catch((e) => e);
      expect(err.response.status).toBe(400);
      // says the field is missing, not that a bucket named "" is unknown — matches the
      // sibling `fileName is required` / `contentBase64 is required` guards
      expect(err.response.data.error.message).toMatch(/bucket is required/);
      expect(opentext.deps.executeHttpRequest).not.toHaveBeenCalled();
    });

    it('does not name the configured buckets in the rejection', async () => {
      // The 400 reaches an authenticated caller; listing other apps' namespaces would
      // turn a typo into enumeration (0007 adds the write ACL).
      mockTransport();
      const err = await POST('/odata/v4/ingest/uploadDocument', {
        bucket: 'no-such-bucket',
        fileName: 'invoice.pdf',
        contentBase64: b64('%PDF-1.7 hello'),
      }).catch((e) => e);
      expect(JSON.stringify(err.response.data)).not.toContain('statements');
    });
  });
});
