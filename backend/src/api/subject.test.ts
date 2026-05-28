import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';

// API tests assert the HTTP contract only — status codes, headers, response
// shape, Problem Details bodies. They do not inspect persistent state: every
// invariant about what gets written to `subjects`, `enames` or `events` lives
// in `src/services/subject.test.ts`.
//
// `resetTestDb` is the only import from `../database/*`: the service the API
// calls writes to the database, so successive tests would otherwise share
// state. No direct database access (`pool`, `pool.query`) appears anywhere
// in this file.
import { resetTestDb } from '../database/reset-for-tests.ts';
import { app } from '../index.ts';
import { generateUUIDv7, UUIDV7_REGEX } from '../uuid.ts';

const ENDPOINT = 'http://localhost/api/v1/subjects';

beforeEach(async () => {
  await resetTestDb();
});

async function postSubject(body: unknown): Promise<Response> {
  return await app.fetch(
    new Request(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

// Convenience: build a valid nested request body. Each call site can override
// only what it cares about — keeps the test bodies focused on what's being
// asserted, not on boilerplate.
function makeBody(overrides: {
  idempotencyKey?: string;
  kind?: string;
  namePart?: string;
}): unknown {
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
  const response = await postSubject(makeBody({ namePart: 'jean-dupont' }));

  assert.equal(response.status, 201);
  assert.match(response.headers.get('Content-Type') ?? '', /^application\/json/);
  assert.ok(response.headers.get('X-Request-Id'));

  const body = (await response.json()) as {
    createdAt: string;
    subject: { id: string; kind: string };
    ename: { id: string; namePart: string; numberPart: number };
  };

  assert.equal(body.subject.kind, 'person');
  assert.equal(body.ename.namePart, 'jean-dupont');
  assert.equal(body.ename.numberPart, 1);
  assert.match(body.subject.id, UUIDV7_REGEX);
  assert.match(body.ename.id, UUIDV7_REGEX);
  assert.ok(!Number.isNaN(Date.parse(body.createdAt)));
});

test('two sequential POSTs with the same namePart produce distinct subjects and consecutive numberParts', async () => {
  const namePart = 'marie-curie';

  const firstResponse = await postSubject(makeBody({ namePart }));
  const secondResponse = await postSubject(makeBody({ namePart }));

  assert.equal(firstResponse.status, 201);
  assert.equal(secondResponse.status, 201);
  const firstBody = (await firstResponse.json()) as {
    subject: { id: string };
    ename: { numberPart: number };
  };
  const secondBody = (await secondResponse.json()) as {
    subject: { id: string };
    ename: { numberPart: number };
  };

  assert.notEqual(firstBody.subject.id, secondBody.subject.id);
  assert.equal(firstBody.ename.numberPart, 1);
  assert.equal(secondBody.ename.numberPart, 2);
});

test('idempotent replay: same idempotencyKey + same body returns the same response', async () => {
  const idempotencyKey = generateUUIDv7();
  const requestBody = makeBody({ idempotencyKey, namePart: 'albert-einstein' });

  const firstResponse = await postSubject(requestBody);
  const secondResponse = await postSubject(requestBody);

  assert.equal(firstResponse.status, 201);
  assert.equal(secondResponse.status, 201);
  const firstBody = await firstResponse.json();
  const secondBody = await secondResponse.json();
  assert.deepEqual(firstBody, secondBody);
});

test('idempotency conflict: same idempotencyKey with a different body returns 409 problem+json', async () => {
  const idempotencyKey = generateUUIDv7();

  const firstResponse = await postSubject(makeBody({ idempotencyKey, namePart: 'first-name' }));
  assert.equal(firstResponse.status, 201);

  const secondResponse = await postSubject(
    makeBody({ idempotencyKey, namePart: 'different-name' }),
  );
  assert.equal(secondResponse.status, 409);
  assert.match(secondResponse.headers.get('Content-Type') ?? '', /^application\/problem\+json/);

  const body = (await secondResponse.json()) as {
    type: string;
    title: string;
    status: number;
    detail: string;
    requestId: string;
  };
  assert.equal(body.type, 'about:blank');
  assert.equal(body.status, 409);
  assert.equal(body.title, 'Idempotency conflict');
  assert.match(body.detail, /idempotency key/i);
  assert.match(body.requestId, UUIDV7_REGEX);
});

// ---------------------------------------------------------------------------
// Zod validation failures (all → 422 problem+json)
// ---------------------------------------------------------------------------

// Each scenario carries the path the Problem Details `errors[]` must surface,
// so a regression that points the client at the wrong field (e.g. reports
// `idempotencyKey` when `namePart` is at fault) fails the test loudly.
for (const scenario of [
  {
    name: 'missing ename block entirely',
    body: { idempotencyKey: generateUUIDv7(), subject: { kind: 'person' } },
    expectedPath: ['ename'],
  },
  {
    name: 'missing namePart inside ename block',
    body: { idempotencyKey: generateUUIDv7(), subject: { kind: 'person' }, ename: {} },
    expectedPath: ['ename', 'namePart'],
  },
  {
    name: 'missing subject block entirely',
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
    const response = await postSubject(scenario.body);
    assert.equal(response.status, 422);
    assert.match(response.headers.get('Content-Type') ?? '', /^application\/problem\+json/);

    const body = (await response.json()) as {
      type: string;
      title: string;
      status: number;
      detail: string;
      requestId: string;
      errors?: Array<{ path: Array<string | number>; message: string }>;
    };
    assert.equal(body.type, 'about:blank');
    assert.equal(body.status, 422);
    assert.equal(body.title, 'Validation failed');
    assert.match(body.requestId, UUIDV7_REGEX);
    assert.ok(Array.isArray(body.errors) && body.errors.length > 0);
    // At least one issue must point at the expected path — proves the error
    // is attributed to the correct field, not just "an error occurred".
    assert.ok(
      body.errors.some(
        (issue) =>
          issue.path.length >= scenario.expectedPath.length &&
          scenario.expectedPath.every((segment, index) => issue.path[index] === segment),
      ),
      `expected at least one error with path starting with [${scenario.expectedPath.join(', ')}], got ${JSON.stringify(body.errors)}`,
    );
  });
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

test('X-Request-Id is a UUIDv7 and present on success responses', async () => {
  const response = await postSubject(makeBody({ namePart: 'h-test' }));
  assert.equal(response.status, 201);
  const requestId = response.headers.get('X-Request-Id');
  assert.ok(requestId);
  assert.match(requestId, UUIDV7_REGEX);
});

test('X-Request-Id is also present on validation error responses', async () => {
  const response = await postSubject(makeBody({ idempotencyKey: 'bad', namePart: 'h-test' }));
  assert.equal(response.status, 422);
  const requestId = response.headers.get('X-Request-Id');
  assert.ok(requestId);
  // Same id appears in the body (per RFC 9457 + our extension).
  const body = (await response.json()) as { requestId: string };
  assert.equal(body.requestId, requestId);
});
