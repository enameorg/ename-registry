import { strict as assert } from 'node:assert';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  Base64URLSchema,
  canonicalizeDocument,
  encodePublicKey,
  generateKeyPair,
  isValidPublicKey,
  signDocument,
  verifyDocumentSignature,
} from './signature.ts';

// The JCS conformance of the canonicalization every signature rests on, against the reference
// vectors of RFC 8785 (test-data/jcs/NOTICE): a dependency upgrade that changes one byte of the
// canonical form fails here before it can invalidate a signature. Then the signature and key rules
// themselves.

const TEST_DATA = new URL('./test-data/jcs/', import.meta.url);

// ---------------------------------------------------------------------------
// JCS conformance
// ---------------------------------------------------------------------------

test('canonicalizeDocument turns every reference input into its reference output, byte for byte', () => {
  const names = readdirSync(new URL('input/', TEST_DATA));
  assert.ok(names.length > 0);
  for (const name of names) {
    const input: unknown = JSON.parse(readFileSync(new URL(`input/${name}`, TEST_DATA), 'utf8'));
    const expected = readFileSync(new URL(`output/${name}`, TEST_DATA), 'utf8');
    assert.equal(canonicalizeDocument(input), expected, name);
  }
});

test('canonicalizeDocument serializes numbers as the reference ES6 vectors do', () => {
  const lines = readFileSync(new URL('es6-numbers.txt', TEST_DATA), 'utf8').trimEnd().split('\n');
  assert.equal(lines.length, 10_000);
  const bits = new DataView(new ArrayBuffer(8));
  for (const line of lines) {
    const [hex = '', expected] = line.split(',');
    bits.setBigUint64(0, BigInt(`0x${hex}`));
    const value = bits.getFloat64(0);
    // NaN and the infinities are not JSON, so the vectors list none.
    assert.equal(canonicalizeDocument(value), expected, line);
  }
});

test('canonicalizeDocument refuses what JCS excludes', () => {
  assert.throws(() => canonicalizeDocument({ text: '\ud800' }), /Lone surrogate/);
  assert.throws(() => canonicalizeDocument({ value: Number.NaN }), /NaN/);
  assert.throws(() => canonicalizeDocument({ value: Number.POSITIVE_INFINITY }), /Infinity/);
  assert.throws(() => canonicalizeDocument(undefined), /no JSON representation/);
});

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

const document = { operation: 'subject.register', request: { b: 1, a: 'x' } };

test('a signature verifies against the same document whatever its key order, and only with its key', () => {
  const { publicKey, privateKey } = generateKeyPair();
  const key = { algorithm: 'ecdsa-p256-sha256' as const, value: encodePublicKey(publicKey) };
  const signature = signDocument(privateKey, document);

  assert.equal(signature.length, 86);
  assert.equal(
    verifyDocumentSignature(
      key,
      { request: { a: 'x', b: 1 }, operation: 'subject.register' },
      signature,
    ),
    true,
  );
  assert.equal(
    verifyDocumentSignature(key, { ...document, operation: 'subject.add-ename' }, signature),
    false,
  );

  const other = {
    algorithm: 'ecdsa-p256-sha256' as const,
    value: encodePublicKey(generateKeyPair().publicKey),
  };
  assert.equal(verifyDocumentSignature(other, document, signature), false);
});

test('a malformed signature or key verifies nothing, without throwing', () => {
  const { publicKey, privateKey } = generateKeyPair();
  const key = { algorithm: 'ecdsa-p256-sha256' as const, value: encodePublicKey(publicKey) };
  const signature = signDocument(privateKey, document);

  assert.equal(verifyDocumentSignature(key, document, signature.slice(0, -2)), false);
  assert.equal(verifyDocumentSignature(key, document, `${signature}AA`), false);
  assert.equal(verifyDocumentSignature({ ...key, value: 'AAAA' }, document, signature), false);
});

test('isValidPublicKey accepts a P-256 SPKI key in its exported bytes, and nothing else', () => {
  const value = encodePublicKey(generateKeyPair().publicKey);
  assert.equal(isValidPublicKey({ algorithm: 'ecdsa-p256-sha256', value }), true);

  // A key of another algorithm: valid SPKI, but not the declared one.
  const ed25519 = encodePublicKey(generateKeyPairSync('ed25519').publicKey);
  assert.equal(isValidPublicKey({ algorithm: 'ecdsa-p256-sha256', value: ed25519 }), false);
  assert.equal(isValidPublicKey({ algorithm: 'ecdsa-p256-sha256', value: 'AAAA' }), false);
});

