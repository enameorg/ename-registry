import { after, beforeEach } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { closePool, pool } from './pool.ts';
import type { Database } from './query.ts';

// Register the full test DB lifecycle for one test file: reset projections and
// event log before each test, then release the singleton pool so node:test can
// exit without waiting for idle client timeout.
export function useTestDB(): void {
  beforeEach(async () => {
    await resetTestDB();
  });

  after(async () => {
    await closePool();
  });
}

// TRUNCATE all user tables in the public schema (RESTART IDENTITY resets
// sequences, CASCADE follows foreign keys), behind the test-database guard.
//
// Uses the singleton pool directly: this helper only runs from tests, and the
// enclosing lifecycle helper keeps the reset itself out of higher-layer test files.
async function resetTestDB(): Promise<void> {
  await assertTestDatabase(pool);

  const result = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );

  if (result.rows.length === 0) return;

  // String interpolation, not a placeholder: TRUNCATE TABLE takes no identifier
  // placeholders. Safe here — the source (pg_tables) is the PostgreSQL catalog,
  // not attacker input, and the test-database guard gates the function.
  // Identifiers are double-quoted in case one collides with a reserved word.
  const tableList = result.rows.map((row) => `"${row.tablename}"`).join(', ');
  await pool.query(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
}

// TRUNCATE every projection — every table but the event log and the migration
// ledger — and leave the log as it is: the starting point of a rebuild test,
// which writes the projections again from the log and compares. Listing the
// tables from the catalog keeps a projection added later in scope. Same
// test-database guard as the reset above.
export async function truncateProjections(): Promise<void> {
  await assertTestDatabase(pool);

  const result = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename NOT IN ('events', 'schema_migrations')`,
  );

  if (result.rows.length === 0) return;

  // Interpolated for the same reason, and as safely, as in resetTestDB.
  const tableList = result.rows.map((row) => `"${row.tablename}"`).join(', ');
  await pool.query(`TRUNCATE TABLE ${tableList}`);
}

// Refuse to go on unless the connection is to a test database, one whose name
// ends in _test: the guard between a misconfigured test run and any other
// database. It reads the database actually connected, not the configured URL,
// because the test environment file is not enough on its own — a DATABASE_URL
// exported in the shell outranks it. Every helper here that deletes rows runs
// it first.
export async function assertTestDatabase(db: Database): Promise<void> {
  const result = await db.query<{ name: string }>('SELECT current_database() AS name');
  const name = result.rows[0]?.name;
  if (name === undefined || !name.endsWith('_test')) {
    throw new Error(`refusing to run on database ${name}; only a database named *_test is allowed`);
  }
}

// Wait until a connection of this pool is blocked on a lock another one holds
// (pg_stat_activity reports it with wait_event_type = 'Lock'): a statement
// waiting on a row or index entry an open transaction owns. A test that forces
// a concurrency path holds the transaction, starts the contender, waits here,
// then commits — so the contender is known to be waiting on the handover, with
// no sleep to guess the timing. Scoped to this database and application name,
// like the probe in pool.test.ts, so a dev server on the same cluster is never
// observed. Test-only, like the reset above.
export async function waitForLockedStatement(timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await pool.query(
      `SELECT 1 FROM pg_stat_activity
       WHERE datname = current_database()
         AND application_name = 'ename-backend'
         AND wait_event_type = 'Lock'`,
    );
    if ((result.rowCount ?? 0) > 0) return;
    if (Date.now() > deadline) {
      throw new Error('no statement blocked on a lock before timeout');
    }
    await sleep(10);
  }
}

// Read the values a CHECK constraint enumerates: the `'…'::text` literals of
// the expression the catalog renders — `kind = ANY (ARRAY['a'::text,
// 'b'::text])`, or `kind = 'a'::text` for a single value. Meaningful only for
// a CHECK that is a list of values, the shape of every vocabulary column (cf.
// ename-internals.md); a concept's test compares it with the vocabulary its
// code declares, in both directions. Throws when no CHECK has that name, so a
// renamed constraint is reported rather than read as empty. Test-only, like
// the helpers above.
export async function readCheckConstraintValues(constraintName: string): Promise<string[]> {
  const result = await pool.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(oid) AS definition
     FROM pg_constraint
     WHERE contype = 'c' AND conname = $1`,
    [constraintName],
  );
  const definition = result.rows[0]?.definition;
  if (definition === undefined) {
    throw new Error(`no CHECK constraint named ${constraintName}`);
  }
  return [...definition.matchAll(/'([^']*)'::text/g)].flatMap((match) => match[1] ?? []);
}
