import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { useTestDB } from '../../database/testing.ts';
import { app } from '../../index.ts';
import { TEST_ORIGIN } from '../testing.ts';

// The failure path (503) is covered at the service level, where the pool can be
// closed without a mock; here only the HTTP contract of the healthy path.
useTestDB();

test('GET /api/v1/health/deep returns 200 with status ok when the database answers', async () => {
  const response = await app.fetch(new Request(`${TEST_ORIGIN}/api/v1/health/deep`));

  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type') ?? '', /^application\/json/);
  assert.deepEqual(await response.json(), { status: 'ok' });
});
