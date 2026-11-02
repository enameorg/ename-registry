import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { pino } from 'pino';

import { pool } from '../../database/pool.ts';
import { withTransaction } from '../../database/query.ts';
import { truncateProjections, useTestDatabase } from '../../database/testing.ts';
import { generateUUIDv7 } from '../../utilities/uuid.ts';
import { NotFoundError } from '../errors.ts';
import { findEvents, isEventSignatureValid, parseEvent } from '../event/index.ts';
import { findKeys, getKey } from '../key/index.ts';
import {
  generateTestKey,
  rebuildEvents,
  setUpEventKindDefinitions,
  setUpTestPlatform,
  signInput,
  type TestSigner,
} from '../testing.ts';

import {
  addPlatformKey,
  type AddPlatformKeyResult,
  platformKeyAddedEventKindDefinition,
} from './add-platform-key.ts';

// What this use case adds to the write protocol: its kind's mapping, the row it writes, its rebuild
// from the log, the unknown platform; its signer's authentication is authenticateRegistry's, tested
// in services/registry/registry.test.ts; idempotency is withEvent's, tested in
// services/event/with-event.test.ts. Test doctrine: ename-internals.md.
const silentLogger = pino({ level: 'silent' });
const context = { logger: silentLogger };

useTestDatabase();

async function addKey(registry: TestSigner, platformId: string) {
  return await addPlatformKey(
    signInput(platformKeyAddedEventKindDefinition, registry, {
      idempotencyKey: generateUUIDv7(),
      platform: { id: platformId },
      key: { algorithm: 'ecdsa-p256-sha256', value: generateTestKey().publicKey },
    }),
    context,
  );
}

test('toOutcome keeps what the server allocated, and fromEvent reads it back as the key row written', () => {
  const platformId = generateUUIDv7();
  const keyId = generateUUIDv7();
  const createdAt = new Date('2026-10-30T09:12:44.512Z');
  const key = { algorithm: 'ecdsa-p256-sha256' as const, value: generateTestKey().publicKey };
  const request = { platform: { id: platformId }, key };
  const row: AddPlatformKeyResult = { id: keyId, platformId, ...key, createdAt };

  const outcome = platformKeyAddedEventKindDefinition.toOutcome(row);
  assert.deepEqual(outcome, { key: { id: keyId } });
  assert.deepEqual(
    platformKeyAddedEventKindDefinition.fromEvent({ request, outcome, createdAt }),
    row,
  );
});

test("happy path: adds a key beside the platform's first one, in one platform.key-added event signed by the registry", async () => {
  const { registry, platform } = await setUpTestPlatform();

  const key = await addKey(registry, platform.platformId);

  assert.equal(key.platformId, platform.platformId);
  assert.deepEqual(await getKey(pool, key.id), key);
  assert.equal(
    (await findKeys(pool)).filter((candidate) => candidate.platformId === platform.platformId)
      .length,
    2,
  );

  const event = (await findEvents(pool)).at(-1);
  assert.ok(event);
  assert.equal(event.kind, 'platform.key-added');
  assert.equal(event.signature.keyId, registry.keyId);
  assert.equal(event.createdAt.getTime(), key.createdAt.getTime());
  const { outcome } = parseEvent(platformKeyAddedEventKindDefinition, event);
  assert.deepEqual(outcome, { key: { id: key.id } });

  const registryKey = await getKey(pool, registry.keyId);
  assert.ok(registryKey);
  assert.equal(
    isEventSignatureValid(platformKeyAddedEventKindDefinition, event, registryKey),
    true,
  );
});

test('a key for an unknown platform throws NotFoundError and writes nothing', async () => {
  const { registry } = await setUpTestPlatform();
  const keys = await findKeys(pool);
  const events = await findEvents(pool);

  await assert.rejects(
    () => addKey(registry, generateUUIDv7()),
    (error: unknown) => error instanceof NotFoundError && error.message === 'Platform not found.',
  );
  assert.deepEqual(await findKeys(pool), keys);
  assert.deepEqual(await findEvents(pool), events);
});

test('rebuilding the log writes back exactly the keys addPlatformKey wrote', async () => {
  const { registry, platform } = await setUpTestPlatform();
  await addKey(registry, platform.platformId);
  await addKey(registry, platform.platformId);
  const keys = await findKeys(pool);
  const events = await findEvents(pool);

  await truncateProjections();
  assert.deepEqual(await findKeys(pool), []);

  await withTransaction(
    pool,
    (db) =>
      rebuildEvents(db, events, [
        ...setUpEventKindDefinitions,
        platformKeyAddedEventKindDefinition,
      ]),
    silentLogger,
  );

  assert.deepEqual(await findKeys(pool), keys);
  assert.deepEqual(await findEvents(pool), events);
});
