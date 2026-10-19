import { createRoute, type RouteHandler, z } from '@hono/zod-openapi';

import { registerSubject, type RegisterSubjectResult } from '../../services/subject/index.ts';
import { DateTimeSchema } from '../../utilities/date-time.ts';
import { UUIDv7Schema } from '../../utilities/uuid.ts';
import type { HonoEnv } from '../context.ts';
import { gateProblemResponses, problemResponse } from '../errors.ts';

import { EnameInputSchema, EnameSchema } from './ename.ts';
import { SubjectInputSchema, SubjectSchema } from './subject.ts';

// ---------------------------------------------------------------------------
// Request and response schemas
// ---------------------------------------------------------------------------

// Strict at every level: an unknown field is a 422 naming the key, never
// silently dropped, so the validated request is exactly what the client sent
// (cf. ename-internals.md). The entity blocks are the shared wire components.
const RegisterSubjectRequestSchema = z
  .strictObject({
    idempotencyKey: UUIDv7Schema.openapi({ example: '01927e8f-9b2a-7c3d-8e4f-5a6b7c8d9e0f' }),
    subject: SubjectInputSchema,
    ename: EnameInputSchema,
  })
  .openapi('RegisterSubjectRequest');

const RegisterSubjectResponseSchema = z
  .object({
    createdAt: DateTimeSchema.openapi({ example: '2026-05-27T14:32:11.123Z' }),
    subject: SubjectSchema,
    ename: EnameSchema,
  })
  .openapi('RegisterSubjectResponse');

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

export const registerSubjectRoute = createRoute({
  method: 'post',
  path: '/subjects',
  summary: 'Register a new subject (with its first ename)',
  description:
    'Atomically registers a new subject (of `kind = person` in v1) together with its first ename. ' +
    'A subject without at least one ename has no meaning in the registry — the two are created together. ' +
    'Emits one `subject.registered` event in the registry log. ' +
    'Idempotent via `idempotencyKey`: retrying with the same key returns the original result; ' +
    'reusing the same key with a different body returns `409 Conflict`.',
  request: {
    body: {
      required: true,
      content: {
        'application/json': { schema: RegisterSubjectRequestSchema },
      },
    },
  },
  responses: {
    201: {
      description: 'Subject and first ename registered (or idempotent replay of a prior success)',
      content: {
        'application/json': { schema: RegisterSubjectResponseSchema },
      },
    },
    ...gateProblemResponses,
    409: problemResponse('Idempotency key already used for a different operation'),
    422: problemResponse('Request body failed validation'),
    500: problemResponse('Unexpected error'),
    503: problemResponse(
      'Too many concurrent ename creations for this name; transient — retry after the delay in the Retry-After header',
    ),
  },
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const registerSubjectHandler: RouteHandler<typeof registerSubjectRoute, HonoEnv> = async (
  context,
) => {
  const input = context.req.valid('json');
  const logger = context.var.logger;

  const result = await registerSubject(input, { logger });
  return context.json(resultToResponse(result), 201);
};

function resultToResponse(result: RegisterSubjectResult) {
  return {
    createdAt: result.createdAt.toISOString(),
    subject: { id: result.subject.id, kind: result.subject.kind },
    ename: {
      id: result.ename.id,
      namePart: result.ename.namePart,
      numberPart: result.ename.numberPart,
    },
  };
}
