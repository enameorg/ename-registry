import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { pino } from 'pino';

import { pool } from '../../database/pool.ts';
import { withTransaction } from '../../database/query.ts';
import { truncateProjections, useTestDatabase } from '../../database/testing.ts';
import { generateUUIDv7 } from '../../utilities/uuid.ts';
import { ConflictError } from '../errors.ts';
import { findEvents, isEventSignatureValid, parseEvent } from '../event/index.ts';
import { findKeys, getKey } from '../key/index.ts';
import {
  anchorTestRegistry,
  generateTestKey,
  makePlatformInput,
  rebuildEvents,
  setUpEventKindDefinitions,
  signInput,
  type TestSigner,
} from '../testing.ts';

import {
  accreditPlatform,
  type AccreditPlatformResult,
  platformAccreditedEventKindDefinition,
} from './accredit-platform.ts';
import { findPlatforms } from './platform.ts';

// What this use case adds to the write protocol: its kind's mapping, the two rows it writes, their
// rebuild from the log, the one-platform-per-entity conflict; its signer's authentication is
// authenticateRegistry's, tested in services/registry/registry.test.ts; idempotency is withEvent's,
// tested in services/event/with-event.test.ts. Test doctrine: ename-internals.md.
const silentLogger = pino({ level: 'silent' });
const context = { logger: silentLogger };

useTestDatabase();

async function accredit(registry: TestSigner, platform = makePlatformInput()) {
  return await accreditPlatform(
    signInput(platformAccreditedEventKindDefinition, registry, {
      idempotencyKey: generateUUIDv7(),
      platform,
      key: { algorithm: 'ecdsa-p256-sha256', value: generateTestKey().publicKey },
    }),
    context,
  );
}

test('toOutcome keeps what the server allocated, and fromEvent reads it back as the rows written', () => {
  const platformId = generateUUIDv7();
  const keyId = generateUUIDv7();
  const createdAt = new Date('2026-10-30T09:12:44.512Z');
  const request = {
    platform: makePlatformInput(),
    key: { algorithm: 'ecdsa-p256-sha256' as const, value: generateTestKey().publicKey },
  };
  const rows: AccreditPlatformResult = {
    platform: { id: platformId, ...request.platform, createdAt },
    key: { id: keyId, platformId, ...request.key, createdAt },
  };

  const outcome = platformAccreditedEventKindDefinition.toOutcome(rows);
  assert.deepEqual(outcome, { platform: { id: platformId }, key: { id: keyId } });
  assert.deepEqual(
    platformAccreditedEventKindDefinition.fromEvent({ request, outcome, createdAt }),
    rows,
  );
});

test('happy path: writes the platform and its key, and one platform.accredited event signed by the registry', async () => {
  const registry = await anchorTestRegistry();
  const input = makePlatformInput();

  const { platform, key } = await accredit(registry, input);

  assert.deepEqual(await findPlatforms(pool), [platform]);
  assert.deepEqual(platform, { id: platform.id, ...input, createdAt: platform.createdAt });
  assert.equal(key.platformId, platform.id);
  assert.deepEqual(await getKey(pool, key.id), key);

  const event = (await findEvents(pool)).at(-1);
  assert.ok(event);
  assert.equal(event.kind, 'platform.accredited');
  assert.equal(event.signature.keyId, registry.keyId);
  assert.equal(event.createdAt.getTime(), platform.createdAt.getTime());
  const { outcome } = parseEvent(platformAccreditedEventKindDefinition, event);
  assert.deepEqual(outcome, { platform: { id: platform.id }, key: { id: key.id } });

  const registryKey = await getKey(pool, registry.keyId);
  assert.ok(registryKey);
  assert.equal(
    isEventSignatureValid(platformAccreditedEventKindDefinition, event, registryKey),
    true,
  );
});

test('a second accreditation of the same registration throws ConflictError and writes nothing', async () => {
  const registry = await anchorTestRegistry();
  const input = makePlatformInput();
  await accredit(registry, input);
  const platforms = await findPlatforms(pool);
  const keys = await findKeys(pool);
  const events = await findEvents(pool);

  await assert.rejects(
    () => accredit(registry, input),
    (error: unknown) =>
      error instanceof ConflictError &&
      error.message === 'A platform is already accredited for this registration.',
  );
  assert.deepEqual(await findPlatforms(pool), platforms);
  assert.deepEqual(await findKeys(pool), keys);
  assert.deepEqual(await findEvents(pool), events);
});

test('rebuilding the log writes back exactly the platforms and keys accreditPlatform wrote', async () => {
  const registry = await anchorTestRegistry();
  await accredit(registry);
  await accredit(registry);
  const platforms = await findPlatforms(pool);
  const keys = await findKeys(pool);
  const events = await findEvents(pool);

  await truncateProjections();
  assert.deepEqual(await findKeys(pool), []);

  await withTransaction(
    pool,
    (db) => rebuildEvents(db, events, setUpEventKindDefinitions),
    silentLogger,
  );

  assert.deepEqual(await findPlatforms(pool), platforms);
  assert.deepEqual(await findKeys(pool), keys);
  assert.deepEqual(await findEvents(pool), events);
});
