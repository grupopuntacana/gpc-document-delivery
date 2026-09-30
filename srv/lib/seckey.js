'use strict';

/**
 * `secKey` — the signed-URL credential of the SAP Content Server HTTP protocol (ADR 0009).
 *
 * A repository that enforces security (ours does: an unsigned `get` on C1 answers
 * `401 ICS:3003 The URL is not signed or signature is invalid, parameter secKey`) only serves
 * a request whose URL carries
 *
 *   accessMode=r & authId=<signer> & expiration=<UTC yyyymmddhhmmss> & secKey=<signature>
 *
 * where `secKey` is a base64 **PKCS#7 SignedData, detached**, over the concatenation (no
 * separators) of the signed parameter values, URL-encoded as they are sent — for `get` / `info`:
 *
 *   contRep + docId + accessMode + authId + expiration      e.g. `C1<docId>rCN%3DBTP_X<stamp>`
 *
 * and the server verifies it against a certificate registered on the repository under `authId`.
 * C1's registered certificates (`getCert`) include RSA ones, so an ordinary RSA key works; DSA
 * (SAP's classic SSF default) is supported too.
 *
 * Built with `node:crypto` plus a ~40-line DER writer rather than a PKCS#7 dependency: the
 * structure is tiny and fixed (one signer, no signed attributes, no embedded certificate — the
 * server already holds it), and it keeps the dependency surface of the anonymous path small.
 */

const crypto = require('crypto');

// --- minimal DER ---
function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([0x80 + bytes.length, ...bytes]);
}
const der = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
};
const seq = (...p) => der(0x30, ...p);
const set = (...p) => der(0x31, ...p);
const octets = (b) => der(0x04, b);
const NULL = Buffer.from([0x05, 0x00]);
const INT_1 = Buffer.from([0x02, 0x01, 0x01]);

function oid(dotted) {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const bytes = [a * 40 + b];
  rest.forEach((n) => {
    const chunk = [n % 128];
    for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128)) {
      chunk.unshift(0x80 + (v % 128));
    }
    bytes.push(...chunk);
  });
  return der(0x06, Buffer.from(bytes));
}

/** Read one TLV at `offset`; `end` is also where the next sibling starts. */
function readTlv(buf, offset) {
  const tag = buf[offset];
  let len = buf[offset + 1];
  let start = offset + 2;
  if (len >= 0x80) {
    const n = len - 0x80;
    len = 0;
    for (let i = 0; i < n; i += 1) len = len * 256 + buf[start + i];
    start += n;
  }
  return { tag, start, end: start + len };
}

/**
 * The raw DER `issuer` Name and `serialNumber` INTEGER of a certificate — the pair a PKCS#7
 * SignerInfo uses to say which certificate signed. Copied byte-for-byte from the certificate
 * (never re-encoded) so they match exactly what the archive server stored.
 */
function issuerAndSerial(certDer) {
  const cert = readTlv(certDer, 0);
  const tbs = readTlv(certDer, cert.start);
  let serialOffset = tbs.start;
  let serial = readTlv(certDer, serialOffset);
  if (serial.tag === 0xa0) { // optional [0] version (absent on v1 certificates)
    serialOffset = serial.end;
    serial = readTlv(certDer, serialOffset);
  }
  if (serial.tag !== 0x02) throw new Error('certificate: serialNumber not found');
  const sigAlg = readTlv(certDer, serial.end);
  const issuer = readTlv(certDer, sigAlg.end);
  if (issuer.tag !== 0x30) throw new Error('certificate: issuer not found');
  return Buffer.concat([
    certDer.subarray(sigAlg.end, issuer.end),
    certDer.subarray(serialOffset, serial.end),
  ]);
}

const DIGEST_OID = { sha1: '1.3.14.3.2.26', sha256: '2.16.840.1.101.3.4.2.1' };
const OID = {
  signedData: '1.2.840.113549.1.7.2',
  data: '1.2.840.113549.1.7.1',
  rsaEncryption: '1.2.840.113549.1.1.1',
  dsa: '1.2.840.10040.4.1',
};

