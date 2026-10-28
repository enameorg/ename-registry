import { type OpenAPIHonoOptions, z } from '@hono/zod-openapi';
import type { ErrorHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ClientErrorStatusCode, ServerErrorStatusCode } from 'hono/utils/http-status';

import {
  ConflictError,
  ContentionError,
  IdempotencyConflictError,
  NotFoundError,
  ValidationError,
  validationErrorFromZodError,
} from '../services/errors.ts';
import { UUIDv7Schema } from '../utilities/uuid.ts';

import type { APIContext, HonoEnv } from './context.ts';
import { MAX_BODY_BYTES } from './middleware.ts';

// The API's error policy: everything that turns an error into a response lives
// here, so the assembly module stays a bare mount table. One shape (RFC 9457
// Problem Details) for every 4xx/5xx, one mapping from each error to its status
// and client-facing text (cf. ename-internals.md).

// ---------------------------------------------------------------------------
// Problem Details shape and mapping tables
// ---------------------------------------------------------------------------

type ProblemStatus = ClientErrorStatusCode | ServerErrorStatusCode;

// RFC 9457 Problem Details — the single shape for every 4xx/5xx response, served
// as application/problem+json. Extensions beyond the RFC base: requestId (the
// middleware's id, echoed so a user can quote it) and errors (field-level Zod
// failures). `instance` is omitted in v1 — requestId plays that role.
export const ProblemDetailsSchema = z
  .object({
    type: z.string().openapi({ example: 'about:blank' }),
    title: z.string().openapi({ example: 'Validation failed' }),
    status: z.number().int().openapi({ example: 422 }),
    detail: z.string().openapi({ example: '1 validation error.' }),
    requestId: UUIDv7Schema.openapi({ example: '01927e8f-9b2a-7c3d-8e4f-5a6b7c8d9e2b' }),
    errors: z
      .array(
        z.object({
          path: z.array(z.union([z.string(), z.number()])),
          message: z.string(),
        }),
      )
      .optional()
      .openapi({
        example: [{ path: ['namePart'], message: 'invalid format' }],
      }),
  })
  .openapi('ProblemDetails');

export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;

const PROBLEM_CONTENT_TYPE = 'application/problem+json';

// The title derives from the status: with `type: about:blank` the title is the
// status's label, not the occurrence's (RFC 9457). A caller overrides it only
// to name a sub-type a client must tell apart — today the idempotency 409 — and
// the override goes away once error-type URIs carry that distinction (target).
const PROBLEM_TITLES: Partial<Record<ProblemStatus, string>> = {
  400: 'Bad request',
  404: 'Not found',
  405: 'Method not allowed',
  409: 'Conflict',
  413: 'Content too large',
  415: 'Unsupported media type',
  422: 'Validation failed',
  500: 'Internal server error',
  503: 'Service temporarily unavailable',
};

// Title of a status the version does not answer itself (an HTTPException raised
// by a framework path the mapping does not own).
const FALLBACK_TITLE = 'Request error';

// Client-facing detail for the HTTP statuses the framework raises as an
// HTTPException before a handler runs: 400 from the json validator on a body
// that is not valid JSON, 413 from the body-limit middleware on a body over
// MAX_BODY_BYTES, 415 from @hono/zod-openapi's media-type gate on a body whose
// Content-Type is not the declared application/json. We phrase the detail
// ourselves rather than surface the framework's message, so the public contract
// stays stable across the framework (and the Rust port).
const HTTP_EXCEPTION_DETAILS: Partial<Record<ProblemStatus, string>> = {
  400: 'The request body is not valid JSON.',
  413: `The request body must not exceed ${MAX_BODY_BYTES} bytes.`,
  415: 'The request body must be sent as application/json.',
};

// Retry-After hint (seconds) sent with 503 ContentionError responses. Kept
// short: number_part allocation contention on a single name_part clears in
// milliseconds, so a 1-second floor is already generous.
const RETRY_AFTER_SECONDS = 1;

// The responses the version's body gates answer before any handler with a JSON
// body runs (cf. HTTP_EXCEPTION_DETAILS). A route spreads them into its
// `responses` and declares its own statuses beside them; 422 stays the route's
// because its description names what the route validates (body, path).
export const gateProblemResponses = {
  400: problemResponse('Request body could not be read properly'),
  413: problemResponse('Request body exceeds the size limit'),
  415: problemResponse('Request body media type is not supported'),
};

