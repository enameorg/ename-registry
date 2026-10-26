import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { pino } from 'pino';
import { z } from 'zod';

// Service integration tests: assert the return value and the persisted state
// read back through the Service's own functions (findSubjects, findEnames,
// findEvents) — no raw pool/SQL. Those read primitives are themselves covered
// by their concept's *.test.ts, so reading state through them here is not
// circular. Idempotency (replay, conflict, race) is withEvent's and is tested
// at its interface in services/event/with-event.test.ts. Test doctrine:
// ename-internals.md.
import { pool } from '../../database/pool.ts';
import { useTestDb } from '../../database/testing.ts';
import { generateUUIDv7, UUIDV7_REGEX } from '../../utilities/uuid.ts';
import { findEnames } from '../ename/index.ts';
import { ContentionError, ValidationError } from '../errors.ts';
import { findEvents } from '../event/index.ts';

import {
  registerSubject,
  type RegisterSubjectResult,
  SubjectRegisteredEventKindDefinition,
} from './register-subject.ts';
import { findSubjects } from './subject.ts';

// Silent logger: these tests assert behavior, not log output. Keeping the
// test runner output clean while still exercising the logger plumbing in the
// service (logger.warn on number_part retry).
const silentLogger = pino({ level: 'silent' });
const context = { logger: silentLogger };

useTestDb();

// ---------------------------------------------------------------------------
// The kind's mapping: pure, no database
// ---------------------------------------------------------------------------

// The law withEvent rests on: what toOutcome keeps of the rows, read back with
// the request and the timestamp, is the rows again — a replay returns what the
// first write did.
test('toOutcome keeps what the server allocated, and fromEvent reads it back as the rows written', () => {
  const subjectId = generateUUIDv7();
  const enameId = generateUUIDv7();
  const createdAt = new Date('2026-05-27T14:32:11.123Z');
  const request = { subject: { kind: 'person' as const }, ename: { namePart: 'jean-dupont' } };
  const rows: RegisterSubjectResult = {
    subject: { id: subjectId, kind: 'person', createdAt },
    ename: { id: enameId, subjectId, namePart: 'jean-dupont', numberPart: 3, createdAt },
  };

  const outcome = SubjectRegisteredEventKindDefinition.toOutcome(rows);
  assert.deepEqual(outcome, { subject: { id: subjectId }, ename: { id: enameId, numberPart: 3 } });
  assert.deepEqual(
    SubjectRegisteredEventKindDefinition.fromEvent({ request, outcome, createdAt }),
    rows,
  );
});

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
  assert.equal(result.ename.subjectId, result.subject.id);
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
  // deterministic projection-by-replay — and the returned rows carry it.
  const subjectAt = subjects[0]?.createdAt.getTime();
  const enameAt = enames[0]?.createdAt.getTime();
  const eventAt = events[0]?.createdAt.getTime();
  assert.equal(subjectAt, eventAt);
  assert.equal(enameAt, eventAt);
  assert.equal(result.subject.createdAt.getTime(), eventAt);
  assert.equal(result.ename.createdAt.getTime(), eventAt);
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

// Beyond the retry budget, a burst on one namePart ends in ContentionError
// for the losers — a retryable domain error, never an unexpected one — while
// the rest get distinct numberParts. The 503 this maps to is pinned in
// api/errors.test.ts; this test only shows that the real allocation path
// reaches the budget, and that is statistical by nature. It rests on three
// values: this concurrency, the pool size the test script pins
// (DATABASE_POOL_SIZE=10 in package.json, an environment variable outranking
// .env) and MAX_NUMBER_PART_RETRIES = 20 in the ename primitive. The pool
// bounds how many transactions contend at once; each round one wins and
// commits, every other in-flight contender burns one attempt, and a waiting
// registration replaces the winner with a fresh budget — so no counting
// argument guarantees that one contender loses 20 rounds in a row, however
// likely. Measured on the local cluster, 40 registrations yield: 0 contention
// errors at pool size 2 or 3, 0 to 1 at 5, 2 to 5 at 10, 8 to 11 at 20, 11 to
// 14 at 80. A larger pool only strengthens the assertion; a smaller one
// weakens it, and the failure message below says so.
test('concurrent registrations for the same namePart beyond the retry budget fail with ContentionError, the rest succeed', async () => {
  const namePart = 'martin';
  const concurrency = 40;

  const outcomes = await Promise.allSettled(
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

  const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
  const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
  assert.ok(
    rejected.every((outcome) => outcome.reason instanceof ContentionError),
    'every failure under the burst must be a ContentionError',
  );
  assert.ok(fulfilled.length > 0, 'at least one registration must succeed under the burst');
  assert.ok(
    rejected.length > 0,
    `the retry budget must be exhausted at this concurrency (expected ≥1 ContentionError at ${concurrency} registrations with DATABASE_POOL_SIZE=10, see the comment above)`,
  );

  const numberParts = fulfilled.map((outcome) => outcome.value.ename.numberPart);
  assert.equal(new Set(numberParts).size, numberParts.length);
  assert.equal((await findEnames(pool)).length, fulfilled.length);
});

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
