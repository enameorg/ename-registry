import { strict as assert } from 'node:assert';

import type { z } from '@hono/zod-openapi';

import { app } from '../index.ts';

import { type ProblemDetails, ProblemDetailsSchema } from './errors.ts';

// The HTTP side of the API contract tests: the origin every test request
// targets, a JSON POST, and the read of a response through the wire schema that
// declares it. Nothing validates a response at runtime (the framework validates
// requests only), so this read is what fails a test on a body that drifts from
// its published component. Test doctrine: ename-internals.md.

export const TEST_ORIGIN = 'http://localhost';

export async function postJSON(path: string, body: unknown): Promise<Response> {
  return await app.fetch(
    new Request(`${TEST_ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export async function readJSON<Schema extends z.ZodType>(
  response: Response,
  schema: Schema,
): Promise<z.output<Schema>> {
  assert.match(response.headers.get('Content-Type') ?? '', /^application\/json/);
  return await parseBody(response, schema);
}

// Every 4xx/5xx is a Problem Details whose requestId echoes the X-Request-Id
// header (cf. ename-internals.md).
export async function readProblem(response: Response): Promise<ProblemDetails> {
  assert.match(response.headers.get('Content-Type') ?? '', /^application\/problem\+json/);
  const problem = await parseBody(response, ProblemDetailsSchema);
  assert.equal(problem.requestId, response.headers.get('X-Request-Id'));
  return problem;
}

// The wire schemas are not strict, so a parse silently drops a field they do
// not declare, at any depth; comparing the parse with the raw body turns that
// drop into a failure.
async function parseBody<Schema extends z.ZodType>(
  response: Response,
  schema: Schema,
): Promise<z.output<Schema>> {
  const body: unknown = await response.json();
  const parsed = schema.parse(body);
  assert.deepEqual(parsed, body);
  return parsed;
}
