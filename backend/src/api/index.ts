import { OpenAPIHono } from '@hono/zod-openapi';
import { Scalar } from '@scalar/hono-api-reference';
import { bodyLimit } from 'hono/body-limit';
import { methodNotAllowed } from 'hono/method-not-allowed';

import {
  healthDeepHandler,
  healthDeepRoute,
  healthHandler,
  healthRoute,
} from './application/index.ts';
import type { HonoEnv } from './context.ts';
import {
  handleError,
  methodNotAllowedResponse,
  notFoundResponse,
  validationHook,
} from './errors.ts';
import { MAX_BODY_BYTES, requestContext } from './middleware.ts';
import { openAPIMetadata } from './openapi-metadata.ts';
import {
  addEnameToSubjectHandler,
  addEnameToSubjectRoute,
  registerSubjectHandler,
  registerSubjectRoute,
} from './subject/index.ts';

// The v1 mount table: middleware order, routes, fallbacks, OpenAPI rendering.
// Every error answer is the errors module's (cf. ename-internals.md).

// Where this version is mounted (cf. src/index.ts). Carried by the OpenAPI
// `servers` entry so the document's relative paths resolve, and by the Scalar
// page to find the spec.
const BASE_PATH = '/api/v1';

export const api = new OpenAPIHono<HonoEnv>({ defaultHook: validationHook });

// Generates a server-side requestId, binds a Pino child logger, logs
// entrance/exit. Applied to every route inside the v1 sub-app — including
// `/openapi.json` and `/docs` so a failed spec fetch is still traceable.
api.use('*', requestContext);

// Refuse an oversized body before routing: on Content-Length alone when the
// client announces it, otherwise by cutting the stream at the limit. Raises an
// HTTPException(413), mapped by handleError like the other framework statuses.
api.use('*', bodyLimit({ maxSize: MAX_BODY_BYTES }));

// The middleware is mount-aware (it strips the mount prefix before matching
// this version's routes) and leaves a 404 that came through handleError alone
// (an unknown subject stays a 404).
api.use('*', methodNotAllowed({ app: api, onMethodNotAllowed: methodNotAllowedResponse }));

api.openapi(healthRoute, healthHandler);
api.openapi(healthDeepRoute, healthDeepHandler);
api.openapi(registerSubjectRoute, registerSubjectHandler);
api.openapi(addEnameToSubjectRoute, addEnameToSubjectHandler);

// The live spec, byte-identical to the committed backend/openapi.json (see
// renderOpenAPIDocument below).
api.get('/openapi.json', (context) => {
  return context.text(renderOpenAPIDocument(), 200, { 'Content-Type': 'application/json' });
});

// Interactive API reference + client, reading the live spec at each load, so the
// page is always in sync with the running app. Interim: the reference page moves
// to the frontend and this route goes away (cf. ename-internals.md).
api.get(
  '/docs',
  Scalar({
    url: `${BASE_PATH}/openapi.json`,
    pageTitle: 'Ename Registry API',
  }),
);

// app.route() does not carry a sub-app's notFound() over, hence a terminal
// route, registered last so every real route wins first. Paths outside the
// version prefix are the root's concern, not this sub-app's.
api.all('*', notFoundResponse);

api.onError(handleError);

// The single generator of the v1 contract (cf. ename-internals.md): the
// runtime endpoint above and scripts/generate-openapi.ts both serialize this
// document, so the two representations cannot drift. Paths are relative to the
// version's mount, which the `servers` entry carries. Pretty-printed: this is
// documentation for humans and tooling, not a hot-path payload.
export function renderOpenAPIDocument(): string {
  const document = api.getOpenAPI31Document({
    openapi: openAPIMetadata.openapi,
    info: openAPIMetadata.info,
    servers: [{ url: BASE_PATH }],
  });
  return JSON.stringify(document, null, 2) + '\n';
}
