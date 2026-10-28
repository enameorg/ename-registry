import pg from 'pg';

import { config } from '../config.ts';
import { logger } from '../logger.ts';

// Singleton Pool initialized at module load. The timeouts are hard-coded and
// identical in dev and prod — statement_timeout / query_timeout are the code's
// latency SLA, so slow queries surface during development, not in production.
// The size comes from configuration: it follows the deployment (cf.
// ename-internals.md). Connections open on demand up to the size and close
// after idleTimeoutMillis, so the size is a cap, not a cost at rest.
export const pool = new pg.Pool({
  connectionString: config.databaseURL,
  application_name: 'ename-backend',
  statement_timeout: 5_000,
  query_timeout: 10_000,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 10_000,
  max: config.databasePoolSize,
});

// pg emits 'error' on the pool when an idle client loses its connection (server
// restart, PgBouncer recycle, network drop). Without a listener Node treats it
// as an uncaught exception and kills the process. The pool has already evicted
// the client by the time this fires, so logging is all that is left to do.
pool.on('error', (error) => {
  logger.error({ err: error }, 'idle database client lost its connection');
});

// Named lifecycle seam for graceful shutdown: drains in-flight queries and closes
// every pooled connection. Called once, through the Service layer's closeDatabase,
// after the HTTP server has stopped accepting requests; keeps pg's end() mechanics
// confined to src/database.
export async function closePool(): Promise<void> {
  await pool.end();
}
