import {
  describe, it, expect, vi, beforeAll, beforeEach, afterAll,
} from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ADR 0009 — S/4 ArchiveLink delivery. S/4 holds the TOA01 link (ARCHIV_ID + ARC_DOC_ID) and
// asks LinkService.linkForArchive for a public link; the anonymous /doc/:token route fetches the
// bytes from the content repository over the SAP Content Server HTTP protocol. The archive
// transport is mocked through `archivelink.deps`, the same seam style as opentext.deps.
process.env.SHARED_LINK_SECRET = 'y'.repeat(64);
process.env.LINKFOR_TOKEN_TTL_HOURS = '4';

const S4 = 's4-prd-client'; // reader of repository C1
const OTHER = 'some-btp-app'; // reads the `billing` bucket only
const CONTREP = 'C1';
// The rows S/4 shared (TOA01): PRINTDOC 294 was archived twice (a reprint).
const BILL_A = '0AFFC37AE2C51FD1AE84A8F99394C9FC';
const BILL_B = '0AFFC37AE2C51FD1AE9F1204475B8A04';

process.env.ARCHIVELINK_REPOSITORIES = JSON.stringify({
  C1: { allowedReaders: [S4] },
  C2: { allowedReaders: [S4], destination: 'Other_Archive', compId: 'data1' },
});
process.env.OPENTEXT_BUCKETS = JSON.stringify({
  billing: { folderNode: 52482, allowedWriters: [OTHER] },
});

const cds = require('@sap/cds');
const { IdentityServiceToken } = require('@sap/xssec');
const crypto = require('node:crypto');
const archives = require('../srv/lib/archives.js');
const archivelink = require('../srv/lib/archivelink.js');
const buckets = require('../srv/lib/buckets.js');
const cdn = require('../srv/lib/cdn.js');
const credstore = require('../srv/lib/credstore.js');
const delivery = require('../srv/lib/delivery.js');
const doctoken = require('../srv/lib/doctoken.js');
const seckey = require('../srv/lib/seckey.js');
const tokenLib = require('../srv/lib/token.js');

const { GET } = cds.test(process.cwd());

const DOCUMENTS = 'gpc.documentdelivery.Documents';

const asApp = (azp) => new cds.User({
  id: azp,
  authInfo: {
    token: new IdentityServiceToken(null, { header: { alg: 'RS256' }, payload: { azp, sub: azp } }),
  },
});

async function callAs(srv, azp, event, data) {
  cds.context = { user: asApp(azp) };
  try {
    return { data: await srv.send({ event, data }) };
  } catch (e) {
    // CAP's own input validation (e.g. a String(10) overflow) raises a 400 with a read-only
    // `status`; handler rejections carry the status in `code`.
    const code = Number(e.code);
    const httpStatus = e.status || (Number.isNaN(code) ? 500 : code);
    throw Object.assign(new Error(e.message), { httpStatus, cause: e });
  }
}

const docTokenOf = (deliveryUrl) => deliveryUrl.split('/doc/')[1];

function mockArchive({ status = 200, contentType = 'application/pdf' } = {}) {
  archivelink.deps.executeHttpRequest = vi.fn(async () => {
    if (status !== 200) {
      throw Object.assign(new Error('upstream'), { response: { status, data: 'no such document' } });
    }
    return { status, data: Buffer.from('%PDF-1.4 ISU bill'), headers: { 'content-type': contentType } };
  });
}

// Minimal hand-built certificate skeleton for the secKey tests: just the TBSCertificate fields
// the signer reads (serial, signature algorithm, issuer). Not a valid certificate.
const derSeq = (body) => Buffer.concat([Buffer.from([0x30, body.length]), body]);
const FAKE_SERIAL = Buffer.from('02030a0b0c', 'hex'); // INTEGER 0x0a0b0c
const FAKE_SIGALG = Buffer.from('300d06092a864886f70d0101050500', 'hex'); // sha1WithRSA
const FAKE_ISSUER = Buffer.from('300f310d300b06035504030c0454455354', 'hex'); // CN=TEST
const FAKE_TBS_BODY = Buffer.concat([FAKE_SERIAL, FAKE_SIGALG, FAKE_ISSUER]);
const FAKE_CERT_DER = derSeq(derSeq(FAKE_TBS_BODY));
const FAKE_ISSUER_AND_SERIAL = Buffer.concat([FAKE_ISSUER, FAKE_SERIAL]);

