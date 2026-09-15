import {
  describe, it, expect, vi, beforeAll, beforeEach,
} from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// The IngestService action talks to OpenText only through `opentext.deps`, so we mock the
// transport (same pattern as selftest.test.js). SHARED_LINK_SECRET is needed so makeToken can
// mint the returned sharing token.
//
// Uploads are driven via `srv.send` under a constructed `cds.context.user` rather than over
// HTTP: since 0007 the handler authorizes on `req.user.authInfo.token.azp`, and these tests
// need two distinct callers per case, which basic auth cannot vary per request here. The user
// carries a real `IdentityServiceToken` — the approach @sap/xssec's README prescribes for
// local tests — so no seam is needed in production code. The HTTP client stays for the tests
// that are about the HTTP contract itself (401/403).
process.env.SHARED_LINK_SECRET = 'x'.repeat(64);
process.env.OPENTEXT_FOLDER_ID = '52480';
// Two buckets on DIFFERENT folder nodes — the point of the slice is that each lands in its
// own OpenText folder. Set before the service boots so the registry sees it.
const INVOICES_FOLDER = 52480;
const STATEMENTS_FOLDER = 52481;
// A third bucket names a parent + folder name instead of a folder node: it self-provisions
// its folder on first upload (0006). Same registry, different shape.
const ARCHIVE_PARENT = 5816;
const ARCHIVE_NAME = 'archive';
// Two callers with different azp: the isolation this slice exists to prove is that APP_A
// cannot write APP_B's bucket. `invoices`/`archive` belong to A, `statements` to B.
const APP_A = 'client-app-a';
const APP_B = 'client-app-b';
process.env.OPENTEXT_BUCKETS = JSON.stringify({
  invoices: { folderNode: INVOICES_FOLDER, allowedWriters: [APP_A] },
  statements: { folderNode: STATEMENTS_FOLDER, allowedWriters: [APP_B] },
  archive: { parentNode: ARCHIVE_PARENT, folderName: ARCHIVE_NAME, allowedWriters: [APP_A] },
});

const cds = require('@sap/cds');
const { IdentityServiceToken } = require('@sap/xssec');
const opentext = require('../srv/lib/opentext.js');
const buckets = require('../srv/lib/buckets.js');

const { GET, POST, axios } = cds.test(process.cwd());
// Anonymous test client — the service requires an authenticated user; cds mock auth accepts
// basic creds. Use the default privileged 'alice' from cds mocked auth.
axios.defaults.auth = { username: 'alice', password: '' };

/**
 * A caller identified only by its azp, shaped like the user CAP's ias strategy builds.
 *
 * The token is a real `IdentityServiceToken`, not a plain object: constructing one from a
 * header/payload pair is what @sap/xssec's README prescribes for local tests (it explicitly
 * discourages self-signed JWTs against a self-hosted JWKS). It exercises the actual `azp`
 * getter the handler reads in production.
 */
const asApp = (azp) => new cds.User({
  id: azp,
  authInfo: {
    token: new IdentityServiceToken(null, {
      header: { alg: 'RS256' },
      payload: { azp, sub: azp },
    }),
  },
});

/** A caller whose token carries the given payload verbatim — for the absent-claim cases. */
const asTokenPayload = (payload) => ({
  authInfo: { token: new IdentityServiceToken(null, { header: { alg: 'RS256' }, payload }) },
});

/**
 * Invoke uploadDocument as `azp`. Rejections are re-shaped to the `{response:{status,data}}`
 * form the HTTP client produced, so the assertions read the same either way — `srv.send`
 * rejects with a CAP error carrying the status in `code`.
 */
