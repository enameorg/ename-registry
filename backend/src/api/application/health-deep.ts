import { createRoute, type RouteHandler } from '@hono/zod-openapi';

import { checkDatabase } from '../../services/application/index.ts';
import type { HonoEnv } from '../context.ts';

import { HealthResponseSchema } from './health.ts';

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

// Deep check for monitoring, smoke tests and alerting: the database must answer
// within a short bound. Never the container's probe (cf. ename-internals.md).
export const healthDeepRoute = createRoute({
  method: 'get',
  path: '/health/deep',
  summary: 'Deep health check (database)',
  description:
    'Returns 200 with status "ok" when the database answers a trivial query within a short bound, ' +
    '503 with status "unhealthy" otherwise. Meant for monitoring and smoke tests, not for the container liveness probe.',
  responses: {
    200: {
      description: 'Service and its database are healthy',
      content: {
        'application/json': { schema: HealthResponseSchema },
      },
    },
    503: {
      description: 'Database unreachable or too slow',
      content: {
        'application/json': { schema: HealthResponseSchema },
      },
    },
  },
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const healthDeepHandler: RouteHandler<typeof healthDeepRoute, HonoEnv> = async (context) => {
  const healthy = await checkDatabase({ logger: context.var.logger });
  return healthy
    ? context.json({ status: 'ok' as const }, 200)
    : context.json({ status: 'unhealthy' as const }, 503);
};