describe('archives registry (ARCHIVELINK_REPOSITORIES)', () => {
  beforeEach(() => archives.clearRegistryCache());

  it('grants only the listed readers, fails closed otherwise', () => {
    expect(archives.mayRead(S4, 'C1')).toBe(true);
    expect(archives.mayRead(OTHER, 'C1')).toBe(false);
    expect(archives.mayRead(S4, 'ZZ')).toBe(false); // unknown repository
    expect(archives.mayRead('', 'C1')).toBe(false);
    expect(archives.mayRead(S4, undefined)).toBe(false);
  });

  it('resolves destination and compId, with defaults', () => {
    expect(archives.resolveRepository('C1')).toEqual({ destination: 'OpenText_OTAC', compId: 'data' });
    expect(archives.resolveRepository('C2')).toEqual({ destination: 'Other_Archive', compId: 'data1' });
    expect(() => archives.resolveRepository('ZZ')).toThrow(expect.objectContaining({ code: 'UNKNOWN_REPOSITORY' }));
  });

  it('re-reads ARCHIVELINK_DESTINATION when the registry cache is cleared', () => {
    process.env.ARCHIVELINK_DESTINATION = 'Another_Default';
    archives.clearRegistryCache();
    try {
      expect(archives.resolveRepository('C1').destination).toBe('Another_Default');
      expect(archives.resolveRepository('C2').destination).toBe('Other_Archive'); // explicit wins
    } finally {
      delete process.env.ARCHIVELINK_DESTINATION;
      archives.clearRegistryCache();
    }
  });

  it('validates the TOA01 locator shape (no query-string smuggling)', () => {
    expect(archives.isValidLocator('C1', BILL_A)).toBe(true);
    expect(archives.isValidLocator('c1', BILL_A)).toBe(false);
    expect(archives.isValidLocator('C1X', BILL_A)).toBe(false);
    expect(archives.isValidLocator('C1', `${BILL_A}&compId=x`)).toBe(false);
    expect(archives.isValidLocator('C1', 'A'.repeat(41))).toBe(false);
    expect(archives.isValidLocator('C1', '')).toBe(false);
  });

  it('rejects broken config with ARCHIVE_CONFIG_INVALID', () => {
    const saved = process.env.ARCHIVELINK_REPOSITORIES;
    const cases = [
      '{not json',
      '[]',
      '{"C1X":{"allowedReaders":["a"]}}',
      '{"C1":{"allowedReaders":"a"}}',
      '{"C1":{"allowedReaders":[" "]}}',
      '{"C1":{"allowedReaders":["a"],"compId":"a&b"}}',
    ];
    try {
      cases.forEach((raw) => {
        process.env.ARCHIVELINK_REPOSITORIES = raw;
        archives.clearRegistryCache();
        expect(() => archives.mayRead(S4, 'C1'), raw)
          .toThrow(expect.objectContaining({ code: 'ARCHIVE_CONFIG_INVALID' }));
      });
    } finally {
      process.env.ARCHIVELINK_REPOSITORIES = saved;
      archives.clearRegistryCache();
    }
  });
});

describe('archivelink fetcher (SAP Content Server HTTP protocol)', () => {
  it('builds the get URL', () => {
    expect(archivelink.getUrl('C1', BILL_A, 'data'))
      .toBe(`/archive?get&pVersion=0045&contRep=C1&docId=${BILL_A}&compId=data`);
  });

  it('fetches through the repository destination without CSRF', async () => {
    mockArchive();
    const out = await archivelink.downloadDocument({
      contRep: 'C1', archDocId: BILL_A, destination: 'OpenText_OTAC', compId: 'data',
    });
    expect(out.contentType).toBe('application/pdf');
    expect(out.buffer.toString()).toContain('%PDF');
    const [dest, cfg, opts] = archivelink.deps.executeHttpRequest.mock.calls[0];
    expect(dest).toEqual({ destinationName: 'OpenText_OTAC' });
    expect(cfg.method).toBe('GET');
    expect(cfg.url).toContain(`docId=${BILL_A}`);
    expect(opts).toEqual({ fetchCsrfToken: false });
  });
});

