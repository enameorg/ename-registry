import { config } from '../config.ts';

import { pool } from './pool.ts';

// TRUNCATE all user tables in the public schema. Sequences are reset by
// RESTART IDENTITY; foreign keys are followed by CASCADE.
//
// Safety net: refuse to run unless NODE_ENV=test. This is what stands between
// a misconfigured test runner and the dev database. The two URLs in .env are
// the first guard; this is the second.
//
// Uses the singleton pool from `./pool.ts` directly: the app has one pool, and
// this helper is only ever called from tests — no need to parameterize. Keeps
// call sites a one-symbol import (`resetTestDb`) so test files in higher
// layers don't need to reference `pool` themselves.
export async function resetTestDb(): Promise<void> {
  if (config.nodeEnv !== 'test') {
    throw new Error(`resetTestDb() called with NODE_ENV=${config.nodeEnv}; only allowed in 'test'`);
  }

  const result = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );

  if (result.rows.length === 0) return;

  // String interpolation rather than parameterized statement: `TRUNCATE TABLE`
  // does not accept identifier placeholders, so the table names must be
  // splice in textually. Safe here because the source (`pg_tables`) is the
  // PostgreSQL catalog itself — values cannot be attacker-controlled — and
  // the function is gated by the NODE_ENV=test guard above. Identifiers are
  // double-quoted defensively against any future identifier that happens to
  // collide with a SQL reserved word.
  const tableList = result.rows.map((row) => `"${row.tablename}"`).join(', ');
  await pool.query(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
}
