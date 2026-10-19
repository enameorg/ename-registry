import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { OpenAPIHono } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';

import { UUIDV7_REGEX } from '../utilities/uuid.ts';

import type { HonoEnv } from './context.ts';
import { handleError } from './errors.ts';
import { requestContext } from './middleware.ts';

// The two branches of handleError no v1 route can reach on purpose: an
// unexpected error (the opaque 500) and a framework HTTPException whose status
// the mapping does not own. A throwaway sub-app wired exactly like the v1
// sub-app (request context, then handleError) throws them on demand, so the
// test observes the same function the real app runs, through the same HTTP
// surface. Test doctrine: ename-internals.md.
const ORIGIN = 'http://localhost';

const throwing = new OpenAPIHono<HonoEnv>();
throwing.use('*', requestContext);
throwing.get('/unexpected', () => {
  throw new Error('database password is hunter2');
});
throwing.get('/teapot', () => {
  throw new HTTPException(418, { message: 'framework-internal wording' });
});
throwing.onError(handleError);

type Problem = { type: string; title: string; status: number; detail: string; requestId: string };

test('an unexpected error answers an opaque 500 problem+json carrying the request id', async () => {
  const response = await throwing.fetch(new Request(`${ORIGIN}/unexpected`));

  assert.equal(response.status, 500);
  assert.match(response.headers.get('Content-Type') ?? '', /^application\/problem\+json/);
  assert.match(response.headers.get('X-Request-Id') ?? '', UUIDV7_REGEX);

  const body = (await response.json()) as Problem;
  assert.deepEqual(body, {
    type: 'about:blank',
    title: 'Internal server error',
    status: 500,
    detail:
      'An unexpected error occurred; the requestId can be used to correlate with server logs.',
    requestId: response.headers.get('X-Request-Id'),
  });
});

test('an HTTPException with a status the mapping does not own keeps its status and hides its message', async () => {
  const response = await throwing.fetch(new Request(`${ORIGIN}/teapot`));

  assert.equal(response.status, 418);
  assert.match(response.headers.get('Content-Type') ?? '', /^application\/problem\+json/);

  const body = (await response.json()) as Problem;
  assert.deepEqual(body, {
    type: 'about:blank',
    title: 'Request error',
    status: 418,
    detail: 'The request could not be processed.',
    requestId: response.headers.get('X-Request-Id'),
  });
});
