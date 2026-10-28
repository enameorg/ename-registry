import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { pino } from 'pino';

import { generateUUIDv7 } from '../utilities/uuid.ts';

import { pool } from './pool.ts';
import { type Database, withTransaction } from './query.ts';
import { useTestDB } from './testing.ts';

// Executable specification of withTransaction's nesting: a transaction on the
// pool, a savepoint on a transaction's client (cf. ename-internals.md). The
// subjects table is only a target for rows; raw SQL keeps this test inside
// src/database/. Inside a block, `db` shadows the outer one on purpose: the
// block's statements run on the block's handle.
const logger = pino({ level: 'silent' });

useTestDB();

async function insertRow(db: Database): Promise<void> {
  await db.query('INSERT INTO subjects (id, kind, created_at) VALUES ($1, $2, $3)', [
    generateUUIDv7(),
    'person',
    new Date(),
  ]);
}

async function countRows(): Promise<number> {
  const result = await pool.query<{ count: number }>('SELECT count(*)::int AS count FROM subjects');
  return result.rows[0]?.count ?? -1;
}

test('a nested block that fails is rolled back to its savepoint, rethrows its own error, and the enclosing transaction goes on', async () => {
  const failure = new Error('nested failure');

  await withTransaction(
    pool,
    async (db) => {
      await insertRow(db);
      await assert.rejects(
        () =>
          withTransaction(
            db,
            async (db) => {
              await insertRow(db);
              throw failure;
            },
            logger,
          ),
        (error: unknown) => error === failure,
      );
      await insertRow(db);
    },
    logger,
  );

  assert.equal(await countRows(), 2);
});

test('a nested block that succeeds is released and committed with the enclosing transaction', async () => {
  await withTransaction(
    pool,
    async (db) => {
      await insertRow(db);
      await withTransaction(db, (db) => insertRow(db), logger);
    },
    logger,
  );

  assert.equal(await countRows(), 2);
});

test('an enclosing transaction that fails after a successful nested block rolls everything back', async () => {
  await assert.rejects(
    () =>
      withTransaction(
        pool,
        async (db) => {
          await withTransaction(db, (db) => insertRow(db), logger);
          await insertRow(db);
          throw new Error('outer failure');
        },
        logger,
      ),
    /outer failure/,
  );

  assert.equal(await countRows(), 0);
});

test('an enclosing transaction that fails after a contained nested failure rolls everything back', async () => {
  await assert.rejects(
    () =>
      withTransaction(
        pool,
        async (db) => {
          await insertRow(db);
          await withTransaction(
            db,
            async (db) => {
              await insertRow(db);
              throw new Error('nested failure');
            },
            logger,
          ).catch(() => undefined);
          throw new Error('outer failure');
        },
        logger,
      ),
    /outer failure/,
  );

  assert.equal(await countRows(), 0);
});

test('sibling nested blocks follow one another in the same transaction, a failed one then a successful one, down to a third level', async () => {
  await withTransaction(
    pool,
    async (db) => {
      await withTransaction(
        db,
        async (db) => {
          await insertRow(db);
          throw new Error('first sibling fails');
        },
        logger,
      ).catch(() => undefined);
      await withTransaction(
        db,
        async (db) => {
          await insertRow(db);
          await withTransaction(db, (db) => insertRow(db), logger);
        },
        logger,
      );
    },
    logger,
  );

  assert.equal(await countRows(), 2);
});
