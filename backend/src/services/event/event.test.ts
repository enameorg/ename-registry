import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';

import { pino } from 'pino';

import { pool } from '../../database/pool.ts';
import { withTransaction } from '../../database/query.ts';
import { resetTestDb } from '../../database/reset-for-tests.ts';
import { generateUUIDv7 } from '../../uuid.ts';

import {
  findEvents,
  getEventByIdempotencyKey,
  IdempotencyRaceError,
  insertEvent,
} from './event.ts';

// Direct tests of the event data-access primitives (insert + read round-trip,
// and the idempotency_key UNIQUE collision path). These primitives are tested
// in isolation so use-case tests can read state back through them and trust the
// result — see ename-internals.md.
const logger = pino({ level: 'silent' });

beforeEach(async () => {
  await resetTestDb();
});

test('insertEvent then read back round-trips kind, request, outcome, idempotencyKey and createdAt', async () => {
  const idempotencyKey = generateUUIDv7();
  const createdAt = new Date();
  const request = { subject: { kind: 'person' }, ename: { namePart: 'jean-dupont' } };
  const outcome = {
    subject: { id: generateUUIDv7() },
    ename: { id: generateUUIDv7(), numberPart: 1 },
  };

  await withTransaction(
    pool,
    (client) =>
      insertEvent(client, {
        idempotencyKey,
        kind: 'subject.registered',
        request,
        outcome,
        createdAt,
      }),
    logger,
  );

  const found = await getEventByIdempotencyKey(idempotencyKey);
  assert.ok(found);
  assert.equal(found.idempotencyKey, idempotencyKey);
  assert.equal(found.kind, 'subject.registered');
  assert.deepEqual(found.request, request);
  assert.deepEqual(found.outcome, outcome);
  assert.equal(found.createdAt.getTime(), createdAt.getTime());
  assert.ok(found.sequence >= 1);

  const all = await findEvents();
  assert.equal(all.length, 1);
  assert.equal(all[0]?.idempotencyKey, idempotencyKey);
});

test('getEventByIdempotencyKey returns undefined for an unknown key', async () => {
  assert.equal(await getEventByIdempotencyKey(generateUUIDv7()), undefined);
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

  await withTransaction(pool, (client) => insertEvent(client, params), logger);

  await assert.rejects(
    () => withTransaction(pool, (client) => insertEvent(client, params), logger),
    (error: unknown) => error instanceof IdempotencyRaceError,
  );
});
