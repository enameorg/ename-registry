import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { useTestDb } from '../database/testing.ts';
import { app } from '../index.ts';
import { UUIDV7_REGEX } from '../uuid.ts';

// Contract of the v1 fallbacks: under the version prefix, an unmatched path or
// an unsupported method answers a Problem Details carrying a request id, never
// Hono's text/plain defaults. Test doctrine: ename-internals.md.
const ORIGIN = 'http://localhost';

useTestDb();

type Problem = { type: string; title: string; status: number; detail: string; requestId: string };

for (const path of ['/api/v1/unknown', '/api/v1', '/api/v1/']) {
  test(`GET ${path} (no such path) returns 404 problem+json with a request id`, async () => {
    const response = await app.fetch(new Request(`${ORIGIN}${path}`));

    assert.equal(response.status, 404);
    assert.match(response.headers.get('Content-Type') ?? '', /^application\/problem\+json/);
    assert.match(response.headers.get('X-Request-Id') ?? '', UUIDV7_REGEX);

    const body = (await response.json()) as Problem;
    assert.equal(body.type, 'about:blank');
    assert.equal(body.status, 404);
    assert.equal(body.title, 'Not found');
    assert.equal(body.requestId, response.headers.get('X-Request-Id'));
  });
}

for (const scenario of [
  { method: 'GET', path: '/api/v1/subjects', allow: 'POST' },
  { method: 'DELETE', path: '/api/v1/health', allow: 'GET, HEAD' },
]) {
  test(`${scenario.method} ${scenario.path} (known path, wrong method) returns 405 problem+json with Allow`, async () => {
    const response = await app.fetch(
      new Request(`${ORIGIN}${scenario.path}`, { method: scenario.method }),
    );

    assert.equal(response.status, 405);
    assert.equal(response.headers.get('Allow'), scenario.allow);
    assert.match(response.headers.get('Content-Type') ?? '', /^application\/problem\+json/);

    const body = (await response.json()) as Problem;
    assert.equal(body.status, 405);
    assert.equal(body.title, 'Method not allowed');
    assert.match(body.requestId, UUIDV7_REGEX);
  });
}

// Hono serves HEAD through the GET handler; the catch-all must not swallow it.
test('HEAD /api/v1/health still reaches the GET handler (200)', async () => {
  const response = await app.fetch(new Request(`${ORIGIN}/api/v1/health`, { method: 'HEAD' }));

  assert.equal(response.status, 200);
});
