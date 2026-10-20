import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';

import { OpenAPIHono } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { pino } from 'pino';

import { ContentionError } from '../services/errors.ts';
import { UUIDV7_REGEX } from '../utilities/uuid.ts';

import type { HonoEnv } from './context.ts';
import { handleError } from './errors.ts';
import { requestContext } from './middleware.ts';

// The branches of handleError no v1 route reaches on purpose: an unexpected
// error (the opaque 500), a framework HTTPException whose status the mapping
// does not own, and the contention 503 that a real burst reaches only by
// chance (cf. services/subject/register-subject.test.ts). A throwaway sub-app wired
// like the v1 sub-app (request context, then handleError) throws them on
// demand, so the test observes the same function the real app runs, through
// the same HTTP surface. What handleError writes to the request's logger is
// part of that surface: the sub-app swaps the request's logger for a child of
// a capturing one right after requestContext binds it, so the lines a test
// reads are the ones a request would emit. Test doctrine: ename-internals.md.
const ORIGIN = 'http://localhost';

type LogLine = { msg: string; requestId: string; err?: { message: string } } & Record<
  string,
  unknown
>;
const logLines: LogLine[] = [];
const capturingLogger = pino(
  { level: 'error' },
  {
    write(line: string) {
      logLines.push(JSON.parse(line) as LogLine);
    },
  },
);

const throwing = new OpenAPIHono<HonoEnv>();
throwing.use('*', requestContext);
throwing.use('*', async (context, next) => {
  context.set('logger', capturingLogger.child({ requestId: context.var.requestId }));
  await next();
});
throwing.get('/unexpected', () => {
  throw new Error('database password is hunter2');
});
throwing.get('/teapot', () => {
  throw new HTTPException(418, { message: 'framework-internal wording' });
});
throwing.get('/contended', () => {
  throw new ContentionError('Too many concurrent ename creations right now.');
});
throwing.onError(handleError);

type Problem = { type: string; title: string; status: number; detail: string; requestId: string };

beforeEach(() => {
  logLines.length = 0;
});

test('an unexpected error answers an opaque 500 problem+json carrying the request id, and logs the error under that id', async () => {
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

  // The correlation the detail promises: one error line, under the request id,
  // carrying the message the client never sees.
  assert.deepEqual(
    logLines.map((line) => ({
      msg: line.msg,
      requestId: line.requestId,
      errorMessage: line.err?.message,
    })),
    [
      {
        msg: 'unhandled error in request',
        requestId: body.requestId,
        errorMessage: 'database password is hunter2',
      },
    ],
  );
});

test('an HTTPException with a status the mapping does not own keeps its status, hides its message, and logs it', async () => {
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

  assert.deepEqual(
    logLines.map((line) => ({
      msg: line.msg,
      requestId: line.requestId,
      errorMessage: line.err?.message,
    })),
    [
      {
        msg: 'unmapped HTTPException in request',
        requestId: body.requestId,
        errorMessage: 'framework-internal wording',
      },
    ],
  );
});

test('a ContentionError answers a 503 problem+json with a Retry-After header, without an error log', async () => {
  const response = await throwing.fetch(new Request(`${ORIGIN}/contended`));

  assert.equal(response.status, 503);
  assert.match(response.headers.get('Content-Type') ?? '', /^application\/problem\+json/);
  const retryAfter = response.headers.get('Retry-After');
  assert.ok(retryAfter, 'a 503 must carry a Retry-After header');
  assert.ok(Number.isInteger(Number(retryAfter)) && Number(retryAfter) >= 1);

  const body = (await response.json()) as Problem;
  assert.deepEqual(body, {
    type: 'about:blank',
    title: 'Service temporarily unavailable',
    status: 503,
    detail: 'Too many concurrent ename creations right now.',
    requestId: response.headers.get('X-Request-Id'),
  });

  // A transient capacity signal, not a server fault: nothing at error level.
  assert.deepEqual(logLines, []);
});
