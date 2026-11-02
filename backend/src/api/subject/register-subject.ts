import { createRoute, type RouteHandler, z } from '@hono/zod-openapi';

import {
  registerSubject,
  subjectRegisteredEventKindDefinition,
} from '../../services/subject/index.ts';
import { DateTimeSchema } from '../../utilities/date-time.ts';
import { UUIDv7Schema } from '../../utilities/uuid.ts';
import { SignatureSchema } from '../common/index.ts';
import type { HonoEnv } from '../context.ts';
import {
  conflictProblemResponses,
  contentionProblemResponses,
  gateProblemResponses,
  problemResponse,
  signatureProblemResponses,
} from '../errors.ts';

import { EnameInputSchema, EnameSchema } from './ename.ts';
import { SubjectInputSchema, SubjectSchema } from './subject.ts';

// ---------------------------------------------------------------------------
// Request and response schemas
// ---------------------------------------------------------------------------

// Strict at every level: an unknown field is a 422 naming the key, never
// silently dropped, so the validated request is exactly what the client sent
// (cf. ename-internals.md).
const RegisterSubjectRequestSchema = z
  .strictObject({
    idempotencyKey: UUIDv7Schema.openapi({ example: '01927e8f-9b2a-7c3d-8e4f-5a6b7c8d9e0f' }),
    signature: SignatureSchema,
    subject: SubjectInputSchema,
    ename: EnameInputSchema,
  })
  .openapi('RegisterSubjectRequest');

export const RegisterSubjectResponseSchema = z
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
    'The body must be signed by a key of an accredited platform, which becomes the home platform of the subject. ' +
    'Emits one `subject.registered` event in the registry log. ' +
    'Idempotent via `idempotencyKey`: retrying with the same key returns the original result; ' +
    'reusing the same key for a different request, or under another signing key, returns `409 Conflict`.',
  'x-ename-operation': subjectRegisteredEventKindDefinition.operation,
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
    ...signatureProblemResponses,
    ...conflictProblemResponses,
    ...contentionProblemResponses,
    422: problemResponse('Request body failed validation'),
    500: problemResponse('Unexpected error'),
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

  const { subject, ename } = await registerSubject(input, { logger });
  // Field by field, never a spread: the wire carries the event's timestamp
  // once, not each row's createdAt, and not the ename's subjectId.
  return context.json(
    {
      createdAt: subject.createdAt.toISOString(),
      subject: { id: subject.id, kind: subject.kind },
      ename: { id: ename.id, namePart: ename.namePart, numberPart: ename.numberPart },
    },
    201,
  );
};
