import { after, beforeEach } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { config } from '../config.ts';

import { closePool, pool } from './pool.ts';

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
// sequences, CASCADE follows foreign keys).
//
// Safety net: refuse to run unless NODE_ENV=test — the second guard (after the
// two distinct .env URLs) between a misconfigured test runner and the dev DB.
//
// Uses the singleton pool directly: this helper only runs from tests, and the
// enclosing lifecycle helper keeps the reset itself out of higher-layer test files.
async function resetTestDB(): Promise<void> {
  if (config.nodeEnv !== 'test') {
    throw new Error(`resetTestDB() called with NODE_ENV=${config.nodeEnv}; only allowed in 'test'`);
  }

  const result = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );

  if (result.rows.length === 0) return;

  // String interpolation, not a placeholder: TRUNCATE TABLE takes no identifier
  // placeholders. Safe here — the source (pg_tables) is the PostgreSQL catalog,
  // not attacker input, and the NODE_ENV=test guard gates the function.
  // Identifiers are double-quoted in case one collides with a reserved word.
  const tableList = result.rows.map((row) => `"${row.tablename}"`).join(', ');
  await pool.query(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
}

// TRUNCATE every projection — every table but the event log and the migration
// ledger — and leave the log as it is: the starting point of a rebuild test,
// which writes the projections again from the log and compares. Listing the
// tables from the catalog keeps a projection added later in scope. Same
// NODE_ENV=test guard as the reset above.
export async function truncateProjections(): Promise<void> {
  if (config.nodeEnv !== 'test') {
    throw new Error(
      `truncateProjections() called with NODE_ENV=${config.nodeEnv}; only allowed in 'test'`,
    );
  }

  const result = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename NOT IN ('events', 'schema_migrations')`,
  );

  if (result.rows.length === 0) return;

  // Interpolated for the same reason, and as safely, as in resetTestDB.
  const tableList = result.rows.map((row) => `"${row.tablename}"`).join(', ');
  await pool.query(`TRUNCATE TABLE ${tableList}`);
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
