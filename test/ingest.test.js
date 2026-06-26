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

  function mockTransport({ existingNames = [], newId = 9001 } = {}) {
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
      return { status: 200, data: { results: { data: { properties: { id: newId } } } } };
    });
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
    mockTransport({ existingNames: ['invoice.pdf'], newId: 9002 });
    const { data } = await POST('/odata/v4/ingest/uploadDocument', {
      fileName: 'invoice.pdf',
      contentBase64: b64('%PDF-1.7 hello'),
    });
    expect(data.name).toMatch(/^invoice_[0-9a-f]{8}\.pdf$/);
    expect(data.name).not.toBe('invoice.pdf');
  });

  it('rejects an empty file', async () => {
    mockTransport();
    await expect(
      POST('/odata/v4/ingest/uploadDocument', { fileName: 'x.pdf', contentBase64: '' }),
    ).rejects.toMatchObject({ response: { status: 400 } });
  });
});