describe('secKey signing (signed Content Server URLs)', () => {
  // A throwaway RSA key. Node cannot mint an X.509 certificate, so X509Certificate is stubbed to
  // return the hand-built skeleton above; full PKCS#7 validity was checked once against
  // `openssl smime -verify` (RSA/SHA-1, RSA/SHA-256, DSA/SHA-1) when the signer was written.
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  /** The last OCTET STRING of the SignedData is the signature (no attributes, one signer). */
  function signatureOf(p7, size) {
    return p7.subarray(p7.length - size);
  }

  it('formats expiration as UTC yyyymmddhhmmss', () => {
    expect(seckey.expirationStamp(new Date('2026-09-30T13:05:09Z'))).toBe('20260930130509');
  });

  it('signs contRep+docId+accessMode+authId+expiration (URL-encoded), verifiable with the public key', () => {
    const issuerAndSerial = vi.spyOn(crypto, 'X509Certificate')
      .mockImplementation(function Fake() {
        this.raw = FAKE_CERT_DER;
        this.subject = 'CN=TEST_SIGNER';
        this.publicKey = publicKey; // the certificate matches the signing key
      });
    try {
      const now = new Date('2026-09-30T13:00:00Z');
      // authId defaults to the certificate's CN
      const signer = seckey.createSigner({ keyPem, certPem: 'ignored' });
      expect(signer.authId).toBe('CN=TEST_SIGNER');
      // readParams returns the values URL-encoded, ready to append (the strings it signed)
      const out = seckey.readParams({ contRep: 'C1', docId: BILL_A }, signer, now);
      expect(out).toMatchObject({ accessMode: 'r', authId: 'CN%3DTEST_SIGNER', expiration: '20260930130500' });
      const p7 = Buffer.from(decodeURIComponent(out.secKey), 'base64');
      expect(p7[0]).toBe(0x30); // DER SEQUENCE (ContentInfo)
      // signedData OID 1.2.840.113549.1.7.2
      expect(p7.includes(Buffer.from('06092a864886f70d010702', 'hex'))).toBe(true);
      // the SignerInfo names the certificate by its exact issuer + serial bytes
      expect(p7.includes(FAKE_ISSUER_AND_SERIAL)).toBe(true);
      // The message carries authId URL-encoded, as it is sent (what Archive Center verifies).
      const message = Buffer.from(`C1${BILL_A}rCN%3DTEST_SIGNER20260930130500`);
      expect(crypto.verify('sha1', message, publicKey, signatureOf(p7, 256))).toBe(true);
      const plain = Buffer.from(`C1${BILL_A}rCN=TEST_SIGNER20260930130500`);
      expect(crypto.verify('sha1', plain, publicKey, signatureOf(p7, 256))).toBe(false);
    } finally {
      issuerAndSerial.mockRestore();
    }
  });

  it('createSigner refuses a key that does not match the certificate (mid-rotation pair)', () => {
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
    const stub = vi.spyOn(crypto, 'X509Certificate').mockImplementation(function Fake() {
      this.raw = FAKE_CERT_DER;
      this.publicKey = other;
    });
    try {
      expect(() => seckey.createSigner({ keyPem, certPem: 'ignored', authId: 'CN=X' }))
        .toThrow(/does not match the signing certificate/);
    } finally {
      stub.mockRestore();
    }
  });

  it('reads issuer + serial from v1 and v3 certificates', () => {
    expect(seckey.issuerAndSerial(FAKE_CERT_DER).equals(FAKE_ISSUER_AND_SERIAL)).toBe(true);
    // v3: an explicit [0] version precedes the serial
    const tbsBody = Buffer.concat([Buffer.from('a003020102', 'hex'), FAKE_TBS_BODY]);
    const v3 = derSeq(derSeq(tbsBody));
    expect(seckey.issuerAndSerial(v3).equals(FAKE_ISSUER_AND_SERIAL)).toBe(true);
  });

  it('getUrl appends the signature parameters only when a signer is given', () => {
    expect(archivelink.getUrl('C1', BILL_A, 'data')).not.toContain('secKey');
    // readParams returns already-encoded values (the ones it signed): getUrl must not re-encode
    const spy = vi.spyOn(seckey, 'readParams').mockReturnValue({
      accessMode: 'r', authId: 'CN%3DX', expiration: '20260930130500', secKey: 'a%2Bb%2Fc%3D',
    });
    const url = archivelink.getUrl('C1', BILL_A, 'data', { authId: 'CN=X' });
    expect(url).toContain('&accessMode=r&authId=CN%3DX&expiration=20260930130500&secKey=a%2Bb%2Fc%3D');
    spy.mockRestore();
  });

  it('createSigner rejects an unsupported key type or digest up front', () => {
    const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey
      .export({ type: 'pkcs8', format: 'pem' });
    expect(() => seckey.createSigner({ keyPem: ec, certPem: 'x', authId: 'CN=X' }))
      .toThrow(/unsupported signing key type/);
    expect(() => seckey.createSigner({
      keyPem, certPem: 'x', authId: 'CN=X', digest: 'md5',
    })).toThrow(/unsupported digest/);
    const stub = vi.spyOn(crypto, 'X509Certificate').mockImplementation(function Fake() {
      this.raw = FAKE_CERT_DER;
      this.subject = 'O=No CN here';
      this.publicKey = publicKey;
    });
    try {
      expect(() => seckey.createSigner({ keyPem, certPem: 'x', authId: 'CN=Señal' }))
        .toThrow(/printable ASCII/);
      // no authId given and no CN to default from
      expect(() => seckey.createSigner({ keyPem, certPem: 'x' })).toThrow(/printable ASCII/);
    } finally {
      stub.mockRestore();
    }
  });

  it('signing is off (null signer) when no certificate is configured', async () => {
    archivelink.clearSignerCache();
    expect(await archivelink.getSigner()).toBeNull();
  });
});

