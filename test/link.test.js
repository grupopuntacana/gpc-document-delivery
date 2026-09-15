import {
  describe, it, expect, vi, beforeAll, beforeEach,
} from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// LinkService (task 0008) + the ADR 0007 folder-guarded claim. The service talks to OpenText
// only through a thin seam: ingest uploads go through `opentext.deps` (the transport), and the
// claim's folder check goes through `linkService.deps.nodeInFolder` (mocked here so the tests
// exercise the registry/authorization logic, not the concrete OTCS client). SHARED_LINK_SECRET
// lets makeToken/resolveToken mint and verify the short-lived delivery token.
process.env.SHARED_LINK_SECRET = 'x'.repeat(64);
process.env.OPENTEXT_FOLDER_ID = '52480';
// Keep the default hours TTL deterministic for the "not 30 days" assertion.
process.env.LINKFOR_TOKEN_TTL_HOURS = '4';

const INVOICES_FOLDER = 52480;
const STATEMENTS_FOLDER = 52481;
const APP_A = 'client-app-a';
const APP_B = 'client-app-b';
process.env.OPENTEXT_BUCKETS = JSON.stringify({
  invoices: { folderNode: INVOICES_FOLDER, allowedWriters: [APP_A] },
  statements: { folderNode: STATEMENTS_FOLDER, allowedWriters: [APP_B] },
});

const cds = require('@sap/cds');
const { IdentityServiceToken } = require('@sap/xssec');
const opentext = require('../srv/lib/opentext.js');
const linkService = require('../srv/link-service.js');
const buckets = require('../srv/lib/buckets.js');
const tokenLib = require('../srv/lib/token.js');

const { GET } = cds.test(process.cwd());

const DOCUMENTS = 'gpc.documentdelivery.Documents';

/** A caller identified only by its azp, shaped like CAP's IAS strategy builds (see ingest.test). */
const asApp = (azp) => new cds.User({
  id: azp,
  authInfo: {
    token: new IdentityServiceToken(null, { header: { alg: 'RS256' }, payload: { azp, sub: azp } }),
  },
});

/** Invoke a service action as `azp`, re-shaping a CAP rejection to `{response:{status,data}}`. */
async function callAs(srv, azp, event, data) {
  cds.context = { user: asApp(azp) };
  try {
    return { data: await srv.send({ event, data }) };
  } catch (e) {
    const status = Number(e.code);
    throw Object.assign(e, {
      response: {
        status: Number.isNaN(status) ? 500 : status,
        data: { error: { message: e.message } },
      },
    });
  }
}

const b64 = (s) => Buffer.from(s).toString('base64');
const tokenOf = (deliveryUrl) => deliveryUrl.split('/invoice/')[1];

