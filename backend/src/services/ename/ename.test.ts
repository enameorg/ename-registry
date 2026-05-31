import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { pino } from 'pino';

import { pool } from '../../database/pool.ts';
import { withTransaction } from '../../database/query.ts';
import { useTestDb } from '../../database/testing.ts';
import { generateUUIDv7 } from '../../uuid.ts';
import { ConflictError, NotFoundError, ValidationError } from '../errors.ts';
import { insertSubject } from '../subject/index.ts';

import {
  enforceMaxEnameLength,
  findEnames,
  getEnameByNamePartAndNumberPart,
  insertEnameWithNextNumber,
} from './ename.ts';

// Direct tests of the ename data-access primitives and the pure post-allocation
// rule (see ename-internals.md). insertEnameWithNextNumber requires an existing
// subject (enames.subject_id FK), so each insert test seeds one through the
// subject primitive.
const logger = pino({ level: 'silent' });

useTestDb();

async function seedSubject(): Promise<string> {
  const subjectId = generateUUIDv7();
  await withTransaction(
    pool,
    (client) => insertSubject(client, { id: subjectId, kind: 'person', createdAt: new Date() }),
    logger,
  );
  return subjectId;
}

test('insertEnameWithNextNumber allocates numberPart 1 and round-trips via getEnameByNamePartAndNumberPart/findEnames', async () => {
  const subjectId = await seedSubject();
  const enameId = generateUUIDv7();
  const createdAt = new Date();

  const numberPart = await withTransaction(
    pool,
    (client) =>
      insertEnameWithNextNumber(
        client,
        { enameId, subjectId, namePart: 'jean-dupont', createdAt },
        logger,
      ),
    logger,
  );
  assert.equal(numberPart, 1);

  const found = await getEnameByNamePartAndNumberPart({
    namePart: 'jean-dupont',
    numberPart: 1,
  });
  assert.ok(found);
  assert.equal(found.id, enameId);
  assert.equal(found.subjectId, subjectId);
  assert.equal(found.namePart, 'jean-dupont');
  assert.equal(found.numberPart, 1);
  assert.equal(found.createdAt.getTime(), createdAt.getTime());

  assert.equal((await findEnames()).length, 1);
});

test('insertEnameWithNextNumber allocates consecutive numberParts per namePart', async () => {
  const firstSubjectId = await seedSubject();
  const secondSubjectId = await seedSubject();
  const namePart = 'marie-curie';

  const first = await withTransaction(
    pool,
    (client) =>
      insertEnameWithNextNumber(
        client,
        { enameId: generateUUIDv7(), subjectId: firstSubjectId, namePart, createdAt: new Date() },
        logger,
      ),
    logger,
  );
  const second = await withTransaction(
    pool,
    (client) =>
      insertEnameWithNextNumber(
        client,
        {
          enameId: generateUUIDv7(),
          subjectId: secondSubjectId,
          namePart,
          createdAt: new Date(),
        },
        logger,
      ),
    logger,
  );

  assert.equal(first, 1);
  assert.equal(second, 2);
});

test('insertEnameWithNextNumber rejects a duplicate namePart for the same subject', async () => {
  const subjectId = await seedSubject();
  const namePart = 'marie-curie';

  await withTransaction(
    pool,
    (client) =>
      insertEnameWithNextNumber(
        client,
        { enameId: generateUUIDv7(), subjectId, namePart, createdAt: new Date() },
        logger,
      ),
    logger,
  );

  await assert.rejects(
    () =>
      withTransaction(
        pool,
        (client) =>
          insertEnameWithNextNumber(
            client,
            { enameId: generateUUIDv7(), subjectId, namePart, createdAt: new Date() },
            logger,
          ),
        logger,
      ),
    (error: unknown) =>
      error instanceof ConflictError &&
      error.message === 'This subject already has an ename with this namePart.',
  );
});

test('insertEnameWithNextNumber rejects an unknown subjectId', async () => {
  await assert.rejects(
    () =>
      withTransaction(
        pool,
        (client) =>
          insertEnameWithNextNumber(
            client,
            {
              enameId: generateUUIDv7(),
              subjectId: generateUUIDv7(),
              namePart: 'jean-dupont',
              createdAt: new Date(),
            },
            logger,
          ),
        logger,
      ),
    (error: unknown) => error instanceof NotFoundError && error.message === 'Subject not found.',
  );
});

test('getEnameByNamePartAndNumberPart returns undefined for an unknown ename', async () => {
  assert.equal(
    await getEnameByNamePartAndNumberPart({ namePart: 'nobody', numberPart: 1 }),
    undefined,
  );
});

// enforceMaxEnameLength is a pure rule (no DB) — testable in isolation.
test('enforceMaxEnameLength throws ValidationError only when the total exceeds 52 chars', () => {
  // 50 + "#" + 1 digit = 52: allowed.
  assert.doesNotThrow(() =>
    enforceMaxEnameLength({ namePart: 'a'.repeat(50), numberPart: 1 }, logger),
  );
  // 50 + "#" + 2 digits = 53: rejected, pointing at ename.namePart.
  assert.throws(
    () => enforceMaxEnameLength({ namePart: 'a'.repeat(50), numberPart: 10 }, logger),
    (error: unknown) =>
      error instanceof ValidationError &&
      error.errors.some((issue) => issue.path[0] === 'ename' && issue.path[1] === 'namePart'),
  );
});
