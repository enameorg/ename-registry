import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { pino } from 'pino';

import { pool } from '../../database/pool.ts';
import { useTestDatabase } from '../../database/testing.ts';
import { generateUUIDv7 } from '../../utilities/uuid.ts';
import { createSignature } from '../common/index.ts';
import { AuthorizationError, ConflictError } from '../errors.ts';
import { insertTestKey, makePlatformInput } from '../testing.ts';

import {
  authenticatePlatform,
  findPlatforms,
  getPlatform,
  insertPlatform,
  PlatformInputSchema,
} from './platform.ts';

// Direct tests of the platform data-access primitives (insert + read round-trip, the
// one-platform-per-entity constraint), the legal identity rules, then the authentication of a
// platform's signer: which keys it admits, the signature itself being authenticateKey's.
// Test doctrine: ename-internals.md.
const logger = pino({ level: 'silent' });

useTestDatabase();

// ---------------------------------------------------------------------------
// Primitives and the legal identity rules
// ---------------------------------------------------------------------------

function makePlatform() {
  return { id: generateUUIDv7(), ...makePlatformInput(), createdAt: new Date() };
}

test('insertPlatform then read back by id and via findPlatforms', async () => {
  const platform = makePlatform();

  assert.deepEqual(await insertPlatform(pool, platform), platform);
  assert.deepEqual(await getPlatform(pool, platform.id), platform);
  assert.deepEqual(await findPlatforms(pool), [platform]);
});

test('getPlatform returns undefined for an unknown id', async () => {
  assert.equal(await getPlatform(pool, generateUUIDv7()), undefined);
});

test('a second platform for the same registration throws ConflictError, whatever its legal name', async () => {
  const platform = makePlatform();
  await insertPlatform(pool, platform);

  await assert.rejects(
    () => insertPlatform(pool, { ...platform, id: generateUUIDv7(), legalName: 'ANOTHER NAME' }),
    (error: unknown) =>
      error instanceof ConflictError &&
      error.message === 'A platform is already accredited for this registration.',
  );
  // The same identifier in another register is another legal entity.
  const elsewhere = { ...platform, id: generateUUIDv7(), registrationAuthorityCode: 'RA000665' };
  assert.deepEqual(await insertPlatform(pool, elsewhere), elsewhere);
});

test('PlatformInputSchema accepts a country or a subdivision and a GLEIF code, and rejects other forms', () => {
  const input = makePlatformInput();
  assert.equal(PlatformInputSchema.safeParse(input).success, true);
  assert.equal(PlatformInputSchema.safeParse({ ...input, jurisdiction: 'US-DE' }).success, true);

  for (const [field, value] of [
    ['jurisdiction', 'fr'],
    ['jurisdiction', 'FRA'],
    ['registrationAuthorityCode', 'RA189'],
    ['registrationAuthorityCode', 'XX000189'],
    ['legalName', ''],
    ['registrationIdentifier', ''],
  ] as const) {
    const result = PlatformInputSchema.safeParse({ ...input, [field]: value });
    assert.equal(result.success, false, `${field}: ${value}`);
    assert.deepEqual(result.error?.issues[0]?.path, [field]);
  }
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

test('authenticatePlatform returns the signing key and the platform that holds it', async () => {
  const platform = makePlatform();
  await insertPlatform(pool, platform);
  const signer = await insertTestKey(pool, platform.id);
  const document = makeDocument(signer.keyId);
  const { value } = createSignature(signer.privateKey, document);

  assert.deepEqual(await authenticatePlatform(pool, document, value, logger), {
    keyId: signer.keyId,
    platformId: platform.id,
  });
});

test('authenticatePlatform refuses a verified registry key as an AuthorizationError', async () => {
  const signer = await insertTestKey(pool, null);
  const document = makeDocument(signer.keyId);
  const { value } = createSignature(signer.privateKey, document);

  await assert.rejects(
    () => authenticatePlatform(pool, document, value, logger),
    (error: unknown) =>
      error instanceof AuthorizationError &&
      error.message === 'The signing key is not allowed to submit this request.',
  );
});