/**
 * Parse and validate the signing material ONCE. Everything a signature needs that does not
 * depend on the message — the key object, the certificate's issuer+serial, the algorithm
 * identifiers — is computed here, so signing a request is one `crypto.sign` plus a few concats.
 * @param {{keyPem:string, certPem:string, authId:string, digest?:('sha1'|'sha256')}} material
 */
function createSigner({
  keyPem, certPem, authId, digest = 'sha1',
}) {
  const key = crypto.createPrivateKey(keyPem);
  const type = key.asymmetricKeyType;
  if (type !== 'rsa' && type !== 'dsa') throw new Error(`unsupported signing key type: ${type}`);
  if (!DIGEST_OID[digest]) throw new Error(`unsupported digest: ${digest}`);
  // The signed message is the raw bytes of the parameter values. A non-ASCII authId would be
  // signed in one encoding and compared by the server in another, failing with no local error.
  if (!/^[\x20-\x7e]+$/.test(authId || '')) {
    throw new Error('authId is required and must be printable ASCII');
  }
  return {
    authId,
    digest,
    key,
    signerId: seq(issuerAndSerial(new crypto.X509Certificate(certPem).raw)),
    digestAlg: seq(oid(DIGEST_OID[digest]), NULL),
    signatureAlg: type === 'rsa' ? seq(oid(OID.rsaEncryption), NULL) : seq(oid(OID.dsa)),
  };
}

/**
 * PKCS#7 SignedData (detached, one signer, no attributes, no certificates) over `message`.
 * @param {Buffer} message
 * @param {ReturnType<typeof createSigner>} signer
 * @returns {Buffer} DER
 */
function signDetached(message, signer) {
  // RSA: PKCS#1 v1.5 over DigestInfo; DSA: a DER Dss-Sig-Value — both what crypto.sign emits.
  const signature = crypto.sign(signer.digest, message, signer.key);
  const signerInfo = seq(
    INT_1,
    signer.signerId,
    signer.digestAlg,
    signer.signatureAlg,
    octets(signature),
  );
  const signedData = seq(
    INT_1,
    set(signer.digestAlg),
    seq(oid(OID.data)), // detached: contentInfo carries the type only, no content
    set(signerInfo),
  );
  return seq(oid(OID.signedData), der(0xa0, signedData));
}

/** `yyyymmddhhmmss` in UTC — the protocol's `expiration` format. */
function expirationStamp(date) {
  return date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

// A signed URL only has to outlive one request through the tunnel.
const SIGNATURE_TTL_SECONDS = 300;

/**
 * The four signature parameters for a read of one document.
 * @param {{contRep:string, docId:string}} doc
 * @param {ReturnType<typeof createSigner>} signer
 * @param {Date} [now]
 * @returns {{accessMode:string, authId:string, expiration:string, secKey:string}}
 */
function readParams({ contRep, docId }, signer, now = new Date()) {
  const accessMode = 'r';
  const { authId } = signer;
  const expiration = expirationStamp(new Date(now.getTime() + SIGNATURE_TTL_SECONDS * 1000));
  // The server verifies against the values AS THEY APPEAR IN THE URL, i.e. still URL-encoded
  // (found against Archive Center 25.4: signing the plain `CN=X` fails with ICS:3009, signing
  // `CN%3DX` succeeds). Encode here exactly as archivelink.getUrl does.
  const message = Buffer.from(
    [contRep, docId, accessMode, authId, expiration].map(encodeURIComponent).join(''),
    'latin1',
  );
  return {
    accessMode, authId, expiration, secKey: signDetached(message, signer).toString('base64'),
  };
}

module.exports = {
  createSigner,
  readParams,
  // exported for unit tests
  signDetached,
  issuerAndSerial,
  expirationStamp,
};
