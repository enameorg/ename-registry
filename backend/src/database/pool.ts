import pg from 'pg';

import { config } from '../config.ts';
import { logger } from '../logger.ts';

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

// pg emits 'error' on the pool when an idle client loses its connection (server
// restart, PgBouncer recycle, network drop). Without a listener Node treats it
// as an uncaught exception and kills the process. The pool has already evicted
// the client by the time this fires, so logging is all that is left to do.
pool.on('error', (error) => {
  logger.error({ err: error }, 'idle database client lost its connection');
});

// Named lifecycle seam for graceful shutdown: drains in-flight queries and closes
// every pooled connection. Called once by the runtime entry, after the HTTP server
// has stopped accepting requests; keeps pg's end() mechanics confined to src/database.
export async function closePool(): Promise<void> {
  await pool.end();
}
