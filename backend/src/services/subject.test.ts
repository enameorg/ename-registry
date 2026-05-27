import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';

import { pino } from 'pino';
import { v7 as uuidv7 } from 'uuid';

import { pool } from '../database/pool.ts';
import { resetTestDb } from '../database/reset-for-tests.ts';

import { registerSubject } from './subject.ts';

// Silent logger: these tests assert behavior, not log output. Keeping the
// test runner output clean while still exercising the logger plumbing in the
// service (logger.warn on number_part retry, logger.info on replay paths).
const silentLogger = pino({ level: 'silent' });
const context = { logger: silentLogger };

beforeEach(async () => {
  await resetTestDb(pool);
});

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
