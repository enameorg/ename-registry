import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';

import { pino } from 'pino';
import { v7 as uuidv7 } from 'uuid';

// Service integration tests assert on (a) the return value of the service
// function under test and (b) the resulting state observed through the
// Service Layer's own public surface (`findSubjects`, `findEnames`,
// `findEvents`, `getEventByIdempotencyKey`, etc.). They do not import `pool`
// and do not issue raw SQL: every state inspection passes through a Service
// function whose existence is justified by a credible production use case
// (transparency log, lookups, admin/operator reads).
//
// `resetTestDb` is the only import from `../database/*`: tests share the
// real PostgreSQL instance and must start each case on a clean slate.
import { resetTestDb } from '../database/reset-for-tests.ts';
import { UUIDV7_REGEX } from '../uuid.ts';

import { findEnames } from './ename.ts';
import { IdempotencyConflictError, ValidationError } from './errors.ts';
import { findEvents, getEventByIdempotencyKey } from './event.ts';
import {
  findSubjects,
  registerSubject,
  SubjectRegisteredOutcomeSchema,
  SubjectRegisteredRequestSchema,
} from './subject.ts';

// Silent logger: these tests assert behavior, not log output. Keeping the
// test runner output clean while still exercising the logger plumbing in the
// service (logger.warn on number_part retry, logger.info on replay paths).
const silentLogger = pino({ level: 'silent' });
const context = { logger: silentLogger };

beforeEach(async () => {
  await resetTestDb();
});

// ---------------------------------------------------------------------------
// Happy path: full inspection of projections and event log
// ---------------------------------------------------------------------------

test('happy path: writes one row per table with consistent ids, namePart, numberPart, request, outcome, kind, idempotency_key and created_at', async () => {
  const idempotencyKey = uuidv7();
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
  const subjects = await findSubjects();
  assert.equal(subjects.length, 1);
  assert.equal(subjects[0]?.id, result.subject.id);
  assert.equal(subjects[0]?.kind, 'person');

  // `enames` projection.
  const enames = await findEnames();
  assert.equal(enames.length, 1);
  assert.equal(enames[0]?.id, result.ename.id);
  assert.equal(enames[0]?.subjectId, result.subject.id);
  assert.equal(enames[0]?.namePart, namePart);
  assert.equal(enames[0]?.numberPart, 1);

  // Event log.
  const events = await findEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.idempotencyKey, idempotencyKey);
  assert.equal(events[0]?.kind, 'subject.registered');
  // `request` holds what the client submitted (the input the future layer-1
  // signature will cover); `outcome` holds what the server allocated
  // (covered separately by the future layer-2 signed tree head).
  const request = SubjectRegisteredRequestSchema.parse(events[0]?.request);
  assert.equal(request.subject.kind, 'person');
  assert.equal(request.ename.namePart, namePart);
  const outcome = SubjectRegisteredOutcomeSchema.parse(events[0]?.outcome);
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
    { idempotencyKey: uuidv7(), subject: { kind: 'person' }, ename: { namePart } },
    context,
  );
  const second = await registerSubject(
    { idempotencyKey: uuidv7(), subject: { kind: 'person' }, ename: { namePart } },
    context,
  );

  assert.notEqual(first.subject.id, second.subject.id);
  assert.equal(first.ename.numberPart, 1);
  assert.equal(second.ename.numberPart, 2);
});

// ---------------------------------------------------------------------------
// Idempotency: replay (same body) and conflict (different body)
// ---------------------------------------------------------------------------

test('idempotent replay: second sequential call with the same input returns the same result and writes nothing new', async () => {
  const idempotencyKey = uuidv7();
  const input = {
    idempotencyKey,
    subject: { kind: 'person' as const },
    ename: { namePart: 'albert-einstein' },
  };

  const first = await registerSubject(input, context);
  const second = await registerSubject(input, context);

  assert.equal(first.subject.id, second.subject.id);
  assert.equal(first.ename.id, second.ename.id);
  assert.equal(first.ename.numberPart, second.ename.numberPart);
  assert.equal(first.createdAt.getTime(), second.createdAt.getTime());

  assert.equal((await findEvents()).length, 1);
  assert.equal((await findEnames()).length, 1);
  assert.equal((await findSubjects()).length, 1);
});

test('idempotency conflict: same idempotencyKey with a different body throws IdempotencyConflictError', async () => {
  const idempotencyKey = uuidv7();

  await registerSubject(
    { idempotencyKey, subject: { kind: 'person' }, ename: { namePart: 'first-name' } },
    context,
  );

  await assert.rejects(
    () =>
      registerSubject(
        { idempotencyKey, subject: { kind: 'person' }, ename: { namePart: 'different-name' } },
        context,
      ),
    (error: unknown) => {
      assert.ok(error instanceof IdempotencyConflictError);
      assert.match(error.message, /idempotency key/i);
      return true;
    },
  );
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
          idempotencyKey: uuidv7(),
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

test('concurrent registrations with the same idempotencyKey produce a single event', async () => {
  const idempotencyKey = uuidv7();
  const input = {
    idempotencyKey,
    subject: { kind: 'person' as const },
    ename: { namePart: 'race-name' },
  };
  const concurrency = 10;

  const results = await Promise.all(
    Array.from({ length: concurrency }, () => registerSubject(input, context)),
  );

  // All callers must observe the same canonical result (same subject id,
  // same ename id, same numberPart, same createdAt) — the winner's row
  // reconciled to every loser via the preliminary lookup or the 23505
  // race-recovery path.
  const first = results[0];
  assert.ok(first);
  for (const result of results) {
    assert.equal(result.subject.id, first.subject.id);
    assert.equal(result.ename.id, first.ename.id);
    assert.equal(result.ename.numberPart, first.ename.numberPart);
    assert.equal(result.createdAt.getTime(), first.createdAt.getTime());
  }

  // Exactly one event was committed for this idempotency key, and exactly
  // one subject + one ename in the projections — the other 9 attempts
  // reconciled to the winner without leaving any trace.
  assert.ok(await getEventByIdempotencyKey(idempotencyKey));
  assert.equal((await findEvents()).length, 1);
  assert.equal((await findSubjects()).length, 1);
  assert.equal((await findEnames()).length, 1);
});

// ---------------------------------------------------------------------------
// Domain validation: total length > 52 chars after numberPart allocation
// ---------------------------------------------------------------------------

test('52-char post-allocation guard: throws ValidationError pointing at ename.namePart and rolls back the transaction', async () => {
  // Seed via the public service surface — no test backdoor. With a 50-char
  // namePart, the first 9 registrations stay within the 52-char limit
  // (50 + 1 + 1-digit numberPart ≤ 52). The 10th attempt would allocate
  // numberPart=10 (2 digits) → total 53 > 52, triggering the
  // post-allocation guard.
  const namePart = 'a'.repeat(50);
  for (let index = 0; index < 9; index += 1) {
    await registerSubject(
      { idempotencyKey: uuidv7(), subject: { kind: 'person' }, ename: { namePart } },
      context,
    );
  }

  await assert.rejects(
    () =>
      registerSubject(
        { idempotencyKey: uuidv7(), subject: { kind: 'person' }, ename: { namePart } },
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
  assert.equal((await findSubjects()).length, 9);
  assert.equal((await findEnames()).length, 9);
  assert.equal((await findEvents()).length, 9);
});
