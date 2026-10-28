import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { pool } from '../../database/pool.ts';
import { readCheckConstraintValues, useTestDatabase } from '../../database/testing.ts';
import { generateUUIDv7 } from '../../utilities/uuid.ts';
import {
  subjectEnameAddedEventKindDefinition,
  subjectRegisteredEventKindDefinition,
} from '../subject/index.ts';

import {
  findEvents,
  getEventByIdempotencyKey,
  IdempotencyRaceError,
  insertEvent,
} from './event.ts';

// Direct tests of the event data-access primitives (insert + read round-trip,
// and the idempotency_key UNIQUE collision path), then the kind vocabulary
// against its CHECK. The primitives are tested in isolation so use-case tests
// can read state back through them and trust the result — see
// ename-internals.md. A single-statement write needs no transaction, so the
// primitives are called with the pool directly.
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

// Every event kind definition the use cases declare, listed here and nowhere
// else: the events.kind CHECK is the authoritative list of kinds, and this
// test pins that the definitions in code agree with it, in both directions. A
// kind a migration admits before its use case exists, and a definition that
// landed with its migration but not in this list, both fail here by name; a
// definition with no migration fails in its own use-case tests.
const eventKindDefinitions = [
  subjectRegisteredEventKindDefinition,
  subjectEnameAddedEventKindDefinition,
];

test('the event kinds declared in code are exactly the kinds the events_kind_allowed CHECK admits', async () => {
  const admitted = await readCheckConstraintValues('events_kind_allowed');
  const declared = eventKindDefinitions.map((definition) => definition.kind);

  assert.deepEqual(
    admitted.toSorted(),
    declared.toSorted(),
    'events.kind: the CHECK and the definitions in code disagree',
  );
});
