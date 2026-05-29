import { config } from '../config.ts';

import { pool } from './pool.ts';

// TRUNCATE all user tables in the public schema (RESTART IDENTITY resets
// sequences, CASCADE follows foreign keys).
//
// Safety net: refuse to run unless NODE_ENV=test — the second guard (after the
// two distinct .env URLs) between a misconfigured test runner and the dev DB.
//
// Uses the singleton pool directly: this helper only runs from tests, and a
// parameter-free signature keeps `pool` out of higher-layer test files.
export async function resetTestDb(): Promise<void> {
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