describe('signing certificate source (Credential Store, env fallback)', () => {
  const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
  const original = { ...credstore.deps };
  const storeError = (status) => Object.assign(new Error(`Credential Store key/x -> HTTP ${status}`), { status });

  beforeEach(() => {
    Object.assign(credstore.deps, original);
    delete process.env.ARCHIVELINK_SIGNING_CERT;
    delete process.env.ARCHIVELINK_SIGNING_CERT_PATH;
  });

  // Leave the real seam and an empty signer cache behind for the suites that follow.
  afterAll(() => {
    Object.assign(credstore.deps, original);
    archivelink.clearSignerCache();
  });

  it('is null when nothing is configured — signing stays off', async () => {
    expect(await credstore.getArchiveLinkSigningCert()).toBeNull();
  });

  it('reads the env fallback when no Credential Store is bound', async () => {
    process.env.ARCHIVELINK_SIGNING_CERT = PEM;
    expect(await credstore.getArchiveLinkSigningCert()).toBe(PEM);
  });

  it('reads the ArchiveLinkSigningCert entry when a Credential Store is bound', async () => {
    credstore.deps.binding = () => ({ url: 'https://credstore' });
    credstore.deps.fetchEntry = vi.fn(async () => ({ value: Buffer.from(PEM).toString('base64') }));
    process.env.ARCHIVELINK_SIGNING_CERT = 'the-store-wins';
    expect(await credstore.getArchiveLinkSigningCert()).toBe(PEM);
    expect(credstore.deps.fetchEntry).toHaveBeenCalledWith(expect.anything(), 'key', 'ArchiveLinkSigningCert');
  });

  it('a bound store with no entry falls back to env, then to null', async () => {
    credstore.deps.binding = () => ({ url: 'https://credstore' });
    credstore.deps.fetchEntry = vi.fn(async () => {
      throw storeError(404);
    });
    expect(await credstore.getArchiveLinkSigningCert()).toBeNull();
    process.env.ARCHIVELINK_SIGNING_CERT = PEM;
    expect(await credstore.getArchiveLinkSigningCert()).toBe(PEM);
  });

  it('a store failure other than 404 is an error, never "signing off"', async () => {
    credstore.deps.binding = () => ({ url: 'https://credstore' });
    credstore.deps.fetchEntry = vi.fn(async () => {
      throw storeError(503);
    });
    await expect(credstore.getArchiveLinkSigningCert()).rejects.toThrow(/HTTP 503/);
    // and the fetcher refuses to go out unsigned when it cannot tell
    archivelink.clearSignerCache();
    await expect(archivelink.getSigner()).rejects.toThrow(/HTTP 503/);
  });
});

