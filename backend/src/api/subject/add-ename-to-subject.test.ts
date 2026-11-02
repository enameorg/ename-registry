import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';

import { useTestDatabase } from '../../database/testing.ts';
// Loaded before any Service module: @hono/zod-openapi adds `.openapi()` to the Zod schemas built
// after it loads, and the API wraps the Service's schemas.
import { app } from '../../index.ts';
import {
  subjectEnameAddedEventKindDefinition,
  subjectRegisteredEventKindDefinition,
} from '../../services/subject/index.ts';
import {
  accreditTestPlatform,
  setUpTestPlatform,
  signRequest,
  type TestPlatformSigner,
  type TestSigner,
} from '../../services/testing.ts';
import { generateUUIDv7 } from '../../utilities/uuid.ts';
import { TEST_ORIGIN, postJSON, readJSON, readProblem } from '../testing.ts';

import { AddEnameToSubjectResponseSchema } from './add-ename-to-subject.ts';
import { RegisterSubjectResponseSchema } from './register-subject.ts';

// The HTTP contract of POST /subjects/{id}/enames only: statuses, headers, response shapes, Problem
// Details. What the use case persists is tested in services/subject/add-ename-to-subject.test.ts.
// The registry is anchored and a platform accredited before each test, through the Service's test
// helper: setup, not the contract under test. Test doctrine: ename-internals.md.

const SUBJECTS_PATH = '/api/v1/subjects';

function pathOf(subjectId: string): string {
  return `${SUBJECTS_PATH}/${subjectId}/enames`;
}

useTestDatabase();

let registry: TestSigner;
let platform: TestPlatformSigner;

beforeEach(async () => {
  ({ registry, platform } = await setUpTestPlatform());
});

function makeRegisterBody(namePart: string): Record<string, unknown> {
  const idempotencyKey = generateUUIDv7();
  const request = { subject: { kind: 'person' as const }, ename: { namePart } };
  return {
    idempotencyKey,
    signature: signRequest(subjectRegisteredEventKindDefinition, platform, {
      idempotencyKey,
      request,
    }),
    ...request,
  };
}

// The body of an addition to this subject, signed by the platform unless another signer is given:
// the signed request names the subject of the path.
function makeAddBody(
  subjectId: string,
  overrides: { idempotencyKey?: string; namePart?: string },
  signer: TestSigner = platform,
): Record<string, unknown> {
  const idempotencyKey = overrides.idempotencyKey ?? generateUUIDv7();
  const ename = { namePart: overrides.namePart ?? 'new-name' };
  return {
    idempotencyKey,
    signature: signRequest(subjectEnameAddedEventKindDefinition, signer, {
      idempotencyKey,
      request: { subject: { id: subjectId }, ename },
    }),
    ename,
  };
}

async function seedSubject(namePart = 'old-name'): Promise<{ id: string }> {
  const response = await postJSON(SUBJECTS_PATH, makeRegisterBody(namePart));
  assert.equal(response.status, 201);
  const body = await readJSON(response, RegisterSubjectResponseSchema);
  return body.subject;
}

test('happy path: returns 201 with the subject id and added ename', async () => {
  const subject = await seedSubject();

  const response = await postJSON(
    pathOf(subject.id),
    makeAddBody(subject.id, { namePart: 'new-name' }),
  );

  assert.equal(response.status, 201);
  assert.ok(response.headers.get('X-Request-Id'));

  const body = await readJSON(response, AddEnameToSubjectResponseSchema);
  assert.equal(body.subject.id, subject.id);
  assert.equal(body.ename.namePart, 'new-name');
  assert.equal(body.ename.numberPart, 1);
});

test('idempotent replay: same path, idempotencyKey and body returns the same response', async () => {
  const subject = await seedSubject();
  const requestBody = makeAddBody(subject.id, {
    idempotencyKey: generateUUIDv7(),
    namePart: 'new-name',
  });

  const firstResponse = await postJSON(pathOf(subject.id), requestBody);
  const secondResponse = await postJSON(pathOf(subject.id), requestBody);

  assert.equal(firstResponse.status, 201);
  assert.equal(secondResponse.status, 201);
  assert.deepEqual(
    await readJSON(firstResponse, AddEnameToSubjectResponseSchema),
    await readJSON(secondResponse, AddEnameToSubjectResponseSchema),
  );
});

test('idempotency conflict: same key with a different body returns 409 problem+json', async () => {
  const subject = await seedSubject();
  const idempotencyKey = generateUUIDv7();

  const firstResponse = await postJSON(
    pathOf(subject.id),
    makeAddBody(subject.id, { idempotencyKey, namePart: 'first-name' }),
  );
  assert.equal(firstResponse.status, 201);

  const secondResponse = await postJSON(
    pathOf(subject.id),
    makeAddBody(subject.id, { idempotencyKey, namePart: 'second-name' }),
  );
  assert.equal(secondResponse.status, 409);

  const body = await readProblem(secondResponse);
  assert.equal(body.status, 409);
  assert.equal(body.title, 'Idempotency conflict');
  assert.equal(body.detail, 'This idempotency key has already been used with a different request.');
});

test('idempotency conflict: same key with a different path returns 409 problem+json', async () => {
  const firstSubject = await seedSubject('first-subject');
  const secondSubject = await seedSubject('second-subject');
  const idempotencyKey = generateUUIDv7();

  const firstResponse = await postJSON(
    pathOf(firstSubject.id),
    makeAddBody(firstSubject.id, { idempotencyKey, namePart: 'shared-new-name' }),
  );
  assert.equal(firstResponse.status, 201);

  const secondResponse = await postJSON(
    pathOf(secondSubject.id),
    makeAddBody(secondSubject.id, { idempotencyKey, namePart: 'shared-new-name' }),
  );
  assert.equal(secondResponse.status, 409);

  const body = await readProblem(secondResponse);
  assert.equal(body.status, 409);
  assert.equal(body.title, 'Idempotency conflict');
  assert.equal(body.detail, 'This idempotency key has already been used with a different request.');
});

