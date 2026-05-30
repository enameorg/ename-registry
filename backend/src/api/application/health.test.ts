import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { app } from '../../index.ts';
import { UUIDV7_REGEX } from '../../uuid.ts';

test('GET /api/v1/health returns 200 with status ok and an X-Request-Id header', async () => {
  const response = await app.fetch(new Request('http://localhost/api/v1/health'));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
  // Every response from the v1 sub-app must carry an X-Request-Id (the
  // server-generated observability id, distinct from any body field).
  assert.match(response.headers.get('X-Request-Id') ?? '', UUIDV7_REGEX);
});
