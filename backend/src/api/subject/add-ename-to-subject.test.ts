import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';

import { resetTestDb } from '../../database/reset-for-tests.ts';
import { app } from '../../index.ts';
import { generateUUIDv7, UUIDV7_REGEX } from '../../uuid.ts';

const SUBJECTS_ENDPOINT = 'http://localhost/api/v1/subjects';

beforeEach(async () => {
  await resetTestDb();
});

async function postSubject(body: unknown): Promise<Response> {
  return await app.fetch(
    new Request(SUBJECTS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function postSubjectEname(subjectId: string, body: unknown): Promise<Response> {
  return await app.fetch(
    new Request(`${SUBJECTS_ENDPOINT}/${subjectId}/enames`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

function makeRegisterBody(namePart: string): unknown {
  return {
    idempotencyKey: generateUUIDv7(),
    subject: { kind: 'person' },
    ename: { namePart },
  };
}

function makeAddBody(overrides: { idempotencyKey?: string; namePart?: string }): unknown {
  return {
    idempotencyKey: overrides.idempotencyKey ?? generateUUIDv7(),
    ename: { namePart: overrides.namePart ?? 'new-name' },
  };
}

async function seedSubject(namePart = 'old-name'): Promise<{ id: string }> {
  const response = await postSubject(makeRegisterBody(namePart));
  assert.equal(response.status, 201);
  const body = (await response.json()) as { subject: { id: string } };
  return body.subject;
}

test('happy path: returns 201 with the subject id and added ename', async () => {
  const subject = await seedSubject();

  const response = await postSubjectEname(subject.id, makeAddBody({ namePart: 'new-name' }));

  assert.equal(response.status, 201);
  assert.match(response.headers.get('Content-Type') ?? '', /^application\/json/);
  assert.ok(response.headers.get('X-Request-Id'));

  const body = (await response.json()) as {
    createdAt: string;
    subject: { id: string };
    ename: { id: string; namePart: string; numberPart: number };
  };
  assert.equal(body.subject.id, subject.id);
  assert.equal(body.ename.namePart, 'new-name');
  assert.equal(body.ename.numberPart, 1);
  assert.match(body.ename.id, UUIDV7_REGEX);
  assert.ok(!Number.isNaN(Date.parse(body.createdAt)));
});

test('idempotent replay: same path, idempotencyKey and body returns the same response', async () => {
  const subject = await seedSubject();
  const requestBody = makeAddBody({ idempotencyKey: generateUUIDv7(), namePart: 'new-name' });

  const firstResponse = await postSubjectEname(subject.id, requestBody);
  const secondResponse = await postSubjectEname(subject.id, requestBody);

  assert.equal(firstResponse.status, 201);
  assert.equal(secondResponse.status, 201);
  assert.deepEqual(await firstResponse.json(), await secondResponse.json());
});

test('idempotency conflict: same key with a different body returns 409 problem+json', async () => {
  const subject = await seedSubject();
  const idempotencyKey = generateUUIDv7();

  const firstResponse = await postSubjectEname(
    subject.id,
    makeAddBody({ idempotencyKey, namePart: 'first-name' }),
  );
  assert.equal(firstResponse.status, 201);

  const secondResponse = await postSubjectEname(
    subject.id,
    makeAddBody({ idempotencyKey, namePart: 'second-name' }),
  );
  assert.equal(secondResponse.status, 409);
  assert.match(secondResponse.headers.get('Content-Type') ?? '', /^application\/problem\+json/);

  const body = (await secondResponse.json()) as {
    title: string;
    status: number;
    detail: string;
    requestId: string;
  };
  assert.equal(body.status, 409);
  assert.equal(body.title, 'Idempotency conflict');
  assert.equal(body.detail, 'This idempotency key has already been used with a different request.');
  assert.match(body.requestId, UUIDV7_REGEX);
});

test('idempotency conflict: same key with a different path returns 409 problem+json', async () => {
  const firstSubject = await seedSubject('first-subject');
  const secondSubject = await seedSubject('second-subject');
  const idempotencyKey = generateUUIDv7();

  const firstResponse = await postSubjectEname(
    firstSubject.id,
    makeAddBody({ idempotencyKey, namePart: 'shared-new-name' }),
  );
  assert.equal(firstResponse.status, 201);

  const secondResponse = await postSubjectEname(
    secondSubject.id,
    makeAddBody({ idempotencyKey, namePart: 'shared-new-name' }),
  );
  assert.equal(secondResponse.status, 409);
  assert.match(secondResponse.headers.get('Content-Type') ?? '', /^application\/problem\+json/);

  const body = (await secondResponse.json()) as {
    title: string;
    status: number;
    detail: string;
    requestId: string;
  };
  assert.equal(body.status, 409);
  assert.equal(body.title, 'Idempotency conflict');
  assert.equal(body.detail, 'This idempotency key has already been used with a different request.');
  assert.match(body.requestId, UUIDV7_REGEX);
});

test('duplicate namePart for the same subject returns 409 problem+json', async () => {
  const subject = await seedSubject('same-name');

  const response = await postSubjectEname(subject.id, makeAddBody({ namePart: 'same-name' }));

  assert.equal(response.status, 409);
  assert.match(response.headers.get('Content-Type') ?? '', /^application\/problem\+json/);
  const body = (await response.json()) as {
    title: string;
    status: number;
    detail: string;
    errors?: unknown;
  };
  assert.equal(body.status, 409);
  assert.equal(body.title, 'Conflict');
  assert.equal(body.detail, 'This subject already has an ename with this namePart.');
  assert.equal(body.errors, undefined);
});

test('unknown subject returns 404 problem+json', async () => {
  const response = await postSubjectEname(generateUUIDv7(), makeAddBody({ namePart: 'new-name' }));

  assert.equal(response.status, 404);
  assert.match(response.headers.get('Content-Type') ?? '', /^application\/problem\+json/);
  const body = (await response.json()) as { title: string; status: number; detail: string };
  assert.equal(body.status, 404);
  assert.equal(body.title, 'Not found');
  assert.equal(body.detail, 'Subject not found.');
});

test('invalid subject id path parameter returns 422 problem+json', async () => {
  const response = await postSubjectEname('not-a-uuid', makeAddBody({ namePart: 'new-name' }));

  assert.equal(response.status, 422);
  assert.match(response.headers.get('Content-Type') ?? '', /^application\/problem\+json/);
  const body = (await response.json()) as {
    status: number;
    errors?: Array<{ path: Array<string | number>; message: string }>;
  };
  assert.equal(body.status, 422);
  assert.ok(body.errors?.some((issue) => issue.path[0] === 'id'));
});

test('malformed JSON body returns 400 problem+json', async () => {
  const subject = await seedSubject();
  const response = await app.fetch(
    new Request(`${SUBJECTS_ENDPOINT}/${subject.id}/enames`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'hey',
    }),
  );

  assert.equal(response.status, 400);
  assert.match(response.headers.get('Content-Type') ?? '', /^application\/problem\+json/);
});

for (const scenario of [
  {
    name: 'missing ename block entirely',
    body: { idempotencyKey: generateUUIDv7() },
    expectedPath: ['ename'],
  },
  {
    name: 'missing namePart inside ename block',
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
    const response = await postSubjectEname(subject.id, scenario.body);

    assert.equal(response.status, 422);
    assert.match(response.headers.get('Content-Type') ?? '', /^application\/problem\+json/);

    const body = (await response.json()) as {
      status: number;
      errors?: Array<{ path: Array<string | number>; message: string }>;
    };
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
