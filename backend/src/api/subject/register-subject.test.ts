import { strict as assert } from 'node:assert';
import { test } from 'node:test';

// API tests assert the HTTP contract only — status codes, headers, response
// shape, Problem Details. Persistence invariants live in
// services/subject/register-subject.test.ts. useTestDb is the only
// ../../database import; no raw pool access here. Test doctrine: ename-internals.md.
import { useTestDb } from '../../database/testing.ts';
import { app } from '../../index.ts';
import { generateUUIDv7, UUIDV7_REGEX } from '../../utilities/uuid.ts';
import { TEST_ORIGIN, postJSON, readJSON, readProblem } from '../testing.ts';

import { RegisterSubjectResponseSchema } from './register-subject.ts';

const PATH = '/api/v1/subjects';

useTestDb();

// Build a valid nested body; each call overrides only what it asserts on.
function makeBody(overrides: {
  idempotencyKey?: string;
  kind?: string;
  namePart?: string;
}): Record<string, unknown> {
  return {
    idempotencyKey: overrides.idempotencyKey ?? generateUUIDv7(),
    subject: { kind: overrides.kind ?? 'person' },
    ename: { namePart: overrides.namePart ?? 'jean-dupont' },
  };
}

// ---------------------------------------------------------------------------
// Happy path + idempotency (HTTP contract — persistence is covered in services)
// ---------------------------------------------------------------------------

test('happy path: returns 201 with the created subject and ename', async () => {
  const response = await postJSON(PATH, makeBody({ namePart: 'jean-dupont' }));

  assert.equal(response.status, 201);
  assert.ok(response.headers.get('X-Request-Id'));

  const body = await readJSON(response, RegisterSubjectResponseSchema);
  assert.equal(body.subject.kind, 'person');
  assert.equal(body.ename.namePart, 'jean-dupont');
  assert.equal(body.ename.numberPart, 1);
});

test('two sequential POSTs with the same namePart produce distinct subjects and consecutive numberParts', async () => {
  const namePart = 'marie-curie';

  const firstResponse = await postJSON(PATH, makeBody({ namePart }));
  const secondResponse = await postJSON(PATH, makeBody({ namePart }));

  assert.equal(firstResponse.status, 201);
  assert.equal(secondResponse.status, 201);
  const firstBody = await readJSON(firstResponse, RegisterSubjectResponseSchema);
  const secondBody = await readJSON(secondResponse, RegisterSubjectResponseSchema);

  assert.notEqual(firstBody.subject.id, secondBody.subject.id);
  assert.equal(firstBody.ename.numberPart, 1);
  assert.equal(secondBody.ename.numberPart, 2);
});

test('idempotent replay: same idempotencyKey + same body returns the same response', async () => {
  const idempotencyKey = generateUUIDv7();
  const requestBody = makeBody({ idempotencyKey, namePart: 'albert-einstein' });

  const firstResponse = await postJSON(PATH, requestBody);
  const secondResponse = await postJSON(PATH, requestBody);

  assert.equal(firstResponse.status, 201);
  assert.equal(secondResponse.status, 201);
  const firstBody = await readJSON(firstResponse, RegisterSubjectResponseSchema);
  const secondBody = await readJSON(secondResponse, RegisterSubjectResponseSchema);
  assert.deepEqual(firstBody, secondBody);
});

test('idempotency conflict: same idempotencyKey with a different body returns 409 problem+json', async () => {
  const idempotencyKey = generateUUIDv7();

  const firstResponse = await postJSON(PATH, makeBody({ idempotencyKey, namePart: 'first-name' }));
  assert.equal(firstResponse.status, 201);

  const secondResponse = await postJSON(
    PATH,
    makeBody({ idempotencyKey, namePart: 'different-name' }),
  );
  assert.equal(secondResponse.status, 409);

  const body = await readProblem(secondResponse);
  assert.equal(body.type, 'about:blank');
  assert.equal(body.status, 409);
  assert.equal(body.title, 'Idempotency conflict');
  assert.equal(body.detail, 'This idempotency key has already been used with a different request.');
});

// ---------------------------------------------------------------------------
// Malformed request body (not valid JSON → 400, before Zod validation)
// ---------------------------------------------------------------------------

test('malformed JSON body returns 400 problem+json, not 500', async () => {
  const response = await app.fetch(
    new Request(`${TEST_ORIGIN}${PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'hey',
    }),
  );

  assert.equal(response.status, 400);

  const body = await readProblem(response);
  assert.equal(body.type, 'about:blank');
  assert.equal(body.status, 400);
  assert.equal(body.title, 'Bad request');
  // detail is our own phrasing, not Hono's internal "Malformed JSON…" message —
  // the public contract must not leak the framework's wording.
  assert.equal(body.detail, 'The request body is not valid JSON.');
});

test('non-JSON Content-Type returns 415 problem+json, not 500', async () => {
  const response = await app.fetch(
    new Request(`${TEST_ORIGIN}${PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(makeBody({})),
    }),
  );

  assert.equal(response.status, 415);

  const body = await readProblem(response);
  assert.equal(body.type, 'about:blank');
  assert.equal(body.status, 415);
  assert.equal(body.title, 'Unsupported media type');
  // Our own phrasing, not the framework's "Unsupported Media Type" message.
  assert.equal(body.detail, 'The request body must be sent as application/json.');
});