describe('doctoken (v2, /doc/:token)', () => {
  it('round-trips a docId and reports expiry', async () => {
    const now = 1_800_000_000;
    const { token, expiresAt } = await doctoken.makeDocToken('abc', { ttlSeconds: 60, now });
    expect(expiresAt.getTime()).toBe((now + 60) * 1000);
    const out = await doctoken.resolveDocToken(token, { now: now + 1 });
    expect(out.docId).toBe('abc');
  });

  it('rejects expired, tampered and malformed tokens', async () => {
    const now = 1_800_000_000;
    const { token } = await doctoken.makeDocToken('abc', { ttlSeconds: 60, now });
    await expect(doctoken.resolveDocToken(token, { now: now + 60 })).rejects.toThrow('expired');
    const [p, sig] = token.split('.');
    const forged = Buffer.from('{"d":"other","e":9999999999,"v":2}').toString('base64url');
    await expect(doctoken.resolveDocToken(`${forged}.${sig}`)).rejects.toThrow('signature mismatch');
    await expect(doctoken.resolveDocToken(p)).rejects.toThrow('malformed token');
  });

  it('is key-separated from v1: a /invoice token never validates as v2, and vice versa', async () => {
    const v1 = await tokenLib.makeToken(2000, { ttlDays: 1 });
    await expect(doctoken.resolveDocToken(v1)).rejects.toThrow('signature mismatch');
    const { token: v2 } = await doctoken.makeDocToken('abc', { ttlSeconds: 60 });
    await expect(tokenLib.resolveToken(v2)).rejects.toThrow();
  });
});

describe('delivery source dispatch', () => {
  it('names ArchiveLink downloads from the declared business link, safely', () => {
    const row = {
      contRep: 'C1', archDocId: BILL_A, docType: 'ISU_BILL', objectId: '050000000006',
    };
    expect(delivery.archiveFileName(row, 'application/pdf')).toBe('ISU_BILL-050000000006.pdf');
    expect(delivery.archiveFileName({ ...row, objectId: '../"evil"\r\n' }, 'application/pdf'))
      .toBe('ISU_BILL-evil.pdf');
    expect(delivery.archiveFileName({ contRep: 'C1', archDocId: BILL_A }, 'application/pdf'))
      .toBe(`C1-${BILL_A}.pdf`);
  });

  it('cdn mode caches ArchiveLink rows under their own key', async () => {
    const spy = vi.spyOn(cdn, 'publishObject').mockResolvedValue('https://cdn/signed');
    const url = await delivery.publishDocument({ source: 'archivelink', contRep: 'C1', archDocId: BILL_A });
    expect(url).toBe('https://cdn/signed');
    const args = spy.mock.calls[0][0];
    expect(args.key).toBe(`archivelink/C1/${BILL_A}`);
    expect(args.sourceOfTruth).toBe('archivelink');
    expect(args.metadata).toEqual({ 'archivelink-contrep': 'C1', 'archivelink-docid': BILL_A });
    spy.mockRestore();
  });

  it('refuses an unknown row source', () => {
    expect(() => delivery.label({ source: 'nope' })).toThrow(/unsupported document source/);
  });
});