describe('LinkService', () => {
  let ingest;
  let link;

  beforeAll(async () => {
    ingest = await cds.connect.to('IngestService');
    link = await cds.connect.to('LinkService');
  });

  beforeEach(() => {
    buckets.clearRegistryCache();
    opentext.clearTicketCache();
    opentext.deps.getDestination = vi.fn(async () => ({ username: 'Admin', password: 'secret' }));
    opentext.deps.executeHttpRequest = vi.fn();
    // Default folder-guard: the node is in the bucket's folder unless a test overrides it.
    linkService.deps.nodeInFolder = vi.fn(async () => true);
  });

  // Transport mock for the ingest upload (create the Documents row) and the /invoice download.
  function mockTransport({ newId = 9001 } = {}) {
    opentext.deps.executeHttpRequest.mockImplementation(async (_dest, cfg) => {
      if (cfg.method === 'POST' && cfg.url.endsWith('/authentication/credentials')) {
        return { status: 200, data: { ticket: 'T' } };
      }
      if (cfg.method === 'GET' && cfg.url.endsWith('/content')) {
        // /invoice/:token → downloadDocument: bytes + headers.
        return {
          status: 200,
          data: Buffer.from('%PDF-1.7 delivered'),
          headers: { 'content-type': 'application/pdf', 'content-disposition': 'inline; filename="invoice.pdf"' },
        };
      }
      if (cfg.method === 'GET') return { status: 200, data: { results: [] } }; // dedup listing
      return { status: 200, data: { results: { data: { properties: { id: newId } } } } }; // create
    });
  }

  /** Ingest one document as `azp` and return its opaque docId (and the node id it hides). */
  async function ingestDoc(azp, bucket, newId) {
    mockTransport({ newId });
    const { data } = await callAs(ingest, azp, 'uploadDocument', {
      bucket, fileName: 'invoice.pdf', contentType: 'application/pdf', contentBase64: b64('%PDF-1.7'),
    });
    return { docId: data.docId, nodeId: newId };
  }

  describe('linkFor(docId) — the client-safe path', () => {
    it('mints a fresh short-lived link for a docId the caller owns, and it delivers', async () => {
      const { docId } = await ingestDoc(APP_A, 'invoices', 9101);
      const { data } = await callAs(link, APP_A, 'linkFor', { docId });

      expect(data.deliveryUrl).toContain('/invoice/');
      expect(JSON.stringify(data)).not.toContain('9101'); // the nodeId never leaves the handler
      const tok = tokenOf(data.deliveryUrl);
      // the token verifies and resolves to the hidden node
      const payload = await tokenLib.resolveToken(tok);
      expect(payload.nodeId).toBe(9101);

      // and it redeems anonymously through the existing /invoice/:token route (unchanged)
      const res = await GET(`/invoice/${tok}`);
      expect(res.status).toBe(200);
    });

    it('mints a SHORT ttl (hours), never the 30-day makeToken default', async () => {
      const { docId } = await ingestDoc(APP_A, 'invoices', 9102);
      const before = Date.now();
      const { data } = await callAs(link, APP_A, 'linkFor', { docId });
      const ttlMs = new Date(data.expiresAt).getTime() - before;
      expect(ttlMs).toBeGreaterThan(0);
      expect(ttlMs).toBeLessThan(24 * 3600 * 1000); // hours, well under a day (≈ 4h configured)
      // the token's baked-in expiry matches the returned expiresAt (within a second)
      const payload = await tokenLib.resolveToken(tokenOf(data.deliveryUrl));
      const skew = Math.abs(payload.expiresAt.getTime() - new Date(data.expiresAt).getTime());
      expect(skew).toBeLessThan(1500);
    });

    it('honors an explicit ttlDays but still bounded by the caller', async () => {
      const { docId } = await ingestDoc(APP_A, 'invoices', 9103);
      const before = Date.now();
      const { data } = await callAs(link, APP_A, 'linkFor', { docId, ttlDays: 1 });
      const ttlMs = new Date(data.expiresAt).getTime() - before;
      expect(ttlMs).toBeGreaterThan(23 * 3600 * 1000);
      expect(ttlMs).toBeLessThan(25 * 3600 * 1000);
    });

    it('404s a docId owned by a different bucket — no cross-bucket minting', async () => {
      const { docId } = await ingestDoc(APP_A, 'invoices', 9104);
      const err = await callAs(link, APP_B, 'linkFor', { docId }).catch((e) => e);
      expect(err.response.status).toBe(404);
    });

    it('404s an unknown or tampered docId, minting nothing', async () => {
      const { docId } = await ingestDoc(APP_A, 'invoices', 9105);
      const unknown = await callAs(link, APP_A, 'linkFor', { docId: 'not-a-real-docid' }).catch((e) => e);
      expect(unknown.response.status).toBe(404);
      const tampered = await callAs(link, APP_A, 'linkFor', { docId: `${docId}x` }).catch((e) => e);
      expect(tampered.response.status).toBe(404);
    });

    it('404s an empty docId', async () => {
      const err = await callAs(link, APP_A, 'linkFor', { docId: '' }).catch((e) => e);
      expect(err.response.status).toBe(404);
    });

    it('404s a revoked row', async () => {
      const { docId } = await ingestDoc(APP_A, 'invoices', 9106);
      await UPDATE(DOCUMENTS).set({ revoked: true }).where({ docId });
      const err = await callAs(link, APP_A, 'linkFor', { docId }).catch((e) => e);
      expect(err.response.status).toBe(404);
    });

    it('a spoofed body field grants nothing (auth is on the derived azp)', async () => {
      const { docId } = await ingestDoc(APP_A, 'invoices', 9107);
      // Two independent layers, mirroring ingest's spoof test. First, the derived azp is the
      // sole authority: APP_B presenting APP_A's real docId (no spoof) is still denied.
      const denied = await callAs(link, APP_B, 'linkFor', { docId }).catch((e) => e);
      expect(denied.response.status).toBe(404);
      // Second, the action declares no azp/ownerAzp field, so CAP rejects a spoofing body
      // outright — it never even reaches the handler.
      const spoof = await callAs(link, APP_B, 'linkFor', { docId, azp: APP_A, ownerAzp: APP_A })
        .catch((e) => e);
      expect(spoof.message).toMatch(/does not exist/);
    });

    it('403s a caller whose token carries no azp claim', async () => {
      const { docId } = await ingestDoc(APP_A, 'invoices', 9108);
      cds.context = { user: new cds.User({ id: 'no-azp' }) };
      const err = await link.send({ event: 'linkFor', data: { docId } }).catch((e) => e);
      expect(Number(err.code)).toBe(403);
    });
  });

  describe('linkForNode(bucket, nodeId) — the ADR 0007 folder-guarded claim', () => {
    it('claims a directly-uploaded node in the caller bucket, upserts one row, mints a link', async () => {
      mockTransport();
      linkService.deps.nodeInFolder = vi.fn(async () => true); // node is in invoices' folder

      const { data } = await callAs(link, APP_A, 'linkForNode', { bucket: 'invoices', nodeId: 7001 });
      expect(data.deliveryUrl).toContain('/invoice/');
      expect(linkService.deps.nodeInFolder).toHaveBeenCalledWith(7001, INVOICES_FOLDER);

      // the row was lazily created (revocation/audit now exist for the shared node)
      const rows = await SELECT.from(DOCUMENTS).where({ nodeId: 7001, bucket: 'invoices' });
      expect(rows).toHaveLength(1);
      expect(rows[0].ownerAzp).toBe(APP_A);

      // the token still delivers through the unchanged /invoice route
      const res = await GET(`/invoice/${tokenOf(data.deliveryUrl)}`);
      expect(res.status).toBe(200);
    });

    it('is idempotent — a second claim reuses the row, never a duplicate', async () => {
      mockTransport();
      await callAs(link, APP_A, 'linkForNode', { bucket: 'invoices', nodeId: 7002 });
      await callAs(link, APP_A, 'linkForNode', { bucket: 'invoices', nodeId: 7002 });
      const rows = await SELECT.from(DOCUMENTS).where({ nodeId: 7002, bucket: 'invoices' });
      expect(rows).toHaveLength(1);
    });

    it('404s when the node is NOT in the caller bucket folder — mints nothing, no row', async () => {
      mockTransport();
      linkService.deps.nodeInFolder = vi.fn(async () => false); // parent folder != bucket folder

      const err = await callAs(link, APP_A, 'linkForNode', { bucket: 'invoices', nodeId: 7003 }).catch((e) => e);
      expect(err.response.status).toBe(404);
      const rows = await SELECT.from(DOCUMENTS).where({ nodeId: 7003 });
      expect(rows).toHaveLength(0);
    });

    it('404s a bucket the caller does not own — before any folder lookup (no enumeration)', async () => {
      mockTransport();
      linkService.deps.nodeInFolder = vi.fn(async () => true);
      const err = await callAs(link, APP_A, 'linkForNode', { bucket: 'statements', nodeId: 7004 }).catch((e) => e);
      expect(err.response.status).toBe(404);
      expect(linkService.deps.nodeInFolder).not.toHaveBeenCalled();
    });

    it('404s a re-claim of a revoked node (revoked stays revoked)', async () => {
      mockTransport();
      await callAs(link, APP_A, 'linkForNode', { bucket: 'invoices', nodeId: 7005 });
      await UPDATE(DOCUMENTS).set({ revoked: true }).where({ nodeId: 7005 });
      const err = await callAs(link, APP_A, 'linkForNode', { bucket: 'invoices', nodeId: 7005 }).catch((e) => e);
      expect(err.response.status).toBe(404);
    });

    it('403s a caller with no azp claim', async () => {
      cds.context = { user: new cds.User({ id: 'no-azp' }) };
      const err = await link.send({ event: 'linkForNode', data: { bucket: 'invoices', nodeId: 7006 } }).catch((e) => e);
      expect(Number(err.code)).toBe(403);
    });
  });

  describe('over HTTP', () => {
    it('linkFor stays 401 for an unauthenticated caller', async () => {
      const err = await GET('/odata/v4/link/linkFor').catch((e) => e); // GET on an action → 4xx
      expect([401, 405]).toContain(err.response.status);
    });
  });
});

// The OpenText parent-folder capability (transport layer) — unit-tested through the deps seam,
// the same way the other opentext.* calls are, so it lifts cleanly into @gpc/attachments-opentext.
describe('opentext.nodeInFolder / getParentId', () => {
  beforeEach(() => {
    opentext.clearTicketCache();
    opentext.deps.getDestination = vi.fn(async () => ({ username: 'Admin', password: 'secret' }));
    opentext.deps.executeHttpRequest = vi.fn(async (_dest, cfg) => {
      if (cfg.method === 'POST') return { status: 200, data: { ticket: 'T' } };
      const properties = { id: 42, parent_id: 5816 };
      return { status: 200, data: { results: { data: { properties } } } };
    });
  });

  it('reads the node parent id from OTCS', async () => {
    expect(await opentext.getParentId(42)).toBe(5816);
  });

  it('nodeInFolder is true only when the parent matches', async () => {
    expect(await opentext.nodeInFolder(42, 5816)).toBe(true);
    expect(await opentext.nodeInFolder(42, 9999)).toBe(false);
  });
});
