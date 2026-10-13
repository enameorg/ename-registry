import { OpenAPIHono } from '@hono/zod-openapi';
import { Scalar } from '@scalar/hono-api-reference';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { methodNotAllowed } from 'hono/method-not-allowed';
import type { ClientErrorStatusCode, ServerErrorStatusCode } from 'hono/utils/http-status';

import {
  ConflictError,
  ContentionError,
  IdempotencyConflictError,
  NotFoundError,
  ValidationError,
} from '../services/errors.ts';

import { healthDeepHandler, healthDeepRoute } from './application/health-deep.ts';
import { healthHandler, healthRoute } from './application/health.ts';
import type { HonoEnv } from './context.ts';
import { requestContext } from './middleware.ts';
import { openApiMetadata } from './openapi-metadata.ts';
import { buildProblemJson } from './problem.ts';
import {
  addEnameToSubjectHandler,
  addEnameToSubjectRoute,
} from './subject/add-ename-to-subject.ts';
import { registerSubjectHandler, registerSubjectRoute } from './subject/register-subject.ts';

// Retry-After hint (seconds) sent with 503 ContentionError responses. Kept
// short: number_part allocation contention on a single name_part clears in
// milliseconds, so a 1-second floor is already generous.
const RETRY_AFTER_SECONDS = 1;

// Where this version is mounted (cf. src/index.ts). Carried by the OpenAPI
// `servers` entry so the document's relative paths resolve, and by the Scalar
// page to find the spec.
const BASE_PATH = '/api/v1';

// Cap on any request body, enforced by the body-limit middleware before routing.
// Far above every legitimate v1 body (a registration is about 150 bytes), so no
// well-formed client meets it. An internal protection, not a contract value
// (cf. ename-internals.md): revisable without a contract change.
export const MAX_BODY_BYTES = 64 * 1024;

// Problem Details (title + client-facing detail) for the HTTP statuses the
// framework raises as an HTTPException before a handler runs: 400 from the json
// validator on a body that is not valid JSON, 413 from the body-limit middleware
// on a body over MAX_BODY_BYTES, 415 from @hono/zod-openapi's media-type gate on
// a body whose Content-Type is not the declared application/json. We phrase the
// detail ourselves rather than surface the framework's message, so the public
// contract stays stable across the framework (and the Rust port).
const HTTP_EXCEPTION_PROBLEMS: Record<number, { title: string; detail: string }> = {
  400: { title: 'Bad request', detail: 'The request body is not valid JSON.' },
  413: {
    title: 'Content too large',
    detail: `The request body must not exceed ${MAX_BODY_BYTES} bytes.`,
  },
  415: {
    title: 'Unsupported media type',
    detail: 'The request body must be sent as application/json.',
  },
};

export const api = new OpenAPIHono<HonoEnv>({
  // Maps Zod request-validation failures to an RFC 9457 422 before the handler
  // runs. Without this hook @hono/zod-openapi emits its own shape, drifting
  // from our contract.
  defaultHook: (result, context) => {
    if (!result.success) {
      const issues = result.error.issues.map((issue) => ({
        // Cast: Zod types issue.path as PropertyKey[] (includes symbol), but a
        // parsed JSON structure only ever has string/number paths. Narrowing
        // keeps the ProblemDetails shape JSON-safe.
        path: [...issue.path] as Array<string | number>,
        message: issue.message,
      }));
      const issueCount = issues.length;
      return buildProblemJson(
        context,
        422,
        'Validation failed',
        `${issueCount} validation error${issueCount === 1 ? '' : 's'}.`,
        issues,
      );
    }
    // Type contract of defaultHook: must return Response | void. On
    // success path we let the handler run by returning nothing.
    return;
  },
});

// Generates a server-side requestId, binds a Pino child logger, logs
// entrance/exit. Applied to every route inside the v1 sub-app — including
// `/openapi.json` and `/docs` so a failed spec fetch is still traceable.
api.use('*', requestContext);

// Refuse an oversized body before routing: on Content-Length alone when the
// client announces it, otherwise by cutting the stream at the limit. Raises an
// HTTPException(413), mapped in onError like the other framework statuses.
api.use('*', bodyLimit({ maxSize: MAX_BODY_BYTES }));