describe('LinkService.linkForArchive + GET /doc/:token', () => {
  let link;

  beforeAll(async () => {
    link = await cds.connect.to('LinkService');
  });

  beforeEach(() => {
    archives.clearRegistryCache();
    buckets.clearRegistryCache();
    mockArchive();
  });

  it('S/4 mints a /doc link for an archived bill, and it delivers the bytes', async () => {
    const { data } = await callAs(link, S4, 'linkForArchive', {
      contRep: CONTREP, archDocId: BILL_A, sapObject: 'PRINTDOC', objectId: '050000000006', docType: 'ISU_BILL',
    });
    expect(data.docId).toBeTruthy();
    expect(data.deliveryUrl).toMatch(/^\/doc\//);
    expect(new Date(data.expiresAt).getTime() - Date.now()).toBeLessThan(24 * 3600 * 1000);

    const rows = await SELECT.from(DOCUMENTS).where({ source: 'archivelink', contRep: CONTREP, archDocId: BILL_A });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      docId: data.docId, ownerAzp: S4, sapObject: 'PRINTDOC', docType: 'ISU_BILL', nodeId: null, bucket: null,
    });

    const res = await GET(`/doc/${docTokenOf(data.deliveryUrl)}`, { responseType: 'arraybuffer' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toBe('inline; filename="ISU_BILL-050000000006.pdf"');
    expect(archivelink.deps.executeHttpRequest.mock.calls[0][1].url).toContain(`docId=${BILL_A}`);
  });

  it('is idempotent per archived document, and a reprint is its own row', async () => {
    const first = await callAs(link, S4, 'linkForArchive', { contRep: CONTREP, archDocId: BILL_B });
    const again = await callAs(link, S4, 'linkForArchive', { contRep: CONTREP, archDocId: BILL_B });
    expect(again.data.docId).toBe(first.data.docId);
    const reprint = await callAs(link, S4, 'linkForArchive', {
      contRep: CONTREP, archDocId: '0AFFC37AE2C51FD1AF837DFD85394A0E',
    });
    expect(reprint.data.docId).not.toBe(first.data.docId);
    expect(await SELECT.from(DOCUMENTS).where({ archDocId: BILL_B })).toHaveLength(1);
  });

  it('404s a caller that is not a reader of the repository — mints nothing, no row', async () => {
    const archDocId = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1';
    const err = await callAs(link, OTHER, 'linkForArchive', { contRep: CONTREP, archDocId }).catch((e) => e);
    expect(err.httpStatus).toBe(404);
    const unknownRepo = await callAs(link, S4, 'linkForArchive', { contRep: 'ZZ', archDocId }).catch((e) => e);
    expect(unknownRepo.httpStatus).toBe(404);
    expect(await SELECT.from(DOCUMENTS).where({ archDocId })).toHaveLength(0);
  });

  it('400s a malformed locator or over-long metadata', async () => {
    const bad = await callAs(link, S4, 'linkForArchive', { contRep: CONTREP, archDocId: 'x&compId=y' }).catch((e) => e);
    expect(bad.httpStatus).toBe(400);
    const missing = await callAs(link, S4, 'linkForArchive', { contRep: CONTREP }).catch((e) => e);
    expect(missing.httpStatus).toBe(400);
    const meta = await callAs(link, S4, 'linkForArchive', {
      contRep: CONTREP, archDocId: BILL_A, docType: 'X'.repeat(11),
    }).catch((e) => e);
    expect(meta.httpStatus).toBe(400);
  });

  it('403s a caller whose token carries no azp claim', async () => {
    cds.context = { user: new cds.User({ id: 'no-azp' }) };
    const err = await link.send({ event: 'linkForArchive', data: { contRep: CONTREP, archDocId: BILL_A } })
      .catch((e) => e);
    expect(Number(err.code)).toBe(403);
  });

  it('500s (not 404) when the repository registry is misconfigured', async () => {
    const saved = process.env.ARCHIVELINK_REPOSITORIES;
    process.env.ARCHIVELINK_REPOSITORIES = '{broken';
    archives.clearRegistryCache();
    try {
      const err = await callAs(link, S4, 'linkForArchive', { contRep: CONTREP, archDocId: BILL_A }).catch((e) => e);
      expect(err.httpStatus).toBe(500);
    } finally {
      process.env.ARCHIVELINK_REPOSITORIES = saved;
      archives.clearRegistryCache();
    }
  });

  it('revocation kills future mints AND outstanding /doc links immediately', async () => {
    const archDocId = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2';
    const { data } = await callAs(link, S4, 'linkForArchive', { contRep: CONTREP, archDocId });
    await UPDATE(DOCUMENTS).set({ revoked: true }).where({ docId: data.docId });

    const res = await GET(`/doc/${docTokenOf(data.deliveryUrl)}`).catch((e) => e.response);
    expect(res.status).toBe(404);
    const again = await callAs(link, S4, 'linkForArchive', { contRep: CONTREP, archDocId }).catch((e) => e);
    expect(again.httpStatus).toBe(404);
  });

  it('linkFor(docId) re-mints an ArchiveLink row for its repository readers only', async () => {
    const { data } = await callAs(link, S4, 'linkForArchive', {
      contRep: CONTREP, archDocId: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC3',
    });
    const re = await callAs(link, S4, 'linkFor', { docId: data.docId });
    expect(re.data.deliveryUrl).toMatch(/^\/doc\//);
    // A bucket reader/writer has no authority over an ArchiveLink repository.
    const denied = await callAs(link, OTHER, 'linkFor', { docId: data.docId }).catch((e) => e);
    expect(denied.httpStatus).toBe(404);
  });

  it('/doc answers 403 for a tampered token and 502 when the archive fails', async () => {
    const tampered = await GET('/doc/not.valid').catch((e) => e.response);
    expect(tampered.status).toBe(403);

    const { data } = await callAs(link, S4, 'linkForArchive', {
      contRep: CONTREP, archDocId: 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD4',
    });
    mockArchive({ status: 404 });
    const res = await GET(`/doc/${docTokenOf(data.deliveryUrl)}`).catch((e) => e.response);
    expect(res.status).toBe(502);
  });

  it('serves a non-allowlisted type (HTML) as an attachment with nosniff — no stored XSS', async () => {
    const { data } = await callAs(link, S4, 'linkForArchive', {
      contRep: CONTREP, archDocId: 'EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE5',
    });
    mockArchive({ contentType: 'text/html' });
    const res = await GET(`/doc/${docTokenOf(data.deliveryUrl)}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('a 502 tells the anonymous caller nothing about the backend', async () => {
    const { data } = await callAs(link, S4, 'linkForArchive', {
      contRep: CONTREP, archDocId: 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF6',
    });
    mockArchive({ status: 500 });
    const res = await GET(`/doc/${docTokenOf(data.deliveryUrl)}`).catch((e) => e.response);
    expect(res.status).toBe(502);
    expect(res.data).toBe('document temporarily unavailable');
  });

  it('revoking one of two racing rows for a locator revokes the document (mint + outstanding links)', async () => {
    const archDocId = 'GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG7';
    const { data } = await callAs(link, S4, 'linkForArchive', { contRep: CONTREP, archDocId });
    // Simulate the concurrent-first-claim race: a second row for the same locator.
    await INSERT.into(DOCUMENTS).entries({
      docId: 'racing-duplicate', source: 'archivelink', contRep: CONTREP, archDocId, ownerAzp: S4, revoked: false, createdAt: new Date().toISOString(),
    });
    await UPDATE(DOCUMENTS).set({ revoked: true }).where({ docId: 'racing-duplicate' });

    const mint = await callAs(link, S4, 'linkForArchive', { contRep: CONTREP, archDocId }).catch((e) => e);
    expect(mint.httpStatus).toBe(404);
    const res = await GET(`/doc/${docTokenOf(data.deliveryUrl)}`).catch((e) => e.response);
    expect(res.status).toBe(404);
  });

  it('caps a /doc link TTL (DOC_LINK_MAX_TTL_DAYS, default 90)', async () => {
    const { data } = await callAs(link, S4, 'linkForArchive', {
      contRep: CONTREP, archDocId: 'HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH8', ttlDays: 3650,
    });
    const days = (new Date(data.expiresAt).getTime() - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThanOrEqual(90);
  });

  it('linkFor answers 500 (not a bare throw) when the repository registry is misconfigured', async () => {
    const { data } = await callAs(link, S4, 'linkForArchive', {
      contRep: CONTREP, archDocId: 'JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ9',
    });
    const saved = process.env.ARCHIVELINK_REPOSITORIES;
    process.env.ARCHIVELINK_REPOSITORIES = '{broken';
    archives.clearRegistryCache();
    try {
      const err = await callAs(link, S4, 'linkFor', { docId: data.docId }).catch((e) => e);
      expect(err.httpStatus).toBe(500);
      expect(err.message).toBe('registry is misconfigured');
    } finally {
      process.env.ARCHIVELINK_REPOSITORIES = saved;
      archives.clearRegistryCache();
    }
  });

  it('/doc answers 404 (not 500) for a row with an unknown source', async () => {
    const docId = 'row-with-unknown-source';
    await INSERT.into(DOCUMENTS).entries({
      docId, source: 'mystery', ownerAzp: S4, revoked: false, createdAt: new Date().toISOString(),
    });
    const { token } = await doctoken.makeDocToken(docId, { ttlSeconds: 60 });
    const res = await GET(`/doc/${token}`).catch((e) => e.response);
    expect(res.status).toBe(404);
  });

  it('/doc also serves an OpenText row (one v2 route for every source)', async () => {
    const docId = 'otcs-row-for-doc-route';
    await INSERT.into(DOCUMENTS).entries({
      docId, source: 'otcs', nodeId: 4242, bucket: 'billing', ownerAzp: OTHER, revoked: false, createdAt: new Date().toISOString(),
    });
    const spy = vi.spyOn(delivery.SOURCES.otcs, 'fetch').mockResolvedValue({
      buffer: Buffer.from('%PDF otcs'), contentType: 'application/pdf', fileName: 'x.pdf',
    });
    const { token } = await doctoken.makeDocToken(docId, { ttlSeconds: 60 });
    const res = await GET(`/doc/${token}`);
    expect(res.status).toBe(200);
    expect(spy.mock.calls[0][0]).toMatchObject({ nodeId: 4242 });
    spy.mockRestore();
  });
});
