import { createRoute, type RouteHandler, z } from '@hono/zod-openapi';

import {
  accreditPlatform,
  platformAccreditedEventKindDefinition,
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
  unavailableProblemResponses,
} from '../errors.ts';

import { PlatformInputSchema, PlatformSchema } from './platform.ts';

// ---------------------------------------------------------------------------
// Request and response schemas
// ---------------------------------------------------------------------------

// Strict at every level: an unknown field is a 422 naming the key, never silently dropped, so the
// validated request is exactly what the client sent (cf. ename-internals.md).
const AccreditPlatformRequestSchema = z
  .strictObject({
    idempotencyKey: UUIDv7Schema.openapi({ example: '01927e8f-9b2a-7c3d-8e4f-5a6b7c8d9e0f' }),
    signature: SignatureSchema,
    platform: PlatformInputSchema,
    key: KeyInputSchema,
  })
  .openapi('AccreditPlatformRequest');

export const AccreditPlatformResponseSchema = z
  .object({
    createdAt: DateTimeSchema.openapi({ example: '2026-10-30T09:12:44.512Z' }),
    platform: PlatformSchema,
    key: KeySchema,
  })
  .openapi('AccreditPlatformResponse');

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

export const accreditPlatformRoute = createRoute({
  method: 'post',
  path: '/platforms',
  operationId: 'accreditPlatform',
  summary: 'Accredit a platform (with its first key)',
  description:
    'Records the accreditation of a platform, identified by its legal entity, together with its first public key. ' +
    'The body must be signed by a key of the registry. ' +
    'Emits one `platform.accredited` event in the registry log. ' +
    'A legal entity holds one platform at a time; accrediting the same registration twice returns `409 Conflict`. ' +
    'Idempotent via `idempotencyKey`: retrying with the same key returns the original result; ' +
    'reusing the same key for a different request, or under another signing key, returns `409 Conflict`.',
  'x-ename-operation': platformAccreditedEventKindDefinition.operation,
  request: {
    body: {
      required: true,
      content: {
        'application/json': { schema: AccreditPlatformRequestSchema },
      },
    },
  },
  responses: {
    201: {
      description: 'Platform accredited (or idempotent replay of a prior success)',
      content: {
        'application/json': { schema: AccreditPlatformResponseSchema },
      },
    },
    ...gateProblemResponses,
    ...signatureProblemResponses,
    ...conflictProblemResponses,
    ...unavailableProblemResponses,
    422: problemResponse('Request body failed validation'),
    500: problemResponse('Unexpected error'),
  },
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const accreditPlatformHandler: RouteHandler<typeof accreditPlatformRoute, HonoEnv> = async (
  context,
) => {
  const input = context.req.valid('json');
  const logger = context.var.logger;

  const { platform, key } = await accreditPlatform(input, { logger });
  // Field by field, never a spread: the wire carries the event's timestamp once, and not the key's
  // platformId, which the platform's id already says.
  return context.json(
    {
      createdAt: platform.createdAt.toISOString(),
      platform: {
        id: platform.id,
        legalName: platform.legalName,
        jurisdiction: platform.jurisdiction,
        registrationAuthorityCode: platform.registrationAuthorityCode,
        registrationIdentifier: platform.registrationIdentifier,
      },
      key: { id: key.id, algorithm: key.algorithm, value: key.value },
    },
    201,
  );
};
