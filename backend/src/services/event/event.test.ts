import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { pool } from '../../database/pool.ts';
import { useTestDatabase } from '../../database/testing.ts';
import { generateUUIDv7 } from '../../utilities/uuid.ts';

import {
  findEvents,
  getEventByIdempotencyKey,
  IdempotencyRaceError,
  insertEvent,
} from './event.ts';

// Direct tests of the event data-access primitives (insert + read round-trip,
// the windowed read over a log with a gap, and the idempotency_key UNIQUE
// collision path). The kind vocabulary is tested against its CHECK where the
// list of definitions lives, in services/application. The primitives are
// tested in isolation so use-case tests can read state back through them and
// trust the result — see ename-internals.md. A single-statement write needs no
// transaction, so the primitives are called with the pool directly.
useTestDatabase();

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

// A failed insert burns a sequence value, as an aborted transaction does, so
// the log below has a gap between its second and third events. Each page
// resumes after the last sequence it read and loses nothing across the gap.
test('findEvents reads the log a window at a time, across a gap in sequence', async () => {
  const keys = [generateUUIDv7(), generateUUIDv7(), generateUUIDv7(), generateUUIDv7()];
  for (const [index, idempotencyKey] of keys.entries()) {
    const params = {
      idempotencyKey,
      kind: 'subject.registered',
      request: {},
      outcome: {},
      createdAt: new Date(),
    };
    await insertEvent(pool, params);
    if (index === 1) await assert.rejects(() => insertEvent(pool, params));
  }

  const first = await findEvents(pool, { limit: 2 });
  const second = await findEvents(pool, { afterSequence: first[1]?.sequence ?? 0, limit: 2 });
  const third = await findEvents(pool, { afterSequence: second[1]?.sequence ?? 0, limit: 2 });

  assert.deepEqual(
    first.map((event) => event.idempotencyKey),
    keys.slice(0, 2),
  );
  assert.deepEqual(
    second.map((event) => event.idempotencyKey),
    keys.slice(2),
  );
  assert.deepEqual(third, []);
  assert.equal(second[0]?.sequence, (first[1]?.sequence ?? 0) + 2);
  assert.deepEqual(await findEvents(pool), [...first, ...second]);
});
