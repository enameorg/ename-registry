import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';

import { useTestDatabase } from '../../database/testing.ts';
// Loaded before any Service module: @hono/zod-openapi adds `.openapi()` to the
// Zod schemas built after it loads, and the API wraps the Service's schemas.
import '../../index.ts';
import { platformKeyAddedEventKindDefinition } from '../../services/platform/index.ts';
import {
  accreditTestPlatform,
  generateTestKey,
  setUpTestPlatform,
  signRequest,
  type TestPlatformSigner,
  type TestSigner,
} from '../../services/testing.ts';
import { generateUUIDv7 } from '../../utilities/uuid.ts';
import { postJSON, readJSON, readProblem } from '../testing.ts';

import { AddPlatformKeyResponseSchema } from './add-platform-key.ts';

// The HTTP contract of POST /platforms/{id}/keys only: statuses, headers,
// response shapes, Problem Details. What the use case persists is tested in
// services/platform/add-platform-key.test.ts. The registry is anchored and a
// platform accredited before each test, through the Service's test helper:
// setup, not the contract under test. Test doctrine: ename-internals.md.

function pathOf(platformId: string): string {
  return `/api/v1/platforms/${platformId}/keys`;
}

useTestDatabase();

let registry: TestSigner;
let platform: TestPlatformSigner;

beforeEach(async () => {
  ({ registry, platform } = await setUpTestPlatform());
});

// The body of a key added to this platform, signed by the registry unless
// another signer is given: the signed request names the platform of the path.
function makeBody(
  platformId: string,
  overrides: { idempotencyKey?: string; keyValue?: string } = {},
  signer: TestSigner = registry,
): Record<string, unknown> {
  const idempotencyKey = overrides.idempotencyKey ?? generateUUIDv7();
  const key = {
    algorithm: 'ecdsa-p256-sha256' as const,
    value: overrides.keyValue ?? generateTestKey().publicKey,
  };
  return {
    idempotencyKey,
    signature: signRequest(platformKeyAddedEventKindDefinition, signer, {
      idempotencyKey,
      request: { platform: { id: platformId }, key },
    }),
    key,
  };
}

// ---------------------------------------------------------------------------
// Happy path, idempotency and the unknown platform
// ---------------------------------------------------------------------------

test('happy path: returns 201 with the platform id and the added key', async () => {
  const body = makeBody(platform.platformId);
  const response = await postJSON(pathOf(platform.platformId), body);

  assert.equal(response.status, 201);
  const result = await readJSON(response, AddPlatformKeyResponseSchema);
  assert.deepEqual(result.platform, { id: platform.platformId });
  assert.deepEqual(result.key, { id: result.key.id, ...(body['key'] as object) });
});

test('idempotent replay: same path, idempotencyKey and body returns the same response', async () => {
  const requestBody = makeBody(platform.platformId, { idempotencyKey: generateUUIDv7() });

  const firstResponse = await postJSON(pathOf(platform.platformId), requestBody);
  const secondResponse = await postJSON(pathOf(platform.platformId), requestBody);

  assert.equal(firstResponse.status, 201);
  assert.equal(secondResponse.status, 201);
  assert.deepEqual(
    await readJSON(firstResponse, AddPlatformKeyResponseSchema),
    await readJSON(secondResponse, AddPlatformKeyResponseSchema),
  );
});

test('idempotency conflict: same key with a different body returns 409 problem+json', async () => {
  const idempotencyKey = generateUUIDv7();

  const firstResponse = await postJSON(
    pathOf(platform.platformId),
    makeBody(platform.platformId, { idempotencyKey }),
  );
  assert.equal(firstResponse.status, 201);

  const secondResponse = await postJSON(
    pathOf(platform.platformId),
    makeBody(platform.platformId, { idempotencyKey }),
  );
  assert.equal(secondResponse.status, 409);

  const problem = await readProblem(secondResponse);
  assert.equal(problem.status, 409);
  assert.equal(problem.title, 'Idempotency conflict');
  assert.equal(
    problem.detail,
    'This idempotency key has already been used with a different request.',
  );
});

test('idempotency conflict: same key with a different path returns 409 problem+json', async () => {
  const other = await accreditTestPlatform(registry);
  const idempotencyKey = generateUUIDv7();
  const keyValue = generateTestKey().publicKey;

  const firstResponse = await postJSON(
    pathOf(platform.platformId),
    makeBody(platform.platformId, { idempotencyKey, keyValue }),
  );
  assert.equal(firstResponse.status, 201);

  const secondResponse = await postJSON(
    pathOf(other.platformId),
    makeBody(other.platformId, { idempotencyKey, keyValue }),
  );
  assert.equal(secondResponse.status, 409);

  const problem = await readProblem(secondResponse);
  assert.equal(problem.status, 409);
  assert.equal(problem.title, 'Idempotency conflict');
  assert.equal(
    problem.detail,
    'This idempotency key has already been used with a different request.',
  );
});

test('an unknown platform returns 404 problem+json', async () => {
  const platformId = generateUUIDv7();
  const response = await postJSON(pathOf(platformId), makeBody(platformId));

  assert.equal(response.status, 404);
  const problem = await readProblem(response);
  assert.equal(problem.title, 'Not found');
  assert.equal(problem.detail, 'Platform not found.');
});

// ---------------------------------------------------------------------------
// Signature (401, 403)
// ---------------------------------------------------------------------------

test('a signature that does not verify returns 401 problem+json with WWW-Authenticate', async () => {
  const body = makeBody(platform.platformId);
  const response = await postJSON(pathOf(platform.platformId), {
    ...body,
    key: { algorithm: 'ecdsa-p256-sha256', value: generateTestKey().publicKey },
  });

  assert.equal(response.status, 401);
  assert.equal(response.headers.get('WWW-Authenticate'), 'EnameSignature');
  const problem = await readProblem(response);
  assert.equal(problem.title, 'Unauthorized');
  assert.equal(problem.detail, 'The request signature could not be verified.');
});

test('a body signed by the platform itself returns 403 problem+json', async () => {
  const response = await postJSON(
    pathOf(platform.platformId),
    makeBody(platform.platformId, {}, platform),
  );

  assert.equal(response.status, 403);
  const problem = await readProblem(response);
  assert.equal(problem.title, 'Forbidden');
  assert.equal(problem.detail, 'The signing key is not allowed to submit this request.');
});

// ---------------------------------------------------------------------------
// Validation failures (all → 422 problem+json)
// ---------------------------------------------------------------------------

test('invalid platform id path parameter returns 422 problem+json', async () => {
  const response = await postJSON(pathOf('not-a-uuid'), makeBody('not-a-uuid'));

  assert.equal(response.status, 422);
  const problem = await readProblem(response);
  assert.equal(problem.status, 422);
  assert.ok(problem.errors?.some((issue) => issue.path[0] === 'id'));
});
