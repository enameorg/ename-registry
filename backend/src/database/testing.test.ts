import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';

import pg from 'pg';

import { config } from '../config.ts';

import { closePool, pool } from './pool.ts';
import { assertTestDatabase } from './testing.ts';

after(async () => {
  await closePool();
});

test('the test-database guard lets the test pool through', async () => {
  await assertTestDatabase(pool);
});

// The refused database is the cluster's maintenance database, which always
// exists: the test never opens a connection to ename_dev.
test('the test-database guard refuses a database whose name does not end in _test', async () => {
  const maintenanceURL = new URL(config.databaseURL);
  maintenanceURL.pathname = '/postgres';
  const maintenance = new pg.Pool({ connectionString: maintenanceURL.href, max: 1 });
  try {
    await assert.rejects(assertTestDatabase(maintenance), /refusing to run on database postgres/);
  } finally {
    await maintenance.end();
  }
});
