import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';

import { v7 as uuidv7 } from 'uuid';

import { pool } from '../database/pool.ts';
import { resetTestDb } from '../database/reset-for-tests.ts';
import { app } from '../index.ts';
import { UUIDV7_REGEX } from '../uuid.ts';

const ENDPOINT = 'http://localhost/api/v1/subjects';

beforeEach(async () => {
  await resetTestDb(pool);
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
    idempotencyKey: overrides.idempotencyKey ?? uuidv7(),
    subject: { kind: overrides.kind ?? 'person' },
    ename: { namePart: overrides.namePart ?? 'jean-dupont' },
  };
}

// ---------------------------------------------------------------------------
// Happy path + idempotency
// ---------------------------------------------------------------------------

test('happy path: returns 201 with the created subject and ename, and writes one row per table', async () => {
  const idempotencyKey = uuidv7();

  const response = await postSubject(makeBody({ idempotencyKey, namePart: 'jean-dupont' }));

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

  // Projections.
  const { rows: subjects } = await pool.query<{ id: string; kind: string; created_at: Date }>(
    'SELECT id, kind, created_at FROM subjects',
  );
  assert.equal(subjects.length, 1);
  assert.equal(subjects[0]?.id, body.subject.id);

  const { rows: enames } = await pool.query<{
    id: string;
    subject_id: string;
    name_part: string;
    number_part: string;
    created_at: Date;
  }>('SELECT id, subject_id, name_part, number_part, created_at FROM enames');
  assert.equal(enames.length, 1);
  assert.equal(enames[0]?.id, body.ename.id);
  assert.equal(enames[0]?.subject_id, body.subject.id);
  assert.equal(enames[0]?.name_part, 'jean-dupont');
  assert.equal(enames[0]?.number_part, '1');

  // Event log.
  const { rows: events } = await pool.query<{
    sequence: string;
    idempotency_key: string;
    kind: string;
    payload: { subject: { id: string }; ename: { id: string; numberPart: number } };
    created_at: Date;
  }>('SELECT sequence, idempotency_key, kind, payload, created_at FROM events ORDER BY sequence');
  assert.equal(events.length, 1);
  assert.equal(events[0]?.idempotency_key, idempotencyKey);
  assert.equal(events[0]?.kind, 'subject.registered');
  assert.equal(events[0]?.payload.subject.id, body.subject.id);
  assert.equal(events[0]?.payload.ename.id, body.ename.id);
  assert.equal(events[0]?.payload.ename.numberPart, 1);

  // The three created_at values are strictly equal — required for
  // deterministic projection-by-replay.
  const subjectAt = subjects[0]?.created_at.getTime();
  const enameAt = enames[0]?.created_at.getTime();
  const eventAt = events[0]?.created_at.getTime();
  const responseAt = Date.parse(body.createdAt);
  assert.equal(subjectAt, eventAt);
  assert.equal(enameAt, eventAt);
  assert.equal(responseAt, eventAt);
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

test('idempotent replay: same idempotencyKey + same body returns the same payload and writes nothing new', async () => {
  const idempotencyKey = uuidv7();
  const requestBody = makeBody({ idempotencyKey, namePart: 'albert-einstein' });

  const firstResponse = await postSubject(requestBody);
  const secondResponse = await postSubject(requestBody);

  assert.equal(firstResponse.status, 201);
  assert.equal(secondResponse.status, 201);
  const firstBody = await firstResponse.json();
  const secondBody = await secondResponse.json();
  assert.deepEqual(firstBody, secondBody);

  const { rows: events } = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM events',
  );
  assert.equal(events[0]?.count, '1');
  const { rows: enames } = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM enames',
  );
  assert.equal(enames[0]?.count, '1');
});

test('idempotency conflict: same idempotencyKey with a different body returns 409 problem+json', async () => {
  const idempotencyKey = uuidv7();

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
    body: { idempotencyKey: uuidv7(), subject: { kind: 'person' } },
    expectedPath: ['ename'],
  },
  {
    name: 'missing namePart inside ename block',
    body: { idempotencyKey: uuidv7(), subject: { kind: 'person' }, ename: {} },
    expectedPath: ['ename', 'namePart'],
  },
  {
    name: 'missing subject block entirely',
    body: { idempotencyKey: uuidv7(), ename: { namePart: 'jean' } },
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
// Domain validation: total length > 52 chars after numberPart allocation
// ---------------------------------------------------------------------------

test('domain validation: allocation that would exceed 52 chars returns 422', async () => {
  // Seed an existing ename with a 50-char namePart and numberPart=9 — the
  // next allocation would be numberPart=10 (2 digits), giving total
  // 50 + 1 + 2 = 53 > 52. Bypass the service to plant this state directly:
  // we are testing the post-allocation guard, not the seed path.
  const namePart = 'a'.repeat(50);
  const seedSubjectId = uuidv7();
  const seedEnameId = uuidv7();
  const seedAt = new Date();
  await pool.query('INSERT INTO subjects (id, kind, created_at) VALUES ($1, $2, $3)', [
    seedSubjectId,
    'person',
    seedAt,
  ]);
  await pool.query(
    'INSERT INTO enames (id, subject_id, name_part, number_part, created_at) VALUES ($1, $2, $3, $4, $5)',
    [seedEnameId, seedSubjectId, namePart, 9, seedAt],
  );

  const response = await postSubject(makeBody({ namePart }));

  assert.equal(response.status, 422);
  assert.match(response.headers.get('Content-Type') ?? '', /^application\/problem\+json/);
  const body = (await response.json()) as {
    title: string;
    detail: string;
    errors?: Array<{ path: Array<string | number>; message: string }>;
  };
  assert.equal(body.title, 'Validation failed');
  assert.match(body.detail, /52/);
  assert.match(body.detail, /shorter/i);
  // The error path now points at the nested location in the request body.
  assert.ok(
    body.errors?.some((issue) => issue.path[0] === 'ename' && issue.path[1] === 'namePart'),
  );

  // Nothing extra was committed (the ROLLBACK undid the subjects/enames
  // INSERTs from this attempt) — only the seed subject remains.
  const { rows: subjectRows } = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM subjects',
  );
  assert.equal(subjectRows[0]?.count, '1');
  const { rows: enameRows } = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM enames',
  );
  assert.equal(enameRows[0]?.count, '1');
  const { rows: eventRows } = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM events',
  );
  assert.equal(eventRows[0]?.count, '0');
});

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
