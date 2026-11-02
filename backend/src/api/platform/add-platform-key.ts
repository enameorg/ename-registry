import { createRoute, type RouteHandler, z } from '@hono/zod-openapi';

import {
  addPlatformKey,
  platformKeyAddedEventKindDefinition,
} from '../../services/platform/index.ts';
import { DateTimeSchema } from '../../utilities/date-time.ts';
import { UUIDv7Schema } from '../../utilities/uuid.ts';
import { KeyInputSchema, KeySchema, SignatureSchema } from '../common/index.ts';
import type { HonoEnv } from '../context.ts';
import {
  conflictProblemResponses,
  gateProblemResponses,
  problemResponse,
  signatureProblemResponses,
} from '../errors.ts';

import { PlatformReferenceSchema } from './platform.ts';

// ---------------------------------------------------------------------------
// Request and response schemas
// ---------------------------------------------------------------------------

const AddPlatformKeyParamsSchema = z.strictObject({
  id: UUIDv7Schema.openapi({ example: '01927e8f-9b2a-7c3d-8e4f-5a6b7c8d9e3b' }),
});

// Strict at every level: an unknown field is a 422 naming the key, never
// silently dropped, so the validated request is exactly what the client sent
// (cf. ename-internals.md).
const AddPlatformKeyRequestSchema = z
  .strictObject({
    idempotencyKey: UUIDv7Schema.openapi({ example: '01927e8f-9b2a-7c3d-8e4f-5a6b7c8d9e0f' }),
    signature: SignatureSchema,
    key: KeyInputSchema,
  })
  .openapi('AddPlatformKeyRequest');

// The platform is named, not returned in full: the response mirrors the
// event, whose request carries the platform's id alone.
export const AddPlatformKeyResponseSchema = z
  .object({
    createdAt: DateTimeSchema.openapi({ example: '2026-10-30T09:12:44.512Z' }),
    platform: PlatformReferenceSchema,
    key: KeySchema,
  })
  .openapi('AddPlatformKeyResponse');

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

export const addPlatformKeyRoute = createRoute({
  method: 'post',
  path: '/platforms/{id}/keys',
  operationId: 'addPlatformKey',
  summary: 'Add a key to an accredited platform',
  description:
    'Adds one public key to an accredited platform, beside the keys it already has. ' +
    'The body must be signed by a key of the registry. ' +
    'Emits one `platform.key-added` event in the registry log. ' +
    'Idempotent via `idempotencyKey`: retrying with the same key returns the original result; ' +
    'reusing the same key for a different request, or under another signing key, returns `409 Conflict`.',
  'x-ename-operation': platformKeyAddedEventKindDefinition.operation,
  request: {
    params: AddPlatformKeyParamsSchema,
    body: {
      required: true,
      content: {
        'application/json': { schema: AddPlatformKeyRequestSchema },
      },
    },
  },
  responses: {
    201: {
      description: 'Key added to the platform (or idempotent replay of a prior success)',
      content: {
        'application/json': { schema: AddPlatformKeyResponseSchema },
      },
    },
    ...gateProblemResponses,
    ...signatureProblemResponses,
    ...conflictProblemResponses,
    404: problemResponse('Platform not found'),
    422: problemResponse('Path parameter or request body failed validation'),
    500: problemResponse('Unexpected error'),
  },
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const addPlatformKeyHandler: RouteHandler<typeof addPlatformKeyRoute, HonoEnv> = async (
  context,
) => {
  const { id } = context.req.valid('param');
  const body = context.req.valid('json');
  const logger = context.var.logger;

  const key = await addPlatformKey(
    {
      idempotencyKey: body.idempotencyKey,
      signature: body.signature,
      platform: { id },
      key: body.key,
    },
    { logger },
  );
  // Field by field, never a spread. The platform is named by the path's id: a
  // replay matched the stored request, which carries the same id.
  return context.json(
    {
      createdAt: key.createdAt.toISOString(),
      platform: { id },
      key: { id: key.id, algorithm: key.algorithm, value: key.value },
    },
    201,
  );
};
