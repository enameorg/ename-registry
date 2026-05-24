import { createRoute, type RouteHandler, z } from '@hono/zod-openapi';

import { health } from '../services/application.ts';

const HealthResponseSchema = z
  .object({
    status: z.enum(['ok', 'unhealthy']).openapi({ example: 'ok' }),
  })
  .openapi('HealthResponse');

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

export const healthHandler: RouteHandler<typeof healthRoute> = (context) => {
  return health()
    ? context.json({ status: 'ok' as const }, 200)
    : context.json({ status: 'unhealthy' as const }, 503);
};