async function callUpload(srv, azp, data) {
  cds.context = { user: asApp(azp) };
  try {
    return { data: await srv.send({ event: 'uploadDocument', data }) };
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

describe('IngestService.uploadDocument', () => {
  let srv;

  beforeAll(async () => {
    // surface a clear failure instead of a hang if the server didn't boot
    expect(typeof POST).toBe('function');
    expect(typeof GET).toBe('function');
    srv = await cds.connect.to('IngestService');
  });

  beforeEach(() => {
    opentext.clearTicketCache();
    opentext.deps.getDestination = vi.fn(async () => ({ username: 'Admin', password: 'secret' }));
    opentext.deps.executeHttpRequest = vi.fn();
  });

  // Captures the create-node POST configs so tests can assert what was actually sent to OTCS
  // (not just the response shape). Creates are split by node type: `creates` holds the
  // document creates (type 144), `folderCreates` the folder ones (type 0, from 0006's
  // self-provisioning) — otherwise "exactly one folder create" would be unassertable.
  // `lists` collects the folder-listing GETs (the dedup read, and 0006's parent lookup) so a
  // test can assert WHICH folder was consulted, not just which one was written to.
  //
  // `existingNames` is the type-144 shorthand the dedup tests use; `existingChildren` takes
  // full `{id, name, type}` records for tests that need a folder child.
  function mockTransport({
    existingNames = [], existingChildren = null, newId = 9001, folderId = 9500,
  } = {}) {
    const creates = [];
    const folderCreates = [];
    const lists = [];
    const children = existingChildren
      || existingNames.map((name, i) => ({ id: 100 + i, name, type: 144 }));
    opentext.deps.executeHttpRequest.mockImplementation(async (_dest, cfg) => {
      if (cfg.method === 'POST' && cfg.url.endsWith('/authentication/credentials')) {
        return { status: 200, data: { ticket: 'T' } };
      }
      if (cfg.method === 'GET') {
        lists.push(cfg);
        return {
          status: 200,
          data: { results: children.map((c) => ({ data: { properties: c } })) },
        };
      }
      // create-node — route on the type in the multipart `body` field
      const isFolder = /"type":0[,}]/.test(cfg.data.toString('utf8'));
      if (isFolder) {
        folderCreates.push(cfg);
        return { status: 200, data: { results: { data: { properties: { id: folderId } } } } };
      }
      creates.push(cfg);
      return { status: 200, data: { results: { data: { properties: { id: newId } } } } };
    });
    return { creates, folderCreates, lists };
  }

  /** The `parent_id` the handler actually sent in the create-node multipart body. */
  const parentIdOf = (cfg) => JSON.parse(
    cfg.data.toString('utf8').match(/\{"parent_id".*?\}/)[0],
  ).parent_id;

  const b64 = (s) => Buffer.from(s).toString('base64');

  it('uploads, returns nodeId + name + a token', async () => {
    mockTransport({ existingNames: [], newId: 9001 });
    const { data } = await callUpload(srv, APP_A, {
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
    const { data } = await callUpload(srv, APP_A, {
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
    await callUpload(srv, APP_A, {
      bucket: 'invoices',
      fileName: 'invoice.pdf',
      contentBase64: b64('%PDF-1.7 hello'),
    });
    expect(creates[0].data.toString('utf8')).toContain('Content-Type: application/octet-stream');
  });

  it('accepts a non-PDF file (e.g. a camera photo) with its own content type', async () => {
    const { creates } = mockTransport({ newId: 9004 });
    const { data } = await callUpload(srv, APP_A, {
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
      callUpload(srv, APP_A, { bucket: 'invoices', fileName: 'x.pdf', contentBase64: '' }),
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
      callUpload(srv, APP_A, {
        bucket: 'invoices',
        fileName: 'invoice.pdf',
        contentBase64: b64('%PDF-1.7 hello'),
      }),
    ).rejects.toMatchObject({ response: { status: 502 } });
  });

  describe('bucket -> folder routing (0005)', () => {
    it('routes two buckets to their own OpenText parent folders', async () => {
      const a = mockTransport({ newId: 9101 });
      await callUpload(srv, APP_A, {
        bucket: 'invoices',
        fileName: 'invoice.pdf',
        contentBase64: b64('%PDF-1.7 hello'),
      });
      expect(parentIdOf(a.creates[0])).toBe(INVOICES_FOLDER);

      const b = mockTransport({ newId: 9102 });
      await callUpload(srv, APP_B, {
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
      await callUpload(srv, APP_B, {
        bucket: 'statements',
        fileName: 'invoice.pdf',
        contentBase64: b64('%PDF-1.7 hello'),
      });
      expect(lists[0].url).toContain(String(STATEMENTS_FOLDER));
      expect(lists[0].url).not.toContain(String(INVOICES_FOLDER));
    });

    it('rejects an unknown bucket with 403, not 400 — no enumeration by status code', async () => {
      // 400-for-absent vs 403-for-forbidden would let a caller probe the namespace one name
      // at a time, which is the enumeration the message already avoids (0007).
      mockTransport();
      await expect(
        callUpload(srv, APP_A, {
          bucket: 'no-such-bucket',
          fileName: 'invoice.pdf',
          contentBase64: b64('%PDF-1.7 hello'),
        }),
      ).rejects.toMatchObject({ response: { status: 403 } });
      expect(opentext.deps.executeHttpRequest).not.toHaveBeenCalled();
    });

    it('rejects a missing bucket with 400 — no silent fallback to the legacy folder', async () => {
      mockTransport();
      const err = await callUpload(srv, APP_A, {
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
      // The rejection reaches an authenticated caller; listing other apps' namespaces would
      // turn a typo into enumeration.
      mockTransport();
      const err = await callUpload(srv, APP_A, {
        bucket: 'no-such-bucket',
        fileName: 'invoice.pdf',
        contentBase64: b64('%PDF-1.7 hello'),
      }).catch((e) => e);
      const body = JSON.stringify(err.response.data);
      expect(body).not.toContain('statements');
      expect(body).not.toContain('no-such-bucket');
    });
  });

  describe('bucket self-provisioning (0006)', () => {
    // The resolved folder id is memoized for the process lifetime, so each test starts from
    // a cold registry — otherwise the first test's folder would leak into the rest.
    beforeEach(() => {
      buckets.clearRegistryCache();
    });

    const upload = (bucket, fileName = 'invoice.pdf') => callUpload(srv, APP_A, {
      bucket,
      fileName,
      contentBase64: b64('%PDF-1.7 hello'),
    });

    it('creates the folder under its parent, then uploads into it', async () => {
      const { creates, folderCreates } = mockTransport({ folderId: 9500, newId: 9201 });
      await upload('archive');

      expect(folderCreates).toHaveLength(1);
      const folderBody = folderCreates[0].data.toString('utf8');
      expect(parentIdOf(folderCreates[0])).toBe(ARCHIVE_PARENT);
      expect(folderBody).toContain('"type":0');
      expect(folderBody).toContain(`"name":"${ARCHIVE_NAME}"`);
      // the document lands in the folder we just created, not in its parent
      expect(parentIdOf(creates[0])).toBe(9500);
    });

    it('creates the folder exactly once across two uploads (AC-2)', async () => {
      const { creates, folderCreates } = mockTransport({ folderId: 9501, newId: 9202 });
      await upload('archive', 'a.pdf');
      await upload('archive', 'b.pdf');

      expect(folderCreates).toHaveLength(1);
      expect(creates).toHaveLength(2);
      expect(creates.map(parentIdOf)).toEqual([9501, 9501]);
    });

    it('reuses an existing folder instead of creating a duplicate', async () => {
      const { creates, folderCreates } = mockTransport({
        existingChildren: [{ id: 9600, name: ARCHIVE_NAME, type: 0 }],
        newId: 9203,
      });
      await upload('archive');

      expect(folderCreates).toHaveLength(0);
      expect(parentIdOf(creates[0])).toBe(9600);
    });

    it('502s when the folder create fails', async () => {
      opentext.deps.executeHttpRequest.mockImplementation(async (_dest, cfg) => {
        if (cfg.method === 'POST' && cfg.url.endsWith('/authentication/credentials')) {
          return { status: 200, data: { ticket: 'T' } };
        }
        if (cfg.method === 'GET') return { status: 200, data: { results: [] } };
        const err = new Error('OTCS refused the create');
        err.response = { status: 403, data: { error: 'no permission' } };
        throw err;
      });

      const err = await upload('archive').catch((e) => e);
      // an upstream refusal is OpenText's fault, not the deployment's — never a 500
      expect(err.response.status).toBe(502);
      expect(err.response.data.error.message).toMatch(/folder provisioning failed/i);
    });

    it('502s rather than uploading into a same-named document', async () => {
      const { creates } = mockTransport({
        existingChildren: [{ id: 9700, name: ARCHIVE_NAME, type: 144 }],
      });

      const err = await upload('archive').catch((e) => e);
      expect(err.response.status).toBe(502);
      expect(creates).toHaveLength(0);
    });

    it('a folderNode bucket still creates no folder (0005 unaffected)', async () => {
      const { creates, folderCreates } = mockTransport({ newId: 9204 });
      await upload('invoices');

      expect(folderCreates).toHaveLength(0);
      expect(parentIdOf(creates[0])).toBe(INVOICES_FOLDER);
    });
  });

  describe('per-app write authorization (0007)', () => {
    const { authorizeWrite } = require('../srv/ingest-service.js');

    beforeEach(() => {
      buckets.clearRegistryCache();
    });

    it('lets each app write its own bucket', () => {
      expect(authorizeWrite(asApp(APP_A), 'invoices').ok).toBe(true);
      expect(authorizeWrite(asApp(APP_B), 'statements').ok).toBe(true);
    });

    it('denies app A the bucket owned by app B (AC-1)', () => {
      const denied = authorizeWrite(asApp(APP_A), 'statements');
      expect(denied.ok).toBe(false);
      // the log line names both, so an operator can act on it
      expect(denied.reason).toContain(APP_A);
      expect(denied.reason).toContain('statements');
    });

    it('flattens control characters in the azp it logs, without altering the match', () => {
      // The reason string reaches the log verbatim; a newline in the azp would otherwise let a
      // caller forge a second entry. The ACL still sees the raw value.
      const forged = `${APP_A}\nupload denied: FORGED`;
      const denied = authorizeWrite(asApp(forged), 'invoices');
      expect(denied.ok).toBe(false);
      expect(denied.reason).not.toMatch(/[\r\n]/);
      expect(denied.azp).toBe(forged);
    });

    it('is decided on the derived azp — a body field cannot grant access (AC-2)', async () => {
      // Two independent layers. First, authorizeWrite takes (user, bucket) and never a body:
      // the signature is the guarantee, so a caller claiming to be APP_B stays denied.
      expect(authorizeWrite(asApp(APP_A), 'statements').ok).toBe(false);

      // Second, the action declares no such field, so CAP rejects a spoofing body outright —
      // it never even reaches the handler.
      mockTransport();
      const err = await callUpload(srv, APP_A, {
        bucket: 'statements',
        azp: APP_B,
        fileName: 'invoice.pdf',
        contentBase64: b64('%PDF-1.7 hello'),
      }).catch((e) => e);
      expect(err.message).toMatch(/Property "azp" does not exist/);
      expect(opentext.deps.executeHttpRequest).not.toHaveBeenCalled();
    });

    it('denies a caller with no azp claim (AC-3)', () => {
      const noAzp = [
        undefined,
        {},
        { authInfo: {} }, // authenticated, but no token at all
        asTokenPayload({ sub: 'svc' }), // a real token that simply carries no azp
        asTokenPayload({ azp: '' }),
        asTokenPayload({ azp: '   ' }),
        { id: 'alice', attr: {} }, // the realistic mocked-auth shape
      ];
      noAzp.forEach((user) => {
        expect(authorizeWrite(user, 'invoices').ok).toBe(false);
      });
    });

    it('never reads azp from req.user.attr', () => {
      // Pins the rule as a test rather than a comment: attr is stripped on the IAS user path
      // and absent on the client-credentials path, so a well-meaning fallback here would be
      // a silent widening.
      expect(authorizeWrite({ id: APP_A, attr: { azp: APP_A } }, 'invoices').ok).toBe(false);
    });

    it('denies a self-provisioned bucket without touching OpenText (AC-4)', () => {
      expect(authorizeWrite(asApp(APP_B), 'archive').ok).toBe(false);
      expect(opentext.deps.executeHttpRequest).not.toHaveBeenCalled();
    });

    it('throws on a broken registry rather than reporting a denial', () => {
      // A config error must never be mistaken for "not authorized" — the handler owes a 500.
      const saved = process.env.OPENTEXT_BUCKETS;
      process.env.OPENTEXT_BUCKETS = '{not json';
      buckets.clearRegistryCache();
      try {
        expect(() => authorizeWrite(asApp(APP_A), 'invoices')).toThrow(/not valid JSON/);
      } finally {
        process.env.OPENTEXT_BUCKETS = saved;
        buckets.clearRegistryCache();
      }
    });

    describe('over HTTP', () => {
      it('stays 401 for an unauthenticated caller', async () => {
        mockTransport();
        const saved = axios.defaults.auth;
        axios.defaults.auth = undefined;
        try {
          const err = await POST('/odata/v4/ingest/uploadDocument', {
            bucket: 'invoices',
            fileName: 'invoice.pdf',
            contentBase64: b64('%PDF-1.7 hello'),
          }).catch((e) => e);
          expect(err.response.status).toBe(401);
        } finally {
          axios.defaults.auth = saved;
        }
        expect(opentext.deps.executeHttpRequest).not.toHaveBeenCalled();
      });

      it('403s an authenticated caller whose token carries no azp', async () => {
        // Mocked auth builds no authInfo, so every HTTP caller is azp-less: the deployed
        // portal behaves the same until its azp is added to the bucket's allowedWriters.
        mockTransport();
        const err = await POST('/odata/v4/ingest/uploadDocument', {
          bucket: 'invoices',
          fileName: 'invoice.pdf',
          contentBase64: b64('%PDF-1.7 hello'),
        }).catch((e) => e);
        expect(err.response.status).toBe(403);
        const body = JSON.stringify(err.response.data);
        expect(body).not.toContain('statements');
        expect(body).not.toContain('invoices');
        expect(opentext.deps.executeHttpRequest).not.toHaveBeenCalled();
      });
    });
  });
});
