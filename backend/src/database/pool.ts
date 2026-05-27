import pg from 'pg';

import { config } from '../config.ts';

// Singleton Pool initialized at module load. Same configuration in dev and prod —
// statement_timeout / query_timeout are intentionally identical so slow queries
// surface during development, not in production. Sized for one container at a time;
// revisit only on observed queueing.
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  application_name: 'ename-backend',
  statement_timeout: 5_000,
  query_timeout: 10_000,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 10_000,
  max: 10,
});
