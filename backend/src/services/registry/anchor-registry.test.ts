import { strict as assert } from 'node:assert';
import type { KeyObject } from 'node:crypto';
import { test } from 'node:test';

import { pino } from 'pino';

import { pool } from '../../database/pool.ts';
import { withTransaction } from '../../database/query.ts';
import { truncateProjections, useTestDatabase } from '../../database/testing.ts';
import { generateUUIDv7 } from '../../utilities/uuid.ts';
import { AuthenticationError, ConflictError } from '../errors.ts';
import { findEvents, isEventSignatureValid } from '../event/index.ts';
import { findKeys } from '../key/index.ts';
import { anchorTestRegistry, generateTestKey, rebuildEvents, signInput } from '../testing.ts';

import {
  anchorRegistry,
  type AnchorRegistryResult,
  registryAnchoredEventKindDefinition,
} from './anchor-registry.ts';

// What this use case adds to the write protocol: its kind's mapping, the
// registry key it writes, its rebuild from the log, the single anchor; its
// signer's authentication is its own, authenticateAnchor, tested below;
// idempotency is withEvent's, tested in services/event/with-event.test.ts, and
// the replay below shows only that the anchor goes through it. Test doctrine:
// ename-internals.md.
const silentLogger = pino({ level: 'silent' });
const context = { logger: silentLogger };

useTestDatabase();

// The anchor's input under a new idempotency key: the key it adds, under the
// keyId its holder chose, signed by that key unless another is given.
function makeAnchor({
  added = generateTestKey(),
  keyId = generateUUIDv7(),
  signedBy,
}: {
  added?: { publicKey: string; privateKey: KeyObject };
  keyId?: string;
  signedBy?: KeyObject;
} = {}) {
  return signInput(
    registryAnchoredEventKindDefinition,
    { keyId, privateKey: signedBy ?? added.privateKey },
    {
      idempotencyKey: generateUUIDv7(),
      key: { algorithm: 'ecdsa-p256-sha256', value: added.publicKey },
    },
  );
}

test('toOutcome keeps what the server allocated, and fromEvent reads it back as the key row written', () => {
  const keyId = generateUUIDv7();
  const createdAt = new Date('2026-10-30T09:12:44.512Z');
  const key = { algorithm: 'ecdsa-p256-sha256' as const, value: generateTestKey().publicKey };
  const row: AnchorRegistryResult = { id: keyId, platformId: null, ...key, createdAt };

  const outcome = registryAnchoredEventKindDefinition.toOutcome(row);
  assert.deepEqual(outcome, { key: { id: keyId } });
  assert.deepEqual(
    registryAnchoredEventKindDefinition.fromEvent({ request: { key }, outcome, createdAt }),
    row,
  );
});

test('anchors an empty log with a registry key, under the keyId its own signature names', async () => {
  const registry = await anchorTestRegistry();

  const keys = await findKeys(pool);
  assert.equal(keys.length, 1);
  const [key] = keys;
  assert.ok(key);
  assert.equal(key.id, registry.keyId);
  assert.equal(key.platformId, null);

  const events = await findEvents(pool);
  assert.equal(events.length, 1);
  const [event] = events;
  assert.ok(event);
  assert.equal(event.kind, 'registry.anchored');
  assert.equal(event.signature.keyId, key.id);
  assert.equal(event.createdAt.getTime(), key.createdAt.getTime());
  // Self-signed: the event verifies against the key it adds.
  assert.equal(isEventSignatureValid(registryAnchoredEventKindDefinition, event, key), true);
});

test('the same anchor sent again is a replay: the key it recorded, and still one event', async () => {
  const anchor = makeAnchor();
  const first = await anchorRegistry(anchor, context);

  assert.deepEqual(await anchorRegistry(anchor, context), first);
  assert.equal((await findEvents(pool)).length, 1);
  assert.deepEqual(await findKeys(pool), [first]);
});

test('refuses a second anchor, under a new key or under the keyId already recorded, and writes nothing', async () => {
  const added = generateTestKey();
  const first = makeAnchor({ added });
  await anchorRegistry(first, context);

  await assert.rejects(
    () => anchorRegistry(makeAnchor(), context),
    (error: unknown) =>
      error instanceof ConflictError && error.message === 'The registry is already anchored.',
  );
  await assert.rejects(
    () => anchorRegistry(makeAnchor({ added, keyId: first.signature.keyId }), context),
    (error: unknown) =>
      error instanceof ConflictError &&
      error.message === 'A key is already recorded under this id.',
  );
  assert.equal((await findEvents(pool)).length, 1);
  assert.equal((await findKeys(pool)).length, 1);
});

test('refuses an anchor not signed by the key it adds', async () => {
  await assert.rejects(
    () => anchorRegistry(makeAnchor({ signedBy: generateTestKey().privateKey }), context),
    (error: unknown) => error instanceof AuthenticationError,
  );
  assert.deepEqual(await findEvents(pool), []);
  assert.deepEqual(await findKeys(pool), []);
});

test('rebuilding the log writes back exactly the registry key anchorRegistry wrote', async () => {
  await anchorTestRegistry();
  const keys = await findKeys(pool);
  const events = await findEvents(pool);

  await truncateProjections();
  assert.deepEqual(await findKeys(pool), []);

  await withTransaction(
    pool,
    (db) => rebuildEvents(db, events, [registryAnchoredEventKindDefinition]),
    silentLogger,
  );

  assert.deepEqual(await findKeys(pool), keys);
  assert.deepEqual(await findEvents(pool), events);
});
