import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { app } from '../index.ts';

test('GET /api/v1/health returns 200 with status ok', async () => {
  const response = await app.fetch(new Request('http://localhost/api/v1/health'));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});
