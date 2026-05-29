import { z } from '@hono/zod-openapi';

import { UUIDV7_REGEX } from '../uuid.ts';

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
    requestId: z
      .string()
      .regex(UUIDV7_REGEX)
      .openapi({ example: '01927e8f-9b2a-7c3d-8e4f-5a6b7c8d9e0f' }),
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
