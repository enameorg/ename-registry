import { createRoute, type RouteHandler, z } from '@hono/zod-openapi';

import { health } from '../../services/application/index.ts';
import type { HonoEnv } from '../context.ts';

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

export const HealthResponseSchema = z
  .object({
    status: z.enum(['ok', 'unhealthy']).openapi({ example: 'ok' }),
  })
  .openapi('HealthResponse');

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

// Liveness: the process answers and nothing else is checked, so a database
// outage degrades the API (writes answer 503 Problem Details) instead of taking
// every instance out of rotation through the container's probe. The 503 branch
// stays declared for a future shutdown signal; dependencies are checked by
// /health/deep (cf. ename-internals.md).
export const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  summary: 'Service health check',
  description:
    'Returns 200 with status "ok" when the service is healthy, 503 with status "unhealthy" otherwise.',
  responses: {
    200: {
      description: 'Service is healthy',
      content: {
        'application/json': { schema: HealthResponseSchema },
      },
    },
    503: {
      description: 'Service is unhealthy',
      content: {
        'application/json': { schema: HealthResponseSchema },
      },
    },
  },
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const healthHandler: RouteHandler<typeof healthRoute, HonoEnv> = (context) => {
  return health()
    ? context.json({ status: 'ok' as const }, 200)
    : context.json({ status: 'unhealthy' as const }, 503);
};
