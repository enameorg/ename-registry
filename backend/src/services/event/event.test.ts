import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { pool } from '../../database/pool.ts';
import { useTestDb } from '../../database/testing.ts';
import { generateUUIDv7 } from '../../utilities/uuid.ts';

import {
  findEvents,
  getEventByIdempotencyKey,
  IdempotencyRaceError,
  insertEvent,
} from './event.ts';

// Direct tests of the event data-access primitives (insert + read round-trip,
// and the idempotency_key UNIQUE collision path). These primitives are tested
// in isolation so use-case tests can read state back through them and trust the
// result — see ename-internals.md. A single-statement write needs no
// transaction, so the primitives are called with the pool directly.
useTestDb();

test('insertEvent then read back round-trips kind, request, outcome, idempotencyKey and createdAt', async () => {
  const idempotencyKey = generateUUIDv7();
  const createdAt = new Date();
  const request = { subject: { kind: 'person' }, ename: { namePart: 'jean-dupont' } };
  const outcome = {
    subject: { id: generateUUIDv7() },
    ename: { id: generateUUIDv7(), numberPart: 1 },
  };

  await insertEvent(pool, {
    idempotencyKey,
    kind: 'subject.registered',
    request,
    outcome,
    createdAt,
  });

  const found = await getEventByIdempotencyKey(pool, idempotencyKey);
  assert.ok(found);
  assert.equal(found.idempotencyKey, idempotencyKey);
  assert.equal(found.kind, 'subject.registered');
  assert.deepEqual(found.request, request);
  assert.deepEqual(found.outcome, outcome);
  assert.equal(found.createdAt.getTime(), createdAt.getTime());
  assert.ok(found.sequence >= 1);

  const all = await findEvents(pool);
  assert.equal(all.length, 1);
  assert.equal(all[0]?.idempotencyKey, idempotencyKey);
});

test('getEventByIdempotencyKey returns undefined for an unknown key', async () => {
  assert.equal(await getEventByIdempotencyKey(pool, generateUUIDv7()), undefined);
});

test('insertEvent twice with the same idempotencyKey throws IdempotencyRaceError', async () => {
  const idempotencyKey = generateUUIDv7();
  const params = {
    idempotencyKey,
    kind: 'subject.registered',
    request: {},
    outcome: {},
    createdAt: new Date(),
  };

  await insertEvent(pool, params);

  await assert.rejects(
    () => insertEvent(pool, params),
    (error: unknown) => error instanceof IdempotencyRaceError,
  );
});
