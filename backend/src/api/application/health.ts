import { createRoute, type RouteHandler, z } from '@hono/zod-openapi';

import { health } from '../../services/application/index.ts';
import type { HonoEnv } from '../context.ts';

const HealthResponseSchema = z
  .object({
    status: z.enum(['ok', 'unhealthy']).openapi({ example: 'ok' }),
  })
  .openapi('HealthResponse');

// The 503 branch is in the contract from day one so monitoring can wire against
// it, but health() has no failure path yet (returns true). Real liveness checks
// (DB ping, dependencies) will populate the 503 path later.
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

export const healthHandler: RouteHandler<typeof healthRoute, HonoEnv> = (context) => {
  return health()
    ? context.json({ status: 'ok' as const }, 200)
    : context.json({ status: 'unhealthy' as const }, 503);
};
