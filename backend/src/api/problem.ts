import { z } from '@hono/zod-openapi';
import type { ClientErrorStatusCode, ServerErrorStatusCode } from 'hono/utils/http-status';

import { UUIDv7Schema } from '../utilities/uuid.ts';

import type { ApiContext } from './context.ts';

// RFC 9457 Problem Details — the single shape for every 4xx/5xx response, served
// as application/problem+json. Extensions beyond the RFC base: requestId (the
// middleware's id, echoed so a user can quote it) and errors (field-level Zod
// failures). `instance` is omitted in v1 — requestId plays that role.
export const ProblemDetailsSchema = z
  .object({
    type: z.string().openapi({ example: 'about:blank' }),
    title: z.string().openapi({ example: 'Validation failed' }),
    status: z.number().int().openapi({ example: 422 }),
    detail: z.string().openapi({ example: '1 validation error' }),
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

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

// OpenAPI response descriptor reusable across endpoints. Use as:
//   responses: { 422: problemResponse('Validation failed'), 409: problemResponse(...) }
export function problemResponse(description: string) {
  return {
    description,
    content: {
      [PROBLEM_CONTENT_TYPE]: { schema: ProblemDetailsSchema },
    },
  };
}

// Single Problem Details builder. Centralizes the shape and the
// Content-Type header so no handler can drift accidentally. The caller
// (api/index.ts onError) owns the error → status/title mapping.
export function buildProblemJson(
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
