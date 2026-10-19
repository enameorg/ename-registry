import { createRoute, type RouteHandler, z } from '@hono/zod-openapi';

import { addEnameToSubject, type AddEnameToSubjectResult } from '../../services/subject/index.ts';
import { DateTimeSchema } from '../../utilities/date-time.ts';
import { UUIDv7Schema } from '../../utilities/uuid.ts';
import type { HonoEnv } from '../context.ts';
import { gateProblemResponses, problemResponse } from '../errors.ts';

import { EnameInputSchema, EnameSchema } from './ename.ts';
import { SubjectReferenceSchema } from './subject.ts';

// ---------------------------------------------------------------------------
// Request and response schemas
// ---------------------------------------------------------------------------

const AddEnameToSubjectParamsSchema = z
  .object({
    id: UUIDv7Schema.openapi({ example: '01927e8f-9b2a-7c3d-8e4f-5a6b7c8d9e1a' }),
  })
  .openapi('AddEnameToSubjectParams');

// Strict at every level: an unknown field is a 422 naming the key, never
// silently dropped, so the validated request is exactly what the client sent
// (cf. ename-internals.md). The ename block is the shared wire component.
const AddEnameToSubjectRequestSchema = z
  .strictObject({
    idempotencyKey: UUIDv7Schema.openapi({ example: '01927e8f-9b2a-7c3d-8e4f-5a6b7c8d9e0f' }),
    ename: EnameInputSchema,
  })
  .openapi('AddEnameToSubjectRequest');

// The subject is named, not returned in full: the response mirrors the event,
// whose request carries the subject's id alone.
const AddEnameToSubjectResponseSchema = z
  .object({
    createdAt: DateTimeSchema.openapi({ example: '2026-05-30T14:32:11.123Z' }),
    subject: SubjectReferenceSchema,
    ename: EnameSchema,
  })
  .openapi('AddEnameToSubjectResponse');

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

export const addEnameToSubjectRoute = createRoute({
  method: 'post',
  path: '/subjects/{id}/enames',
  summary: 'Add an ename to an existing subject',
  description:
    'Adds one ename to an existing subject without replacing its previous enames. ' +
    'Emits one `subject.ename_added` event in the registry log. ' +
    'A subject cannot hold two enames with the same `namePart`; reusing the same `namePart` for the same subject returns `409 Conflict`. ' +
    'Idempotent via `idempotencyKey`: retrying with the same key returns the original result; ' +
    'reusing the same key with a different path or body returns `409 Conflict`.',
  request: {
    params: AddEnameToSubjectParamsSchema,
    body: {
      required: true,
      content: {
        'application/json': { schema: AddEnameToSubjectRequestSchema },
      },
    },
  },
  responses: {
    201: {
      description: 'Ename added to subject (or idempotent replay of a prior success)',
      content: {
        'application/json': { schema: AddEnameToSubjectResponseSchema },
      },
    },
    ...gateProblemResponses,
    404: problemResponse('Subject not found'),
    409: problemResponse('Idempotency key conflict or subject already has this namePart'),
    422: problemResponse('Path parameter or request body failed validation'),
    500: problemResponse('Unexpected error'),
    503: problemResponse(
      'Too many concurrent ename creations for this name; transient — retry after the delay in the Retry-After header',
    ),
  },
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const addEnameToSubjectHandler: RouteHandler<
  typeof addEnameToSubjectRoute,
  HonoEnv
> = async (context) => {
  const { id } = context.req.valid('param');
  const body = context.req.valid('json');
  const logger = context.var.logger;

  const result = await addEnameToSubject(
    { idempotencyKey: body.idempotencyKey, subject: { id }, ename: body.ename },
    { logger },
  );
  return context.json(resultToResponse(result), 201);
};

function resultToResponse(result: AddEnameToSubjectResult) {
  return {
    createdAt: result.createdAt.toISOString(),
    subject: { id: result.subject.id },
    ename: {
      id: result.ename.id,
      namePart: result.ename.namePart,
      numberPart: result.ename.numberPart,
    },
  };
}