// ---------------------------------------------------------------------------
// Error → response mapping
// ---------------------------------------------------------------------------

// Maps Zod request-validation failures to an RFC 9457 422 before the handler
// runs (the sub-app's defaultHook). Without it @hono/zod-openapi emits its own
// shape, drifting from our contract. The failure goes through the Service's
// own translation, so this 422 and the one handleError builds from a
// ValidationError carry the same detail and issues.
export const validationHook: NonNullable<OpenAPIHonoOptions<HonoEnv>['defaultHook']> = (
  result,
  context,
) => {
  if (!result.success) {
    const error = validationErrorFromZodError(result.error);
    return buildProblemJSON(context, 422, error.message, { errors: error.errors });
  }
  // Type contract of defaultHook: must return Response | void. On the success
  // path we let the handler run by returning nothing.
  return;
};

// Maps every uncaught error (thrown by a handler, a service it calls, or the
// framework before the handler) to a Problem Details response — the sub-app's
// onError. Domain errors carry their HTTP semantics here, not in the service.
export const handleError: ErrorHandler<HonoEnv> = (error, context) => {
  if (error instanceof ValidationError) {
    return buildProblemJSON(context, 422, error.message, { errors: error.errors });
  }
  if (error instanceof IdempotencyConflictError) {
    return buildProblemJSON(context, 409, error.message, { title: 'Idempotency conflict' });
  }
  if (error instanceof ConflictError) {
    return buildProblemJSON(context, 409, error.message);
  }
  if (error instanceof NotFoundError) {
    return buildProblemJSON(context, 404, error.message);
  }
  if (error instanceof ContentionError) {
    // Transient capacity signal, not a server fault — the Retry-After header
    // tells a well-behaved client to retry.
    const response = buildProblemJSON(context, 503, error.message);
    response.headers.set('Retry-After', String(RETRY_AFTER_SECONDS));
    return response;
  }
  if (error instanceof HTTPException) {
    const status = error.status as ProblemStatus;
    const detail = HTTP_EXCEPTION_DETAILS[status];
    if (detail !== undefined) {
      return buildProblemJSON(context, status, detail);
    }
    // An HTTPException with a status we don't explicitly own: log it (its
    // message may carry framework-internal vocabulary) and return a generic
    // problem rather than leaking the raw message to the client.
    context.var.logger.error({ err: error }, 'unmapped HTTPException in request');
    return buildProblemJSON(context, status, 'The request could not be processed.');
  }
  // Unexpected: log with the pino err serializer (stack + cause) and return an
  // opaque 500. The requestId in the body lets us find the matching log entry.
  context.var.logger.error({ err: error }, 'unhandled error in request');
  return buildProblemJSON(
    context,
    500,
    'An unexpected error occurred; the requestId can be used to correlate with server logs.',
  );
};

// The version's terminal catch-all: an unmatched path answers a Problem Details
// 404, not Hono's text/plain default.
export function notFoundResponse(context: APIContext): Response {
  return buildProblemJSON(context, 404, 'No resource exists at this path.');
}

// A known path with an unsupported method answers 405 with an Allow header, as
// a Problem Details like every other 4xx.
export function methodNotAllowedResponse(context: APIContext, allowedMethods: string[]): Response {
  const response = buildProblemJSON(
    context,
    405,
    'This method is not allowed at this path; the Allow header lists the allowed methods.',
  );
  response.headers.set('Allow', allowedMethods.join(', '));
  return response;
}

// OpenAPI response descriptor reusable across endpoints. Use as:
//   responses: { 404: problemResponse('Subject not found'), 409: problemResponse(...) }
export function problemResponse(description: string) {
  return {
    description,
    content: {
      [PROBLEM_CONTENT_TYPE]: { schema: ProblemDetailsSchema },
    },
  };
}

// Single Problem Details builder: the shape, the title derived from the status
// and the Content-Type header, so no response can drift from the contract.
function buildProblemJSON(
  context: APIContext,
  status: ProblemStatus,
  detail: string,
  options: { title?: string; errors?: ProblemDetails['errors'] } = {},
): Response {
  const body: ProblemDetails = {
    type: 'about:blank',
    title: options.title ?? PROBLEM_TITLES[status] ?? FALLBACK_TITLE,
    status,
    detail,
    requestId: context.var.requestId,
    ...(options.errors !== undefined ? { errors: options.errors } : {}),
  };
  return context.json(body, status, { 'Content-Type': PROBLEM_CONTENT_TYPE });
}