// A known path with an unsupported method answers 405 with an Allow header, as
// a Problem Details like every other 4xx. The middleware is mount-aware (it
// strips the mount prefix before matching this version's routes) and leaves a
// 404 that came through onError alone (an unknown subject stays a 404).
api.use(
  '*',
  methodNotAllowed({
    app: api,
    onMethodNotAllowed: (context, methods) => {
      const response = buildProblemJson(
        context,
        405,
        'Method not allowed',
        'This method is not allowed at this path; the Allow header lists the allowed methods.',
      );
      response.headers.set('Allow', methods.join(', '));
      return response;
    },
  }),
);

api.openapi(healthRoute, healthHandler);
api.openapi(healthDeepRoute, healthDeepHandler);
api.openapi(registerSubjectRoute, registerSubjectHandler);
api.openapi(addEnameToSubjectRoute, addEnameToSubjectHandler);

// The live spec, byte-identical to the committed backend/openapi.json (see
// renderOpenApiDocument below).
api.get('/openapi.json', (context) => {
  return context.text(renderOpenApiDocument(), 200, { 'Content-Type': 'application/json' });
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

// An unmatched path under this version answers a Problem Details 404, not
// Hono's text/plain default. app.route() does not carry a sub-app's notFound()
// over, hence a terminal route, registered last so every real route wins first.
// Paths outside the version prefix are the root's concern, not this sub-app's.
api.all('*', (context) =>
  buildProblemJson(context, 404, 'Not found', 'No resource exists at this path.'),
);

// Maps uncaught errors thrown by handlers (and by services they call) to
// Problem Details responses. Domain errors carry their HTTP semantics here,
// not in the service — services don't know about HTTP status codes.
api.onError((error, context) => {
  if (error instanceof ValidationError) {
    return buildProblemJson(context, 422, 'Validation failed', error.message, error.errors);
  }
  if (error instanceof IdempotencyConflictError) {
    return buildProblemJson(context, 409, 'Idempotency conflict', error.message);
  }
  if (error instanceof ConflictError) {
    return buildProblemJson(context, 409, 'Conflict', error.message);
  }
  if (error instanceof NotFoundError) {
    return buildProblemJson(context, 404, 'Not found', error.message);
  }
  if (error instanceof ContentionError) {
    // Transient capacity signal, not a server fault — the Retry-After header
    // tells a well-behaved client to retry.
    const response = buildProblemJson(
      context,
      503,
      'Service temporarily unavailable',
      error.message,
    );
    response.headers.set('Retry-After', String(RETRY_AFTER_SECONDS));
    return response;
  }
  // The framework throws an HTTPException before the handler runs for a body
  // that is not valid JSON (400), over the size cap (413) or not application/json
  // (415). Surface the status as Problem Details instead of letting it fall
  // through to the opaque 500 below.
  if (error instanceof HTTPException) {
    const status = error.status as ClientErrorStatusCode | ServerErrorStatusCode;
    const problem = HTTP_EXCEPTION_PROBLEMS[status];
    if (problem) {
      return buildProblemJson(context, status, problem.title, problem.detail);
    }
    // An HTTPException with a status we don't explicitly own: log it (its
    // message may carry framework-internal vocabulary) and return a generic
    // problem rather than leaking the raw message to the client.
    context.var.logger.error({ err: error }, 'unmapped HTTPException in request');
    return buildProblemJson(
      context,
      status,
      'Request error',
      'The request could not be processed.',
    );
  }
  // Unexpected: log with the pino err serializer (stack + cause) and
  // return an opaque 500. The requestId in the body lets us find the
  // matching log entry.
  context.var.logger.error({ err: error }, 'unhandled error in request');
  return buildProblemJson(
    context,
    500,
    'Internal server error',
    'An unexpected error occurred; the requestId can be used to correlate with server logs.',
  );
});

// The single generator of the v1 contract (cf. ename-internals.md): the
// runtime endpoint above and scripts/generate-openapi.ts both serialize this
// document, so the two representations cannot drift. Paths are relative to the
// version's mount, which the `servers` entry carries. Pretty-printed: this is
// documentation for humans and tooling, not a hot-path payload.
export function renderOpenApiDocument(): string {
  const document = api.getOpenAPI31Document({
    openapi: openApiMetadata.openapi,
    info: openApiMetadata.info,
    servers: [{ url: BASE_PATH }],
  });
  return JSON.stringify(document, null, 2) + '\n';
}
