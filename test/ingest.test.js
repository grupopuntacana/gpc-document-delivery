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
  // (not just the response shape). `creates` collects each create-node cfg in call order.
  function mockTransport({ existingNames = [], newId = 9001 } = {}) {
    const creates = [];
    opentext.deps.executeHttpRequest.mockImplementation(async (_dest, cfg) => {
      if (cfg.method === 'POST' && cfg.url.endsWith('/authentication/credentials')) {
        return { status: 200, data: { ticket: 'T' } };
      }
      if (cfg.method === 'GET') {
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
    return { creates };
  }

  const b64 = (s) => Buffer.from(s).toString('base64');

  it('uploads, returns nodeId + name + a token', async () => {
    mockTransport({ existingNames: [], newId: 9001 });
    const { data } = await POST('/odata/v4/ingest/uploadDocument', {
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
      fileName: 'invoice.pdf',
      contentBase64: b64('%PDF-1.7 hello'),
    });
    expect(creates[0].data.toString('utf8')).toContain('Content-Type: application/octet-stream');
  });

  it('accepts a non-PDF file (e.g. a camera photo) with its own content type', async () => {
    const { creates } = mockTransport({ newId: 9004 });
    const { data } = await POST('/odata/v4/ingest/uploadDocument', {
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
      POST('/odata/v4/ingest/uploadDocument', { fileName: 'x.pdf', contentBase64: '' }),
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
        fileName: 'invoice.pdf',
        contentBase64: b64('%PDF-1.7 hello'),
      }),
    ).rejects.toMatchObject({ response: { status: 502 } });
  });
});
