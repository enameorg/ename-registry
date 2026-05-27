import { createRoute, type RouteHandler, z } from '@hono/zod-openapi';

import { health } from '../services/application.ts';

import type { RequestContextVariables } from './middleware.ts';

const HealthResponseSchema = z
  .object({
    status: z.enum(['ok', 'unhealthy']).openapi({ example: 'ok' }),
  })
  .openapi('HealthResponse');

// Forward declaration: the 503 branch is part of the contract from day one so
// external monitoring can be wired against the documented response shape, but
// `health()` currently has no failure path (returns `true` unconditionally).
// Real liveness signals — DB ping, dependency checks — will populate the 503
// path; the response shape will stay the same.
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

export const healthHandler: RouteHandler<
  typeof healthRoute,
  { Variables: RequestContextVariables }
> = (context) => {
  return health()
    ? context.json({ status: 'ok' as const }, 200)
    : context.json({ status: 'unhealthy' as const }, 503);
};
