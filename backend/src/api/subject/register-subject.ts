import { createRoute, type RouteHandler, z } from '@hono/zod-openapi';

import {
  MAX_ENAME_LENGTH,
  MAX_NAME_PART_LENGTH,
  MAX_NUMBER_PART,
  NAME_PART_REGEX,
} from '../../services/ename/index.ts';
import { registerSubject, type RegisterSubjectResult } from '../../services/subject/index.ts';
import { UUIDV7_REGEX } from '../../uuid.ts';
import type { HonoEnv } from '../context.ts';
import { problemResponse } from '../problem.ts';

// ---------------------------------------------------------------------------
// Request and response schemas, inline with the route (see ename-internals.md).
// Both are nested by entity block (subject, ename) — same shape as the event's
// request/outcome and the service input/result, so wire body, service
// signature, log entry and HTTP response all read the same way.
//
// The ename-format rules (NAME_PART_REGEX, MAX_NAME_PART_LENGTH,
// MAX_NUMBER_PART) come from the ename service: they describe the domain, and
// any future ename-creating endpoint must agree on the same shape.
// ---------------------------------------------------------------------------

const RegisterSubjectRequestSchema = z
  .object({
    idempotencyKey: z
      .string()
      .regex(UUIDV7_REGEX, { message: 'must be a UUIDv7' })
      .openapi({ example: '01927e8f-9b2a-7c3d-8e4f-5a6b7c8d9e0f' }),
    subject: z
      .object({
        kind: z.literal('person').openapi({ example: 'person' }),
      })
      .openapi('RegisterSubjectRequestSubject'),
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
          .openapi({ example: 'jean-dupont' }),
      })
      .openapi('RegisterSubjectRequestEname'),
  })
  .openapi('RegisterSubjectRequest');

const RegisterSubjectResponseSchema = z
  .object({
    createdAt: z.iso.datetime().openapi({ example: '2026-05-27T14:32:11.123Z' }),
    subject: z
      .object({
        id: z
          .string()
          .regex(UUIDV7_REGEX)
          .openapi({ example: '01927e8f-9b2a-7c3d-8e4f-5a6b7c8d9e0f' }),
        kind: z.literal('person').openapi({ example: 'person' }),
      })
      .openapi('Subject'),
    ename: z
      .object({
        id: z
          .string()
          .regex(UUIDV7_REGEX)
          .openapi({ example: '01927e8f-9b2a-7c3d-8e4f-5a6b7c8d9e10' }),
        namePart: z.string().openapi({ example: 'jean-dupont' }),
        // Upper bound mirrors the DB CHECK (`enames_number_part_range`).
        // Surfaced in OpenAPI so SDK generators document the bound.
        numberPart: z.number().int().min(1).max(MAX_NUMBER_PART).openapi({ example: 1 }),
      })
      .openapi('Ename'),
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
    409: problemResponse('Idempotency key already used for a different operation'),
    422: problemResponse(
      `Request body failed validation, or the resulting ename exceeds ${MAX_ENAME_LENGTH} characters`,
    ),
    500: problemResponse('Unexpected error'),
    503: problemResponse(
      'Too many concurrent registrations for this name; transient — retry after the delay in the Retry-After header',
    ),
  },
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

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

export const registerSubjectHandler: RouteHandler<typeof registerSubjectRoute, HonoEnv> = async (
  context,
) => {
  const input = context.req.valid('json');
  const logger = context.var.logger;

  const result = await registerSubject(input, { logger });
  return context.json(resultToResponse(result), 201);
};