test('Base64URLSchema accepts canonical unpadded base64url only', () => {
  assert.equal(Base64URLSchema.safeParse('AQID').success, true);
  for (const value of ['AQID==', 'AQ+D', 'AQ/D', 'AQF', '']) {
    const result = Base64URLSchema.safeParse(value);
    assert.equal(result.success, false, value);
    assert.equal(result.error?.issues.length, 1, value);
    assert.equal(result.error?.issues[0]?.message, 'must be base64url without padding');
  }
});

// ---------------------------------------------------------------------------
// The test vector of docs/ename-signature.md
// ---------------------------------------------------------------------------

// Copied from the standard, which publishes it for every implementer: the implementation must
// reproduce its canonical bytes and fingerprint and accept its signature, so the published vector
// and the code cannot drift apart.
const VECTOR = {
  privateKey: [
    '-----BEGIN PRIVATE KEY-----',
    'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg0u7P2KpW4OGTdGhD',
    'qdhL6gWZEaaMRt3hbg/ibmHU3tahRANCAARW3Z43W+7lfagp0wtHSHkAz58EzElm',
    'LD++zNu0dkkXIU7zPAMVUAVv2fUr4VFLB/xc0mcSGYaf/2nnV5u/gg2o',
    '-----END PRIVATE KEY-----',
  ].join('\n'),
  publicKey:
    'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEVt2eN1vu5X2oKdMLR0h5AM-fBMxJZiw_vszbtHZJFyFO8zwDFVAFb9n1K-FRSwf8XNJnEhmGn_9p51ebv4INqA',
  fingerprint: '2d8066fabd9af7124886fd3f184a0b5c50b33d79571613cd81435b6953b298ee',
  document: {
    operation: 'subject.register',
    keyId: '01927e8f-9b2a-7c3d-8e4f-5a6b7c8d9e4c',
    idempotencyKey: '01927e8f-9b2a-7c3d-8e4f-5a6b7c8d9e0f',
    request: { subject: { kind: 'person' }, ename: { namePart: 'jean-dupont' } },
  },
  canonical:
    '{"idempotencyKey":"01927e8f-9b2a-7c3d-8e4f-5a6b7c8d9e0f","keyId":"01927e8f-9b2a-7c3d-8e4f-5a6b7c8d9e4c","operation":"subject.register","request":{"ename":{"namePart":"jean-dupont"},"subject":{"kind":"person"}}}',
  canonicalDigest: '890322738fbd29fb200719fc83b0e7ca93dd93a91935e6f9a3f2c3c1934b476b',
  signature:
    'qTkPH6h79mbRd9_R9DTCf7G_twazfHsA6sK2NfCMWBH1iBPuaO8qINNAwD43cuXdPMn1efkprJ22LxJ8zi6QXw',
};

test('the published test vector: its canonical bytes, its fingerprint, its signature', () => {
  const key = { algorithm: 'ecdsa-p256-sha256' as const, value: VECTOR.publicKey };
  const privateKey = createPrivateKey(VECTOR.privateKey);

  assert.equal(encodePublicKey(createPublicKey(privateKey)), VECTOR.publicKey);
  assert.equal(
    createHash('sha256').update(Buffer.from(VECTOR.publicKey, 'base64url')).digest('hex'),
    VECTOR.fingerprint,
  );
  assert.equal(canonicalizeDocument(VECTOR.document), VECTOR.canonical);
  assert.equal(
    createHash('sha256').update(VECTOR.canonical, 'utf8').digest('hex'),
    VECTOR.canonicalDigest,
  );
  assert.equal(verifyDocumentSignature(key, VECTOR.document, VECTOR.signature), true);
  // ECDSA is randomized: a new signature differs and verifies too.
  const again = signDocument(privateKey, VECTOR.document);
  assert.notEqual(again, VECTOR.signature);
  assert.equal(verifyDocumentSignature(key, VECTOR.document, again), true);
});
