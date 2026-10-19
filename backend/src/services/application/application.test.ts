import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { pino } from 'pino';

import { checkDatabase, closeDatabase, health } from './application.ts';

const logger = pino({ level: 'silent' });

test('health() returns true', () => {
  assert.equal(health(), true);
});

test('checkDatabase() returns true while the database answers', async () => {
  assert.equal(await checkDatabase({ logger }), true);
});

// Last on purpose: releasing the database is the one failure mode reproducible
// without a mock, and it also releases the pool for this file.
test('checkDatabase() returns false once closeDatabase() has released the pool', async () => {
  await closeDatabase();
  assert.equal(await checkDatabase({ logger }), false);
});
