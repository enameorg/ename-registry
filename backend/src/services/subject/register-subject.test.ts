import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { pino } from 'pino';
import { z } from 'zod';

// Service integration tests: assert the return value and the persisted state
// read back through the Service's own functions (findSubjects, findEnames,
// findEvents) — no raw pool/SQL. Those read primitives are themselves covered
// by their concept's *.test.ts, so reading state through them here is not
// circular. Idempotency (replay, conflict, race) is appendEvent's and is tested
// at its interface in services/event/append-event.test.ts. Test doctrine:
// ename-internals.md.
import { pool } from '../../database/pool.ts';
import { useTestDb } from '../../database/testing.ts';
import { generateUUIDv7, UUIDV7_REGEX } from '../../utilities/uuid.ts';
import { findEnames } from '../ename/index.ts';
import { ValidationError } from '../errors.ts';
import { findEvents, SubjectRegisteredEventKindDefinition } from '../event/index.ts';

import { registerSubject } from './register-subject.ts';
import { findSubjects } from './subject.ts';

// Silent logger: these tests assert behavior, not log output. Keeping the
// test runner output clean while still exercising the logger plumbing in the
// service (logger.warn on number_part retry).
const silentLogger = pino({ level: 'silent' });
const context = { logger: silentLogger };

useTestDb();

// ---------------------------------------------------------------------------
// Happy path: full inspection of projections and event log
// ---------------------------------------------------------------------------

test('happy path: writes one row per table with consistent ids, namePart, numberPart, request, outcome, kind, idempotency_key and created_at', async () => {
  const idempotencyKey = generateUUIDv7();
  const namePart = 'jean-dupont';

  const result = await registerSubject(
    {
      idempotencyKey,
      subject: { kind: 'person' },
      ename: { namePart },
    },
    context,
  );

  assert.match(result.subject.id, UUIDV7_REGEX);
  assert.match(result.ename.id, UUIDV7_REGEX);
  assert.equal(result.subject.kind, 'person');
  assert.equal(result.ename.namePart, namePart);
  assert.equal(result.ename.numberPart, 1);

  // `subjects` projection.
  const subjects = await findSubjects(pool);
  assert.equal(subjects.length, 1);
  assert.equal(subjects[0]?.id, result.subject.id);
  assert.equal(subjects[0]?.kind, 'person');

  // `enames` projection.
  const enames = await findEnames(pool);
  assert.equal(enames.length, 1);
  assert.equal(enames[0]?.id, result.ename.id);
  assert.equal(enames[0]?.subjectId, result.subject.id);
  assert.equal(enames[0]?.namePart, namePart);
  assert.equal(enames[0]?.numberPart, 1);

  // Event log.
  const events = await findEvents(pool);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.idempotencyKey, idempotencyKey);
  assert.equal(events[0]?.kind, 'subject.registered');
  // request = what the client submitted; outcome = what the server allocated.
  const request = SubjectRegisteredEventKindDefinition.requestSchema.parse(events[0]?.request);
  assert.equal(request.subject.kind, 'person');
  assert.equal(request.ename.namePart, namePart);
  const outcome = SubjectRegisteredEventKindDefinition.outcomeSchema.parse(events[0]?.outcome);
  assert.equal(outcome.subject.id, result.subject.id);
  assert.equal(outcome.ename.id, result.ename.id);
  assert.equal(outcome.ename.numberPart, 1);

  // The three created_at values are strictly equal — required for
  // deterministic projection-by-replay.
  const subjectAt = subjects[0]?.createdAt.getTime();
  const enameAt = enames[0]?.createdAt.getTime();
  const eventAt = events[0]?.createdAt.getTime();
  const resultAt = result.createdAt.getTime();
  assert.equal(subjectAt, eventAt);
  assert.equal(enameAt, eventAt);
  assert.equal(resultAt, eventAt);
});

// ---------------------------------------------------------------------------
// Sequential allocation
// ---------------------------------------------------------------------------

