import { OpenAPIHono } from '@hono/zod-openapi';
import { Scalar } from '@scalar/hono-api-reference';

import { healthHandler, healthRoute } from './application.ts';
import { openApiMetadata } from './openapi-metadata.ts';

export const api = new OpenAPIHono();

api.openapi(healthRoute, healthHandler);

// Expose the live spec at /api/v1/openapi.json (relative to the v1 mount point).
// The `servers` field makes the spec self-describing: paths declared as `/health`
// inside the v1 sub-app are absolute under the `/api/v1` base URL.
// Pretty-printed unconditionally: this endpoint is documentation, consumed by
// humans and doc tooling, not by hot-path machine clients.
api.get('/openapi.json', (context) => {
  const spec = api.getOpenAPI31Document({
    openapi: openApiMetadata.openapi,
    info: openApiMetadata.info,
    servers: [{ url: '/api/v1' }],
  });
  return context.text(JSON.stringify(spec, null, 2) + '\n', 200, {
    'Content-Type': 'application/json',
  });
});

// Interactive API reference + client, reading the live spec at each load.
// No duplication, no import step: the page is always in sync with the running app.
api.get(
  '/docs',
  Scalar({
    url: '/api/v1/openapi.json',
    pageTitle: 'Ename Registry API',
  }),
);
