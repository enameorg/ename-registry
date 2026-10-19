import type { MiddlewareHandler } from 'hono';

import { logger as rootLogger } from '../logger.ts';
import { generateUUIDv7 } from '../utilities/uuid.ts';

import type { HonoEnv } from './context.ts';

const REQUEST_ID_HEADER = 'X-Request-Id';

// Generates requestId, binds a child logger, sets the response header, logs
// entrance and exit. A client-provided header is deliberately NOT trusted —
// it would let any caller poison the logs.
export const requestContext: MiddlewareHandler<HonoEnv> = async (context, next) => {
  const requestId = generateUUIDv7();
  const childLogger = rootLogger.child({ requestId });

  context.set('requestId', requestId);
  context.set('logger', childLogger);
  context.header(REQUEST_ID_HEADER, requestId);

  const startedAt = performance.now();
  const method = context.req.method;
  const path = context.req.path;

  childLogger.info({ method, path }, 'request received');

  try {
    await next();
  } finally {
    const durationMs = Math.round(performance.now() - startedAt);
    const status = context.res.status;
    // Status >= 500 is logged at error level so it surfaces in production
    // alerting; 4xx and 2xx stay at info — they are normal request outcomes.
    const level = status >= 500 ? 'error' : 'info';
    childLogger[level]({ method, path, status, durationMs }, 'request completed');
  }
};
