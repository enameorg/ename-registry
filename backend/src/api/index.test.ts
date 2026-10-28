import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { useTestDB } from '../database/testing.ts';
import { app } from '../index.ts';

import { MAX_BODY_BYTES } from './middleware.ts';
import { TEST_ORIGIN, readProblem } from './testing.ts';

// Contract of the v1 gates and fallbacks: under the version prefix, an oversized
// body, an unmatched path or an unsupported method answers a Problem Details
// carrying a request id, never Hono's text/plain defaults. Test doctrine:
// ename-internals.md.

useTestDB();

// ---------------------------------------------------------------------------
// Unmatched path (404 catch-all)
// ---------------------------------------------------------------------------

for (const path of ['/api/v1/unknown', '/api/v1', '/api/v1/']) {
  test(`GET ${path} (no such path) returns 404 problem+json with a request id`, async () => {
    const response = await app.fetch(new Request(`${TEST_ORIGIN}${path}`));

    assert.equal(response.status, 404);

    const body = await readProblem(response);
    assert.equal(body.type, 'about:blank');
    assert.equal(body.status, 404);
    assert.equal(body.title, 'Not found');
  });
}

// Hono serves HEAD through the GET handler; the catch-all must not swallow it.
test('HEAD /api/v1/health still reaches the GET handler (200)', async () => {
  const response = await app.fetch(new Request(`${TEST_ORIGIN}/api/v1/health`, { method: 'HEAD' }));

  assert.equal(response.status, 200);
});

// ---------------------------------------------------------------------------
// Unsupported method (405 with Allow)
// ---------------------------------------------------------------------------

for (const scenario of [
  { method: 'GET', path: '/api/v1/subjects', allow: 'POST' },
  { method: 'DELETE', path: '/api/v1/health', allow: 'GET, HEAD' },
]) {
  test(`${scenario.method} ${scenario.path} (known path, wrong method) returns 405 problem+json with Allow`, async () => {
    const response = await app.fetch(
      new Request(`${TEST_ORIGIN}${scenario.path}`, { method: scenario.method }),
    );

    assert.equal(response.status, 405);
    assert.equal(response.headers.get('Allow'), scenario.allow);

    const body = await readProblem(response);
    assert.equal(body.status, 405);
    assert.equal(body.title, 'Method not allowed');
  });
}

// ---------------------------------------------------------------------------
// Body size limit
// ---------------------------------------------------------------------------

async function postSubjects(init: RequestInit): Promise<Response> {
  return await app.fetch(
    new Request(`${TEST_ORIGIN}/api/v1/subjects`, { method: 'POST', ...init }),
  );
}

test('an announced oversized body is refused on Content-Length alone, without being read', async () => {
  // highWaterMark 0: the stream never pre-fills its queue, so pull() only runs
  // when something actually reads the body.
  let pulled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulled = true;
        controller.enqueue(new Uint8Array(1024));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const response = await postSubjects({
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(MAX_BODY_BYTES + 1) },
    body,
    duplex: 'half',
  });

  assert.equal(response.status, 413);
  assert.equal(pulled, false);

  const problem = await readProblem(response);
  assert.equal(problem.type, 'about:blank');
  assert.equal(problem.status, 413);
  assert.equal(problem.title, 'Content too large');
  assert.equal(problem.detail, `The request body must not exceed ${MAX_BODY_BYTES} bytes.`);
});

test('an unannounced oversized body (no Content-Length) is cut at the limit (413)', async () => {
  const response = await postSubjects({
    headers: { 'Content-Type': 'application/json' },
    body: 'x'.repeat(MAX_BODY_BYTES + 1),
  });

  assert.equal(response.status, 413);
  await readProblem(response);
});

test('a body exactly at the limit passes the gate and reaches the JSON validator (400)', async () => {
  const response = await postSubjects({
    headers: { 'Content-Type': 'application/json' },
    body: 'x'.repeat(MAX_BODY_BYTES),
  });

  assert.equal(response.status, 400);
});

// ---------------------------------------------------------------------------
// OpenAPI document
// ---------------------------------------------------------------------------

// The committed file and the runtime endpoint are two representations of the
// same generator call (cf. ename-internals.md); any drift means openapi.json
// was not regenerated after a route change.
test('GET /api/v1/openapi.json is byte-identical to the committed backend/openapi.json', async () => {
  const committed = await readFile(new URL('../../openapi.json', import.meta.url), 'utf-8');
  const response = await app.fetch(new Request(`${TEST_ORIGIN}/api/v1/openapi.json`));

  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type') ?? '', /^application\/json/);
  assert.equal(await response.text(), committed);

  const document = JSON.parse(committed) as { servers: unknown; paths: Record<string, unknown> };
  assert.deepEqual(document.servers, [{ url: '/api/v1' }]);
  assert.ok('/health' in document.paths);
});

// One OpenAPI component per wire shape, whatever route produces it, so an SDK
// generator emits one type per concept (cf. ename-internals.md). The name list
// is the contract: a new route adds its own envelopes here, never a second
// `Subject` or `Ename`.
test('the v1 components name each wire shape once, shared across the write routes', async () => {
  const response = await app.fetch(new Request(`${TEST_ORIGIN}/api/v1/openapi.json`));
  const document = (await response.json()) as {
    components: { schemas: Record<string, { properties: Record<string, { $ref?: string }> }> };
  };
  const schemas = document.components.schemas;

  assert.deepEqual(Object.keys(schemas).sort(), [
    'AddEnameToSubjectRequest',
    'AddEnameToSubjectResponse',
    'Ename',
    'EnameInput',
    'HealthResponse',
    'ProblemDetails',
    'RegisterSubjectRequest',
    'RegisterSubjectResponse',
    'Subject',
    'SubjectInput',
    'SubjectReference',
  ]);

  // Both write routes submit the same `ename` object and return the same ename;
  // registration returns the full subject, adding an ename only names it.
  const reference = (component: string, property: string) =>
    schemas[component]?.properties[property]?.$ref;
  assert.equal(reference('RegisterSubjectRequest', 'subject'), '#/components/schemas/SubjectInput');
  assert.equal(reference('RegisterSubjectRequest', 'ename'), '#/components/schemas/EnameInput');
  assert.equal(reference('AddEnameToSubjectRequest', 'ename'), '#/components/schemas/EnameInput');
  assert.equal(reference('RegisterSubjectResponse', 'subject'), '#/components/schemas/Subject');
  assert.equal(reference('RegisterSubjectResponse', 'ename'), '#/components/schemas/Ename');
  assert.equal(
    reference('AddEnameToSubjectResponse', 'subject'),
    '#/components/schemas/SubjectReference',
  );
  assert.equal(reference('AddEnameToSubjectResponse', 'ename'), '#/components/schemas/Ename');
});
