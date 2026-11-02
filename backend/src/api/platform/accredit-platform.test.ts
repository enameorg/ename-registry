import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';

import { useTestDatabase } from '../../database/testing.ts';
// Loaded before any Service module: @hono/zod-openapi adds `.openapi()` to the Zod schemas built
// after it loads, and the API wraps the Service's schemas.
import '../../index.ts';
import { platformAccreditedEventKindDefinition } from '../../services/platform/index.ts';
import {
  generateTestKey,
  makePlatformInput,
  setUpTestPlatform,
  signRequest,
  type TestPlatformSigner,
  type TestSigner,
} from '../../services/testing.ts';
import { generateUUIDv7 } from '../../utilities/uuid.ts';
import { postJSON, readJSON, readProblem } from '../testing.ts';

import { AccreditPlatformResponseSchema } from './accredit-platform.ts';

// The HTTP contract of POST /platforms only: statuses, headers, response shapes, Problem Details.
// What the use case persists is tested in services/platform/accredit-platform.test.ts. The registry
// is anchored and a platform accredited before each test, through the Service's test helper: setup,
// not the contract under test. Test doctrine: ename-internals.md.

const PATH = '/api/v1/platforms';

useTestDatabase();

let registry: TestSigner;
let platform: TestPlatformSigner;

beforeEach(async () => {
  ({ registry, platform } = await setUpTestPlatform());
});

// A valid body, signed by the registry unless another signer is given; each call overrides only
// what it asserts on.
function makeBody(
  overrides: {
    idempotencyKey?: string;
    platform?: Record<string, string>;
    keyValue?: string;
  } = {},
  signer: TestSigner = registry,
): Record<string, unknown> {
  const idempotencyKey = overrides.idempotencyKey ?? generateUUIDv7();
  const request = {
    platform: { ...makePlatformInput(), ...overrides.platform },
    key: {
      algorithm: 'ecdsa-p256-sha256' as const,
      value: overrides.keyValue ?? generateTestKey().publicKey,
    },
  };
  return {
    idempotencyKey,
    signature: signRequest(platformAccreditedEventKindDefinition, signer, {
      idempotencyKey,
      request,
    }),
    ...request,
  };
}

// ---------------------------------------------------------------------------
// Happy path, idempotency and conflicts
// ---------------------------------------------------------------------------

test('happy path: returns 201 with the accredited platform and its key', async () => {
  const body = makeBody();
  const response = await postJSON(PATH, body);

  assert.equal(response.status, 201);
  const result = await readJSON(response, AccreditPlatformResponseSchema);
  assert.deepEqual(result.platform, { id: result.platform.id, ...(body['platform'] as object) });
  assert.deepEqual(result.key, { id: result.key.id, ...(body['key'] as object) });
});

test('idempotent replay: same idempotencyKey + same body returns the same response', async () => {
  const requestBody = makeBody({ idempotencyKey: generateUUIDv7() });

  const firstResponse = await postJSON(PATH, requestBody);
  const secondResponse = await postJSON(PATH, requestBody);

  assert.equal(firstResponse.status, 201);
  assert.equal(secondResponse.status, 201);
  assert.deepEqual(
    await readJSON(firstResponse, AccreditPlatformResponseSchema),
    await readJSON(secondResponse, AccreditPlatformResponseSchema),
  );
});

test('idempotency conflict: same idempotencyKey with a different body returns 409 problem+json', async () => {
  const idempotencyKey = generateUUIDv7();

  const firstResponse = await postJSON(PATH, makeBody({ idempotencyKey }));
  assert.equal(firstResponse.status, 201);

  const secondResponse = await postJSON(PATH, makeBody({ idempotencyKey }));
  assert.equal(secondResponse.status, 409);

  const problem = await readProblem(secondResponse);
  assert.equal(problem.status, 409);
  assert.equal(problem.title, 'Idempotency conflict');
  assert.equal(
    problem.detail,
    'This idempotency key has already been used with a different request.',
  );
});

test('a second accreditation of the same registration returns 409 problem+json', async () => {
  const registration = { registrationIdentifier: makePlatformInput().registrationIdentifier };
  assert.equal((await postJSON(PATH, makeBody({ platform: registration }))).status, 201);

  const response = await postJSON(PATH, makeBody({ platform: registration }));

  assert.equal(response.status, 409);
  const problem = await readProblem(response);
  assert.equal(problem.title, 'Conflict');
  assert.equal(problem.detail, 'A platform is already accredited for this registration.');
});

// ---------------------------------------------------------------------------
// Signature (401, 403)
// ---------------------------------------------------------------------------

test('a signature that does not verify returns 401 problem+json with WWW-Authenticate', async () => {
  const body = makeBody();
  const response = await postJSON(PATH, {
    ...body,
    key: { algorithm: 'ecdsa-p256-sha256', value: generateTestKey().publicKey },
  });

  assert.equal(response.status, 401);
  assert.equal(response.headers.get('WWW-Authenticate'), 'EnameSignature');
  const problem = await readProblem(response);
  assert.equal(problem.title, 'Unauthorized');
  assert.equal(problem.detail, 'The request signature could not be verified.');
});

test('a body signed by a platform key returns 403 problem+json', async () => {
  const response = await postJSON(PATH, makeBody({}, platform));

  assert.equal(response.status, 403);
  const problem = await readProblem(response);
  assert.equal(problem.title, 'Forbidden');
  assert.equal(problem.detail, 'The signing key is not allowed to submit this request.');
});

// ---------------------------------------------------------------------------
// Validation failures (all → 422 problem+json)
// ---------------------------------------------------------------------------

test('a legal name that is not well-formed Unicode returns 422 problem+json, not 500', async () => {
  // Signed first, then altered: the request is refused before its signature is checked, since a
  // lone surrogate leaves nothing JCS can canonicalize.
  const body = makeBody();
  const response = await postJSON(PATH, {
    ...body,
    platform: { ...(body['platform'] as object), legalName: 'ACME \ud800' },
  });

  assert.equal(response.status, 422);
  const problem = await readProblem(response);
  assert.deepEqual(problem.errors, [
    { path: ['platform', 'legalName'], message: 'must be well-formed Unicode text' },
  ]);
});

for (const scenario of [
  {
    name: 'jurisdiction in lowercase',
    overrides: { platform: { jurisdiction: 'fr' } },
    expectedPath: ['platform', 'jurisdiction'],
  },
  {
    name: 'registration authority code outside the GLEIF form',
    overrides: { platform: { registrationAuthorityCode: 'SIREN' } },
    expectedPath: ['platform', 'registrationAuthorityCode'],
  },
  {
    name: 'key value that is no P-256 SPKI key',
    overrides: { keyValue: 'AAAA' },
    expectedPath: ['key', 'value'],
  },
]) {
  test(`validation failure: ${scenario.name} → 422 problem+json`, async () => {
    const response = await postJSON(PATH, makeBody(scenario.overrides));

    assert.equal(response.status, 422);
    const problem = await readProblem(response);
    assert.ok(
      problem.errors?.some(
        (issue) =>
          issue.path.length >= scenario.expectedPath.length &&
          scenario.expectedPath.every((segment, index) => issue.path[index] === segment),
      ),
      `expected at least one error with path starting with [${scenario.expectedPath.join(', ')}], got ${JSON.stringify(problem.errors)}`,
    );
  });
}
