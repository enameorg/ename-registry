import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { useTestDb } from '../../database/testing.ts';
import { app } from '../../index.ts';
import { generateUUIDv7 } from '../../utilities/uuid.ts';
import { TEST_ORIGIN, postJSON, readJSON, readProblem } from '../testing.ts';

import { AddEnameToSubjectResponseSchema } from './add-ename-to-subject.ts';
import { RegisterSubjectResponseSchema } from './register-subject.ts';

const SUBJECTS_PATH = '/api/v1/subjects';

useTestDb();

function makeRegisterBody(namePart: string): Record<string, unknown> {
  return {
    idempotencyKey: generateUUIDv7(),
    subject: { kind: 'person' },
    ename: { namePart },
  };
}

function makeAddBody(overrides: {
  idempotencyKey?: string;
  namePart?: string;
}): Record<string, unknown> {
  return {
    idempotencyKey: overrides.idempotencyKey ?? generateUUIDv7(),
    ename: { namePart: overrides.namePart ?? 'new-name' },
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
    `${SUBJECTS_PATH}/${subject.id}/enames`,
    makeAddBody({ namePart: 'new-name' }),
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
  const requestBody = makeAddBody({ idempotencyKey: generateUUIDv7(), namePart: 'new-name' });

  const firstResponse = await postJSON(`${SUBJECTS_PATH}/${subject.id}/enames`, requestBody);
  const secondResponse = await postJSON(`${SUBJECTS_PATH}/${subject.id}/enames`, requestBody);

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
    `${SUBJECTS_PATH}/${subject.id}/enames`,
    makeAddBody({ idempotencyKey, namePart: 'first-name' }),
  );
  assert.equal(firstResponse.status, 201);

  const secondResponse = await postJSON(
    `${SUBJECTS_PATH}/${subject.id}/enames`,
    makeAddBody({ idempotencyKey, namePart: 'second-name' }),
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
    `${SUBJECTS_PATH}/${firstSubject.id}/enames`,
    makeAddBody({ idempotencyKey, namePart: 'shared-new-name' }),
  );
  assert.equal(firstResponse.status, 201);

  const secondResponse = await postJSON(
    `${SUBJECTS_PATH}/${secondSubject.id}/enames`,
    makeAddBody({ idempotencyKey, namePart: 'shared-new-name' }),
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
    `${SUBJECTS_PATH}/${subject.id}/enames`,
    makeAddBody({ namePart: 'same-name' }),
  );

  assert.equal(response.status, 409);
  const body = await readProblem(response);
  assert.equal(body.status, 409);
  assert.equal(body.title, 'Conflict');
  assert.equal(body.detail, 'This subject already has an ename with this namePart.');
  assert.equal(body.errors, undefined);
});

test('unknown subject returns 404 problem+json', async () => {
  const response = await postJSON(
    `${SUBJECTS_PATH}/${generateUUIDv7()}/enames`,
    makeAddBody({ namePart: 'new-name' }),
  );

  assert.equal(response.status, 404);
  const body = await readProblem(response);
  assert.equal(body.status, 404);
  assert.equal(body.title, 'Not found');
  assert.equal(body.detail, 'Subject not found.');
});

test('invalid subject id path parameter returns 422 problem+json', async () => {
  const response = await postJSON(
    `${SUBJECTS_PATH}/not-a-uuid/enames`,
    makeAddBody({ namePart: 'new-name' }),
  );

  assert.equal(response.status, 422);
  const body = await readProblem(response);
  assert.equal(body.status, 422);
  assert.ok(body.errors?.some((issue) => issue.path[0] === 'id'));
});

test('malformed JSON body returns 400 problem+json', async () => {
  const subject = await seedSubject();
  const response = await app.fetch(
    new Request(`${TEST_ORIGIN}${SUBJECTS_PATH}/${subject.id}/enames`, {
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
    new Request(`${TEST_ORIGIN}${SUBJECTS_PATH}/${subject.id}/enames`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(makeAddBody({})),
    }),
  );

  assert.equal(response.status, 415);
  await readProblem(response);
});

for (const scenario of [
  {
    name: 'missing ename object entirely',
    body: { idempotencyKey: generateUUIDv7() },
    expectedPath: ['ename'],
  },
  {
    name: 'missing namePart inside ename object',
    body: { idempotencyKey: generateUUIDv7(), ename: {} },
    expectedPath: ['ename', 'namePart'],
  },
  {
    name: 'namePart contains uppercase',
    body: makeAddBody({ namePart: 'New-Name' }),
    expectedPath: ['ename', 'namePart'],
  },
  {
    name: 'namePart has consecutive hyphens',
    body: makeAddBody({ namePart: 'new--name' }),
    expectedPath: ['ename', 'namePart'],
  },
  {
    name: 'idempotencyKey is not a UUIDv7',
    body: makeAddBody({ idempotencyKey: 'not-a-uuid', namePart: 'new-name' }),
    expectedPath: ['idempotencyKey'],
  },
]) {
  test(`validation failure: ${scenario.name} → 422 problem+json`, async () => {
    const subject = await seedSubject();
    const response = await postJSON(`${SUBJECTS_PATH}/${subject.id}/enames`, scenario.body);

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

// Strict input: an unknown field is a 422 whose issue names the key and points
// at the object holding it, never a silent drop (cf. ename-internals.md).
for (const scenario of [
  {
    name: 'unknown top-level field',
    body: { ...makeAddBody({}), extra: 1 },
    key: 'extra',
    expectedPath: [],
  },
  {
    name: 'unknown field inside ename object',
    body: { ...makeAddBody({}), ename: { namePart: 'new-name', hidden: true } },
    key: 'hidden',
    expectedPath: ['ename'],
  },
]) {
  test(`validation failure: ${scenario.name} → 422 naming the key`, async () => {
    const subject = await seedSubject();
    const response = await postJSON(`${SUBJECTS_PATH}/${subject.id}/enames`, scenario.body);

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
