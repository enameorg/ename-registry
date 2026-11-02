import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { pino } from 'pino';

import { pool } from '../../database/pool.ts';
import { useTestDatabase } from '../../database/testing.ts';
import { generateUUIDv7 } from '../../utilities/uuid.ts';
import { createSignature } from '../common/index.ts';
import { AuthorizationError } from '../errors.ts';
import { insertTestKey, insertTestPlatform } from '../testing.ts';

import { authenticateRegistry } from './registry.ts';

// The authentication of the registry as a signer: which keys it admits, the signature itself being
// authenticateKey's. The anchor's signer is tested with the anchor.
// Test doctrine: ename-internals.md.
const logger = pino({ level: 'silent' });

useTestDatabase();

// A document as the registry signs it, under this keyId.
function makeDocument(keyId: string) {
  return {
    operation: 'platform.add-key',
    keyId,
    idempotencyKey: generateUUIDv7(),
    request: { platform: { id: generateUUIDv7() } },
  };
}

test('authenticateRegistry returns the signer, { keyId }, of a registry key', async () => {
  const signer = await insertTestKey(pool, null);
  const document = makeDocument(signer.keyId);
  const { value } = createSignature(signer.privateKey, document);

  assert.deepEqual(await authenticateRegistry(pool, document, value, logger), {
    keyId: signer.keyId,
  });
});

test('authenticateRegistry refuses a verified platform key as an AuthorizationError', async () => {
  const platform = await insertTestPlatform(pool);
  const signer = await insertTestKey(pool, platform.id);
  const document = makeDocument(signer.keyId);
  const { value } = createSignature(signer.privateKey, document);

  await assert.rejects(
    () => authenticateRegistry(pool, document, value, logger),
    (error: unknown) =>
      error instanceof AuthorizationError &&
      error.message === 'The signing key is not allowed to submit this request.',
  );
});
