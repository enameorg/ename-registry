import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';

import { pino } from 'pino';
import { v7 as uuidv7 } from 'uuid';

import { pool } from '../database/pool.ts';
import { resetTestDb } from '../database/reset-for-tests.ts';
import { UUIDV7_REGEX } from '../uuid.ts';

import { IdempotencyConflictError, ValidationError } from './errors.ts';
import { registerSubject } from './subject.ts';

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

test('happy path: writes one row per table with consistent ids, namePart, numberPart, payload, kind, idempotency_key and created_at', async () => {
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
  const { rows: subjects } = await pool.query<{ id: string; kind: string; created_at: Date }>(
    'SELECT id, kind, created_at FROM subjects',
  );
  assert.equal(subjects.length, 1);
  assert.equal(subjects[0]?.id, result.subject.id);
  assert.equal(subjects[0]?.kind, 'person');

  // `enames` projection.
  const { rows: enames } = await pool.query<{
    id: string;
    subject_id: string;
    name_part: string;
    number_part: string;
    created_at: Date;
  }>('SELECT id, subject_id, name_part, number_part, created_at FROM enames');
  assert.equal(enames.length, 1);
  assert.equal(enames[0]?.id, result.ename.id);
  assert.equal(enames[0]?.subject_id, result.subject.id);
  assert.equal(enames[0]?.name_part, namePart);
  assert.equal(enames[0]?.number_part, '1');

  // Event log.
  const { rows: events } = await pool.query<{
    sequence: string;
    idempotency_key: string;
    kind: string;
    payload: {
      subject: { id: string; kind: string };
      ename: { id: string; namePart: string; numberPart: number };
    };
    created_at: Date;
  }>('SELECT sequence, idempotency_key, kind, payload, created_at FROM events ORDER BY sequence');
  assert.equal(events.length, 1);
  assert.equal(events[0]?.idempotency_key, idempotencyKey);
  assert.equal(events[0]?.kind, 'subject.registered');
  assert.equal(events[0]?.payload.subject.id, result.subject.id);
  assert.equal(events[0]?.payload.subject.kind, 'person');
  assert.equal(events[0]?.payload.ename.id, result.ename.id);
  assert.equal(events[0]?.payload.ename.namePart, namePart);
  assert.equal(events[0]?.payload.ename.numberPart, 1);

  // The three created_at values are strictly equal — required for
  // deterministic projection-by-replay.
  const subjectAt = subjects[0]?.created_at.getTime();
  const enameAt = enames[0]?.created_at.getTime();
  const eventAt = events[0]?.created_at.getTime();
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

  const { rows: eventRows } = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM events',
  );
  assert.equal(eventRows[0]?.count, '1');
  const { rows: enameRows } = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM enames',
  );
  assert.equal(enameRows[0]?.count, '1');
  const { rows: subjectRows } = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM subjects',
  );
  assert.equal(subjectRows[0]?.count, '1');
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
  // same ename id, same numberPart, same createdAt) — the winner's payload
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

  // Exactly one event row in the log.
  const { rows } = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM events WHERE idempotency_key = $1',
    [idempotencyKey],
  );
  assert.equal(rows[0]?.count, '1');

  // Exactly one subject and one ename in the projections.
  const { rows: subjectRows } = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM subjects',
  );
  assert.equal(subjectRows[0]?.count, '1');
  const { rows: enameRows } = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM enames',
  );
  assert.equal(enameRows[0]?.count, '1');
});

// ---------------------------------------------------------------------------
// Domain validation: total length > 52 chars after numberPart allocation
// ---------------------------------------------------------------------------

test('52-char post-allocation guard: throws ValidationError pointing at ename.namePart and rolls back the transaction', async () => {
  // Seed an existing ename with a 50-char namePart and numberPart=9 — the
  // next allocation would be numberPart=10 (2 digits), giving total
  // 50 + 1 + 2 = 53 > 52. Bypass the service to plant this state directly:
  // we are testing the post-allocation guard, not the seed path.
  const namePart = 'a'.repeat(50);
  const seedSubjectId = uuidv7();
  const seedEnameId = uuidv7();
  const seedAt = new Date();
  await pool.query('INSERT INTO subjects (id, kind, created_at) VALUES ($1, $2, $3)', [
    seedSubjectId,
    'person',
    seedAt,
  ]);
  await pool.query(
    'INSERT INTO enames (id, subject_id, name_part, number_part, created_at) VALUES ($1, $2, $3, $4, $5)',
    [seedEnameId, seedSubjectId, namePart, 9, seedAt],
  );

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

  // Nothing extra was committed (the ROLLBACK undid the subjects/enames
  // INSERTs from this attempt) — only the seed row remains.
  const { rows: subjectRows } = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM subjects',
  );
  assert.equal(subjectRows[0]?.count, '1');
  const { rows: enameRows } = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM enames',
  );
  assert.equal(enameRows[0]?.count, '1');
  const { rows: eventRows } = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM events',
  );
  assert.equal(eventRows[0]?.count, '0');
});
