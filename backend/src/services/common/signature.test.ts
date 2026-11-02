import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { encodePublicKey, generateKeyPair } from '../../utilities/signature.ts';
import { generateUUIDv7 } from '../../utilities/uuid.ts';
import { ValidationError } from '../errors.ts';

import { assertPortableValues, createSignature, isSignatureValid } from './signature.ts';

// The signature of a request as the Service builds and checks it, without a
// database: what it covers, and what a request must be to be signed at all.
// The mechanism underneath (JCS, ES256, keys) is tested in utilities.

const { publicKey, privateKey } = generateKeyPair();
const key = { algorithm: 'ecdsa-p256-sha256' as const, value: encodePublicKey(publicKey) };
const document = {
  operation: 'subject.register',
  keyId: generateUUIDv7(),
  idempotencyKey: generateUUIDv7(),
  request: { subject: { kind: 'person' }, ename: { namePart: 'jean-dupont' } },
};

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

test("a signature created for a document names the document's key and verifies against it", () => {
  const signature = createSignature(privateKey, document);

  assert.equal(signature.keyId, document.keyId);
  assert.equal(isSignatureValid(key, document, signature.value), true);
});

test('a signature does not verify once any member of its document changes', () => {
  const { value } = createSignature(privateKey, document);

  for (const changed of [
    { ...document, operation: 'subject.add-ename' },
    { ...document, keyId: generateUUIDv7() },
    { ...document, idempotencyKey: generateUUIDv7() },
    { ...document, request: { ...document.request, ename: { namePart: 'jean' } } },
  ]) {
    assert.equal(isSignatureValid(key, changed, value), false);
  }
});

// ---------------------------------------------------------------------------
// What a request must be to be signed
// ---------------------------------------------------------------------------

test('assertPortableValues accepts a request of strings, integers, booleans, nulls, arrays and objects', () => {
  assert.doesNotThrow(() =>
    assertPortableValues({ text: 'Élodie 👋', count: -12, flag: true, none: null, list: [1, 'a'] }),
  );
});

test('assertPortableValues refuses a value no signature can cover as a ValidationError at its path', () => {
  for (const scenario of [
    {
      request: { platform: { legalName: 'ACME \ud800' } },
      issue: { path: ['platform', 'legalName'], message: 'must be well-formed Unicode text' },
    },
    {
      request: { list: ['ok', '\udc00'] },
      issue: { path: ['list', 1], message: 'must be well-formed Unicode text' },
    },
    {
      request: { amount: 1.5 },
      issue: { path: ['amount'], message: 'must be an integer' },
    },
    {
      request: { amount: 1e21 },
      issue: { path: ['amount'], message: 'must be an integer' },
    },
    {
      request: { ['\ud800']: 'value' },
      issue: { path: ['\ud800'], message: 'must be a well-formed Unicode name' },
    },
  ]) {
    assert.throws(
      () => assertPortableValues(scenario.request),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.deepEqual(error.errors, [scenario.issue]);
        return true;
      },
    );
  }
});
