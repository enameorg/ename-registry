import { after, beforeEach } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { config } from '../config.ts';

import { closePool, pool } from './pool.ts';

// Register the full test DB lifecycle for one test file: reset projections and
// event log before each test, then release the singleton pool so node:test can
// exit without waiting for idle client timeout.
export function useTestDb(): void {
  beforeEach(async () => {
    await resetTestDb();
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
async function resetTestDb(): Promise<void> {
  if (config.nodeEnv !== 'test') {
    throw new Error(`resetTestDb() called with NODE_ENV=${config.nodeEnv}; only allowed in 'test'`);
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
