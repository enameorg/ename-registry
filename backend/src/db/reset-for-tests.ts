import type { Pool } from 'pg';

import { config } from '../config.ts';

// TRUNCATE all user tables in the public schema. Sequences are reset by
// RESTART IDENTITY; foreign keys are followed by CASCADE.
//
// Safety net: refuse to run unless NODE_ENV=test. This is what stands between
// a misconfigured test runner and the dev database. The two URLs in .env are
// the first guard; this is the second.
export async function resetTestDb(pool: Pool): Promise<void> {
  if (config.nodeEnv !== 'test') {
    throw new Error(`resetTestDb() called with NODE_ENV=${config.nodeEnv}; only allowed in 'test'`);
  }

  const result = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );

  if (result.rows.length === 0) return;

  const tableList = result.rows.map((r) => `"${r.tablename}"`).join(', ');
  await pool.query(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
}
