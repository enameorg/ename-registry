import { serve } from '@hono/node-server';

import { config } from './config.ts';
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

  httpServer.close((error) => {
    clearTimeout(timeout);
    if (error) {
      logger.error({ err: error }, 'http server close failed');
      process.exit(1);
    }
    logger.info('shutdown complete');
    process.exit(0);
  });
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});