test('Content-Type with a charset parameter is still accepted (201)', async () => {
  const response = await app.fetch(
    new Request(`${TEST_ORIGIN}${PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(makeBody({})),
    }),
  );

  assert.equal(response.status, 201);
});

// ---------------------------------------------------------------------------
// Zod validation failures (all → 422 problem+json)
// ---------------------------------------------------------------------------

// Each scenario carries the path the Problem Details `errors[]` must surface,
// so a regression that points the client at the wrong field (e.g. reports
// `idempotencyKey` when `namePart` is at fault) fails the test loudly.
for (const scenario of [
  {
    name: 'missing ename object entirely',
    body: { idempotencyKey: generateUUIDv7(), subject: { kind: 'person' } },
    expectedPath: ['ename'],
  },
  {
    name: 'missing namePart inside ename object',
    body: { idempotencyKey: generateUUIDv7(), subject: { kind: 'person' }, ename: {} },
    expectedPath: ['ename', 'namePart'],
  },
  {
    name: 'missing subject object entirely',
    body: { idempotencyKey: generateUUIDv7(), ename: { namePart: 'jean' } },
    expectedPath: ['subject'],
  },
  {
    name: 'namePart contains uppercase',
    body: makeBody({ namePart: 'Jean-Dupont' }),
    expectedPath: ['ename', 'namePart'],
  },
  {
    name: 'namePart contains digit',
    body: makeBody({ namePart: 'jean42' }),
    expectedPath: ['ename', 'namePart'],
  },
  {
    name: 'namePart has leading hyphen',
    body: makeBody({ namePart: '-jean' }),
    expectedPath: ['ename', 'namePart'],
  },
  {
    name: 'namePart has trailing hyphen',
    body: makeBody({ namePart: 'jean-' }),
    expectedPath: ['ename', 'namePart'],
  },
  {
    name: 'namePart has consecutive hyphens',
    body: makeBody({ namePart: 'jean--dupont' }),
    expectedPath: ['ename', 'namePart'],
  },
  {
    name: 'namePart longer than 50 chars',
    body: makeBody({ namePart: 'a'.repeat(51) }),
    expectedPath: ['ename', 'namePart'],
  },
  {
    name: 'kind is not "person"',
    body: makeBody({ kind: 'organization' }),
    expectedPath: ['subject', 'kind'],
  },
  {
    name: 'idempotencyKey is a UUIDv4 (not v7)',
    body: makeBody({ idempotencyKey: '550e8400-e29b-41d4-a716-446655440000' }),
    expectedPath: ['idempotencyKey'],
  },
  {
    name: 'idempotencyKey is not a UUID',
    body: makeBody({ idempotencyKey: 'not-a-uuid' }),
    expectedPath: ['idempotencyKey'],
  },
]) {
  test(`validation failure: ${scenario.name} → 422 problem+json`, async () => {
    const response = await postJSON(PATH, scenario.body);
    assert.equal(response.status, 422);

    const body = await readProblem(response);
    assert.equal(body.type, 'about:blank');
    assert.equal(body.status, 422);
    assert.equal(body.title, 'Validation failed');
    // At least one issue must point at the expected path — proves the error
    // is attributed to the correct field, not just "an error occurred".
    assert.ok(
      body.errors?.some(
        (issue) =>
          issue.path.length >= scenario.expectedPath.length &&
          scenario.expectedPath.every((segment, index) => issue.path[index] === segment),
      ),
      `expected at least one error with path starting with [${scenario.expectedPath.join(', ')}], got ${JSON.stringify(body.errors)}`,
    );
  });
}

// Strict input: an unknown field is a 422 whose issue names the key and points
// at the object holding it, never a silent drop (cf. ename-internals.md).
for (const scenario of [
  {
    name: 'unknown top-level field',
    body: { ...makeBody({}), extra: 1 },
    key: 'extra',
    expectedPath: [],
  },
  {
    name: 'unknown field inside subject object',
    body: { ...makeBody({}), subject: { kind: 'person', hidden: true } },
    key: 'hidden',
    expectedPath: ['subject'],
  },
]) {
  test(`validation failure: ${scenario.name} → 422 naming the key`, async () => {
    const response = await postJSON(PATH, scenario.body);

    assert.equal(response.status, 422);

    const body = await readProblem(response);
    const issue = body.errors?.find((candidate) => candidate.message.includes(`"${scenario.key}"`));
    assert.ok(
      issue,
      `expected an issue naming "${scenario.key}", got ${JSON.stringify(body.errors)}`,
    );
    assert.deepEqual(issue.path, scenario.expectedPath);
  });
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

test('X-Request-Id is a UUIDv7 and present on success responses', async () => {
  const response = await postJSON(PATH, makeBody({ namePart: 'h-test' }));
  assert.equal(response.status, 201);
  const requestId = response.headers.get('X-Request-Id');
  assert.ok(requestId);
  assert.match(requestId, UUIDV7_REGEX);
});

test('X-Request-Id is also present on validation error responses', async () => {
  const response = await postJSON(PATH, makeBody({ idempotencyKey: 'bad', namePart: 'h-test' }));
  assert.equal(response.status, 422);
  assert.ok(response.headers.get('X-Request-Id'));
  // readProblem checks that the same id appears in the body (per RFC 9457 + our
  // extension).
  await readProblem(response);
});
