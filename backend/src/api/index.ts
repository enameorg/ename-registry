import { OpenAPIHono } from '@hono/zod-openapi';
import { Scalar } from '@scalar/hono-api-reference';
import type { Context } from 'hono';
import type { ClientErrorStatusCode, ServerErrorStatusCode } from 'hono/utils/http-status';

import { ContentionError, IdempotencyConflictError, ValidationError } from '../services/errors.ts';

import { healthHandler, healthRoute } from './application.ts';
import { requestContext, type RequestContextVariables } from './middleware.ts';
import { openApiMetadata } from './openapi-metadata.ts';
import { PROBLEM_CONTENT_TYPE, type ProblemDetails } from './problem.ts';
import { registerSubjectHandler, registerSubjectRoute } from './subject.ts';

type ApiContext = Context<{ Variables: RequestContextVariables }>;

// Retry-After hint (seconds) sent with 503 ContentionError responses. Kept
// short: number_part allocation contention on a single name_part clears in
// milliseconds, so a 1-second floor is already generous.
const RETRY_AFTER_SECONDS = 1;

// Single Problem Details builder. Centralizes the shape and the
// Content-Type header so no handler can drift accidentally.
function problemJson(
  context: ApiContext,
  status: ClientErrorStatusCode | ServerErrorStatusCode,
  title: string,
  detail: string,
  errors?: ProblemDetails['errors'],
): Response {
  const body: ProblemDetails = {
    type: 'about:blank',
    title,
    status,
    detail,
    requestId: context.var.requestId,
    ...(errors !== undefined ? { errors } : {}),
  };
  return context.json(body, status, { 'Content-Type': PROBLEM_CONTENT_TYPE });
}

export const api = new OpenAPIHono<{ Variables: RequestContextVariables }>({
  // Intercepts Zod validation failures from `createRoute(...)` request
  // schemas BEFORE the handler runs, and maps them to a RFC 9457
  // Problem Details 422 response. Without this hook, @hono/zod-openapi
  // emits its own default error shape, which would drift from our contract.
  defaultHook: (result, context) => {
    if (!result.success) {
      const issues = result.error.issues.map((issue) => ({
        // Cast: Zod's `issue.path` is typed `PropertyKey[]` (includes
        // `symbol`), but JSON Schema paths only ever contain strings or
        // numbers in practice — symbols cannot appear in a parsed JSON
        // structure. Narrowing here keeps the public ProblemDetails shape
        // JSON-safe.
        path: [...issue.path] as Array<string | number>,
        message: issue.message,
      }));
      const issueCount = issues.length;
      return problemJson(
        context,
        422,
        'Validation failed',
        `${issueCount} validation error${issueCount === 1 ? '' : 's'}`,
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

api.openapi(healthRoute, healthHandler);
api.openapi(registerSubjectRoute, registerSubjectHandler);

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

// Maps uncaught errors thrown by handlers (and by services they call) to
// Problem Details responses. Domain errors carry their HTTP semantics here,
// not in the service — services don't know about HTTP status codes.
api.onError((error, context) => {
  if (error instanceof ValidationError) {
    return problemJson(context, 422, 'Validation failed', error.message, error.errors);
  }
  if (error instanceof IdempotencyConflictError) {
    return problemJson(context, 409, 'Idempotency conflict', error.message);
  }
  if (error instanceof ContentionError) {
    // Transient capacity signal, not a server fault. The Retry-After header
    // tells a well-behaved client to retry; the value is a short fixed hint
    // (contention on a hot name_part resolves in milliseconds in practice).
    const response = problemJson(context, 503, 'Service temporarily unavailable', error.message);
    response.headers.set('Retry-After', String(RETRY_AFTER_SECONDS));
    return response;
  }
  // Unexpected: log with the pino err serializer (stack + cause) and
  // return an opaque 500. The requestId in the body lets us find the
  // matching log entry.
  context.var.logger.error({ err: error }, 'unhandled error in request');
  return problemJson(
    context,
    500,
    'Internal server error',
    'an unexpected error occurred; the requestId can be used to correlate with server logs',
  );
});