test('duplicate namePart for the same subject returns 409 problem+json', async () => {
  const subject = await seedSubject('same-name');

  const response = await postJSON(
    pathOf(subject.id),
    makeAddBody(subject.id, { namePart: 'same-name' }),
  );

  assert.equal(response.status, 409);
  const body = await readProblem(response);
  assert.equal(body.status, 409);
  assert.equal(body.title, 'Conflict');
  assert.equal(body.detail, 'This subject already has an ename with this namePart.');
  assert.equal(body.errors, undefined);
});

test('unknown subject returns 404 problem+json', async () => {
  const subjectId = generateUUIDv7();
  const response = await postJSON(
    pathOf(subjectId),
    makeAddBody(subjectId, { namePart: 'new-name' }),
  );

  assert.equal(response.status, 404);
  const body = await readProblem(response);
  assert.equal(body.status, 404);
  assert.equal(body.title, 'Not found');
  assert.equal(body.detail, 'Subject not found.');
});

test('an addition signed by another platform than the home platform returns 403 problem+json', async () => {
  const subject = await seedSubject();
  const other = await accreditTestPlatform(registry);

  const response = await postJSON(
    pathOf(subject.id),
    makeAddBody(subject.id, { namePart: 'new-name' }, other),
  );

  assert.equal(response.status, 403);
  const body = await readProblem(response);
  assert.equal(body.title, 'Forbidden');
  assert.equal(body.detail, 'Only the home platform of this subject may add an ename to it.');
});

test('an addition signed for another subject returns 401 problem+json', async () => {
  const subject = await seedSubject();

  const response = await postJSON(
    pathOf(subject.id),
    makeAddBody(generateUUIDv7(), { namePart: 'new-name' }),
  );

  assert.equal(response.status, 401);
  assert.equal(response.headers.get('WWW-Authenticate'), 'EnameSignature');
  const body = await readProblem(response);
  assert.equal(body.title, 'Unauthorized');
  assert.equal(body.detail, 'The request signature could not be verified.');
});

test('invalid subject id path parameter returns 422 problem+json', async () => {
  const response = await postJSON(
    pathOf('not-a-uuid'),
    makeAddBody('not-a-uuid', { namePart: 'new-name' }),
  );

  assert.equal(response.status, 422);
  const body = await readProblem(response);
  assert.equal(body.status, 422);
  assert.ok(body.errors?.some((issue) => issue.path[0] === 'id'));
});

test('malformed JSON body returns 400 problem+json', async () => {
  const subject = await seedSubject();
  const response = await app.fetch(
    new Request(`${TEST_ORIGIN}${pathOf(subject.id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'hey',
    }),
  );

  assert.equal(response.status, 400);
  await readProblem(response);
});

test('non-JSON Content-Type returns 415 problem+json', async () => {
  const subject = await seedSubject();
  const response = await app.fetch(
    new Request(`${TEST_ORIGIN}${pathOf(subject.id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(makeAddBody(subject.id, {})),
    }),
  );

  assert.equal(response.status, 415);
  await readProblem(response);
});

for (const scenario of [
  {
    name: 'missing ename object entirely',
    body: (subjectId: string) => ({ ...makeAddBody(subjectId, {}), ename: undefined }),
    expectedPath: ['ename'],
  },
  {
    name: 'missing namePart inside ename object',
    body: (subjectId: string) => ({ ...makeAddBody(subjectId, {}), ename: {} }),
    expectedPath: ['ename', 'namePart'],
  },
  {
    name: 'missing signature',
    body: (subjectId: string) => ({ ...makeAddBody(subjectId, {}), signature: undefined }),
    expectedPath: ['signature'],
  },
  {
    name: 'namePart contains uppercase',
    body: (subjectId: string) => makeAddBody(subjectId, { namePart: 'New-Name' }),
    expectedPath: ['ename', 'namePart'],
  },
  {
    name: 'namePart has consecutive hyphens',
    body: (subjectId: string) => makeAddBody(subjectId, { namePart: 'new--name' }),
    expectedPath: ['ename', 'namePart'],
  },
  {
    name: 'idempotencyKey is not a UUIDv7',
    body: (subjectId: string) =>
      makeAddBody(subjectId, { idempotencyKey: 'not-a-uuid', namePart: 'new-name' }),
    expectedPath: ['idempotencyKey'],
  },
]) {
  test(`validation failure: ${scenario.name} → 422 problem+json`, async () => {
    const subject = await seedSubject();
    const response = await postJSON(pathOf(subject.id), scenario.body(subject.id));

    assert.equal(response.status, 422);

    const body = await readProblem(response);
    assert.equal(body.status, 422);
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

// Strict input: an unknown field is a 422 whose issue names the key and points at the object
// holding it, never a silent drop (cf. ename-internals.md).
for (const scenario of [
  {
    name: 'unknown top-level field',
    body: (subjectId: string) => ({ ...makeAddBody(subjectId, {}), extra: 1 }),
    key: 'extra',
    expectedPath: [],
  },
  {
    name: 'unknown field inside ename object',
    body: (subjectId: string) => ({
      ...makeAddBody(subjectId, {}),
      ename: { namePart: 'new-name', hidden: true },
    }),
    key: 'hidden',
    expectedPath: ['ename'],
  },
]) {
  test(`validation failure: ${scenario.name} → 422 naming the key`, async () => {
    const subject = await seedSubject();
    const response = await postJSON(pathOf(subject.id), scenario.body(subject.id));

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
