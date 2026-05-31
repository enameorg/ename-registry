import { createRoute, type RouteHandler, z } from '@hono/zod-openapi';

import {
  MAX_NAME_PART_LENGTH,
  MAX_NUMBER_PART,
  NAME_PART_REGEX,
} from '../../services/ename/index.ts';
import { addEnameToSubject, type AddEnameToSubjectResult } from '../../services/subject/index.ts';
import { UUIDV7_REGEX } from '../../uuid.ts';
import type { HonoEnv } from '../context.ts';
import { problemResponse } from '../problem.ts';

// ---------------------------------------------------------------------------
// Request and response schemas
// ---------------------------------------------------------------------------

const AddEnameToSubjectParamsSchema = z
  .object({
    id: z
      .string()
      .regex(UUIDV7_REGEX, { message: 'must be a UUIDv7' })
      .openapi({ example: '01927e8f-9b2a-7c3d-8e4f-5a6b7c8d9e0f' }),
  })
  .openapi('AddEnameToSubjectParams');

const AddEnameToSubjectRequestSchema = z
  .object({
    idempotencyKey: z
      .string()
      .regex(UUIDV7_REGEX, { message: 'must be a UUIDv7' })
      .openapi({ example: '01927e8f-9b2a-7c3d-8e4f-5a6b7c8d9e0f' }),
    ename: z
      .object({
        namePart: z
          .string()
          .min(1)
          .max(MAX_NAME_PART_LENGTH)
          .regex(NAME_PART_REGEX, {
            message:
              'must be lowercase letters separated by single hyphens (no leading, trailing or consecutive hyphens)',
          })
          .openapi({ example: 'marie-curie' }),
      })
      .openapi('AddEnameToSubjectRequestEname'),
  })
  .openapi('AddEnameToSubjectRequest');

const AddEnameToSubjectResponseSchema = z
  .object({
    createdAt: z.iso.datetime().openapi({ example: '2026-05-30T14:32:11.123Z' }),
    subject: z
      .object({
        id: z
          .string()
          .regex(UUIDV7_REGEX)
          .openapi({ example: '01927e8f-9b2a-7c3d-8e4f-5a6b7c8d9e0f' }),
      })
      .openapi('AddEnameToSubjectResponseSubject'),
    ename: z
      .object({
        id: z
          .string()
          .regex(UUIDV7_REGEX)
          .openapi({ example: '01927e8f-9b2a-7c3d-8e4f-5a6b7c8d9e10' }),
        namePart: z.string().openapi({ example: 'marie-curie' }),
        numberPart: z.number().int().min(1).max(MAX_NUMBER_PART).openapi({ example: 2 }),
      })
      .openapi('AddEnameToSubjectResponseEname'),
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
    400: problemResponse('Request body could not be read properly'),
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
