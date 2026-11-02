import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { pino } from 'pino';

import { pool } from '../../database/pool.ts';
import { readCheckConstraintValues, useTestDatabase } from '../../database/testing.ts';
import { KeyAlgorithmSchema } from '../../utilities/signature.ts';
import { generateUUIDv7 } from '../../utilities/uuid.ts';
import { createSignature } from '../common/index.ts';
import { AuthenticationError, ConflictError, NotFoundError } from '../errors.ts';
import { generateTestKey, insertTestKey, insertTestPlatform } from '../testing.ts';

import {
  authenticateKey,
  findKeys,
  getKey,
  insertKey,
  isPlatformKey,
  isRegistryKey,
  KeyInputSchema,
} from './key.ts';

// Direct tests of the key data-access primitives (insert + read round-trip,
// for a registry key and a platform key), the rule that tells a key's owner,
// the authentication of a signature by a recorded key, the key input rule,
// then the algorithm vocabulary against its CHECK. Test doctrine:
// ename-internals.md.
const logger = pino({ level: 'silent' });

useTestDatabase();

// ---------------------------------------------------------------------------
// Primitives and the owner of a key
// ---------------------------------------------------------------------------

function makeKey(platformId: string | null) {
  return {
    id: generateUUIDv7(),
    platformId,
    algorithm: 'ecdsa-p256-sha256' as const,
    value: generateTestKey().publicKey,
    createdAt: new Date(),
  };
}

test('insertKey then read back by id and via findKeys, with or without a platform', async () => {
  const platform = await insertTestPlatform(pool);
  const registryKey = makeKey(null);
  const platformKey = makeKey(platform.id);

  assert.deepEqual(await insertKey(pool, registryKey), registryKey);
  assert.deepEqual(await insertKey(pool, platformKey), platformKey);

  assert.deepEqual(await getKey(pool, registryKey.id), registryKey);
  assert.deepEqual(await getKey(pool, platformKey.id), platformKey);
  assert.deepEqual(
    new Set((await findKeys(pool)).map((key) => key.id)),
    new Set([registryKey.id, platformKey.id]),
  );
});

test('getKey returns undefined for an unknown id', async () => {
  assert.equal(await getKey(pool, generateUUIDv7()), undefined);
});

test('insertKey for a platform that does not exist throws NotFoundError', async () => {
  await assert.rejects(
    () => insertKey(pool, makeKey(generateUUIDv7())),
    (error: unknown) => error instanceof NotFoundError && error.message === 'Platform not found.',
  );
});

test('insertKey under an id already recorded throws ConflictError', async () => {
  const key = makeKey(null);
  await insertKey(pool, key);

  await assert.rejects(
    () => insertKey(pool, { ...makeKey(null), id: key.id }),
    (error: unknown) =>
      error instanceof ConflictError &&
      error.message === 'A key is already recorded under this id.',
  );
});

test('a key with a platform is a platform key, a key with none a registry key', () => {
  const platformKey = makeKey(generateUUIDv7());
  const registryKey = makeKey(null);

  assert.equal(isPlatformKey(platformKey), true);
  assert.equal(isRegistryKey(platformKey), false);
  assert.equal(isPlatformKey(registryKey), false);
  assert.equal(isRegistryKey(registryKey), true);
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

// A document as a signer signs it, under this keyId.
function makeDocument(keyId: string) {
  return {
    operation: 'subject.register',
    keyId,
    idempotencyKey: generateUUIDv7(),
    request: { subject: { kind: 'person' }, ename: { namePart: 'jean-dupont' } },
  };
}

test('authenticateKey returns the recorded key that signed the document', async () => {
  const signer = await insertTestKey(pool, null);
  const document = makeDocument(signer.keyId);
  const { value } = createSignature(signer.privateKey, document);

  assert.deepEqual(
    await authenticateKey(pool, document, value, logger),
    await getKey(pool, signer.keyId),
  );
});

test('an unknown keyId, a signature by another key and a signature of another document are one AuthenticationError', async () => {
  const signer = await insertTestKey(pool, null);
  const document = makeDocument(signer.keyId);
  const unknown = makeDocument(generateUUIDv7());

  for (const attempt of [
    { document: unknown, value: createSignature(signer.privateKey, unknown).value },
    { document, value: createSignature(generateTestKey().privateKey, document).value },
    {
      document,
      value: createSignature(signer.privateKey, { ...document, idempotencyKey: generateUUIDv7() })
        .value,
    },
  ]) {
    await assert.rejects(
      () => authenticateKey(pool, attempt.document, attempt.value, logger),
      (error: unknown) =>
        error instanceof AuthenticationError &&
        error.message === 'The request signature could not be verified.',
    );
  }
});

// ---------------------------------------------------------------------------
// Key input and algorithm vocabulary
// ---------------------------------------------------------------------------

test('KeyInputSchema accepts a P-256 SPKI key and rejects a value that is no key of the declared algorithm', () => {
  const value = generateTestKey().publicKey;
  assert.equal(KeyInputSchema.safeParse({ algorithm: 'ecdsa-p256-sha256', value }).success, true);

  const result = KeyInputSchema.safeParse({ algorithm: 'ecdsa-p256-sha256', value: 'AAAA' });
  assert.equal(result.success, false);
  assert.deepEqual(result.error?.issues[0]?.path, ['value']);
  assert.equal(
    result.error?.issues[0]?.message,
    'must be an SPKI public key of the declared algorithm',
  );
});

// The algorithm vocabulary is declared once in code (KeyAlgorithmSchema) and
// once in the database (the keys_algorithm_allowed CHECK); this pins that the
// two agree, in both directions.
test('the algorithms KeyAlgorithmSchema declares are exactly the algorithms the keys_algorithm_allowed CHECK admits', async () => {
  const admitted = await readCheckConstraintValues('keys_algorithm_allowed');

  assert.deepEqual(
    admitted.toSorted(),
    [...KeyAlgorithmSchema.options].toSorted(),
    'keys.algorithm: the CHECK and KeyAlgorithmSchema disagree',
  );
});
