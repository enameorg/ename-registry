import { serve } from '@hono/node-server';

import { config } from './config.ts';
import { closePool } from './database/pool.ts';
import { app } from './index.ts';
import { logger } from './logger.ts';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const httpServer = serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  logger.info({ port }, 'http server listening');
});

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, 'shutdown initiated');

  const timeout = setTimeout(() => {
    logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'shutdown timeout exceeded, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  // Drain in-flight HTTP requests first, then release the DB pool, so no handler
  // loses its connection mid-query.
  httpServer.close((error) => {
    void closeResources(error, timeout);
  });
}

async function closeResources(
  httpError: Error | undefined,
  timeout: NodeJS.Timeout,
): Promise<void> {
  let failed = false;

  if (httpError) {
    logger.error({ err: httpError }, 'http server close failed');
    failed = true;
  }

  try {
    await closePool();
  } catch (error) {
    logger.error({ err: error }, 'database pool close failed');
    failed = true;
  }

  clearTimeout(timeout);

  if (failed) {
    process.exit(1);
  }

  logger.info('shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});