test('two sequential registrations for the same namePart produce consecutive numberParts', async () => {
  const namePart = 'marie-curie';

  const first = await registerSubject(
    { idempotencyKey: generateUUIDv7(), subject: { kind: 'person' }, ename: { namePart } },
    context,
  );
  const second = await registerSubject(
    { idempotencyKey: generateUUIDv7(), subject: { kind: 'person' }, ename: { namePart } },
    context,
  );

  assert.notEqual(first.subject.id, second.subject.id);
  assert.equal(first.ename.numberPart, 1);
  assert.equal(second.ename.numberPart, 2);
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

test('concurrent registrations for the same namePart produce consecutive numberParts', async () => {
  const namePart = 'concurrent-name';
  const concurrency = 10;

  const results = await Promise.all(
    Array.from({ length: concurrency }, () =>
      registerSubject(
        {
          idempotencyKey: generateUUIDv7(),
          subject: { kind: 'person' },
          ename: { namePart },
        },
        context,
      ),
    ),
  );

  // Each call must have produced a distinct ename row with a unique
  // numberPart in [1..concurrency]. Order is not guaranteed (concurrent
  // execution), but the SET of numberParts must be exactly {1..N}.
  const numberParts = results
    .map((result) => result.ename.numberPart)
    .sort((left, right) => left - right);
  const expected = Array.from({ length: concurrency }, (_unused, index) => index + 1);
  assert.deepEqual(numberParts, expected);

  // Distinct subjects (each registration creates a new subject).
  const subjectIds = new Set(results.map((result) => result.subject.id));
  assert.equal(subjectIds.size, concurrency);
});

// ---------------------------------------------------------------------------
// Domain validation: total length > 52 chars once the numberPart is allocated
// ---------------------------------------------------------------------------

test('52-char budget: throws ValidationError pointing at ename.namePart and rolls back the transaction', async () => {
  // Seed via the public service surface — no test backdoor. With a 50-char
  // namePart, the first 9 registrations stay within the 52-char limit
  // (50 + 1 + 1-digit numberPart ≤ 52). The 10th attempt would allocate
  // numberPart=10 (2 digits) → total 53 > 52, which the allocation refuses.
  const namePart = 'a'.repeat(50);
  for (let index = 0; index < 9; index += 1) {
    await registerSubject(
      { idempotencyKey: generateUUIDv7(), subject: { kind: 'person' }, ename: { namePart } },
      context,
    );
  }

  await assert.rejects(
    () =>
      registerSubject(
        { idempotencyKey: generateUUIDv7(), subject: { kind: 'person' }, ename: { namePart } },
        context,
      ),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.match(error.message, /52/);
      assert.match(error.message, /shorter/i);
      assert.ok(
        error.errors.some((issue) => issue.path[0] === 'ename' && issue.path[1] === 'namePart'),
      );
      return true;
    },
  );

  // Nothing extra was committed — the ROLLBACK undid the subjects/enames
  // INSERTs from the failed attempt. Only the 9 seeded entities remain in
  // each projection, and exactly 9 events in the log.
  assert.equal((await findSubjects(pool)).length, 9);
  assert.equal((await findEnames(pool)).length, 9);
  assert.equal((await findEvents(pool)).length, 9);
});

// ---------------------------------------------------------------------------
// Input validation: the namePart grammar holds for every caller, not only HTTP
// ---------------------------------------------------------------------------

test('a namePart outside the grammar is rejected before anything is written', async () => {
  await assert.rejects(
    () =>
      registerSubject(
        {
          idempotencyKey: generateUUIDv7(),
          subject: { kind: 'person' },
          ename: { namePart: 'Jean-Dupont' },
        },
        context,
      ),
    (error: unknown) => {
      assert.ok(error instanceof z.ZodError);
      assert.ok(
        error.issues.some((issue) => issue.path[0] === 'ename' && issue.path[1] === 'namePart'),
      );
      return true;
    },
  );

  assert.equal((await findSubjects(pool)).length, 0);
  assert.equal((await findEnames(pool)).length, 0);
  assert.equal((await findEvents(pool)).length, 0);
});
