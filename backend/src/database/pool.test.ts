import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { closePool, pool } from './pool.ts';

// Without the pool's 'error' listener, the connection loss surfaces as an
// uncaught exception (an unhandled 'error' event) instead of a log line; in
// production that exception kills the process.
after(async () => {
  await closePool();
});

test('an idle client losing its connection is evicted without crashing the process', async () => {
  // Two concurrent queries so the pool holds two idle clients afterwards.
  await Promise.all([pool.query('SELECT pg_sleep(0.1)'), pool.query('SELECT pg_sleep(0.1)')]);
  assert.equal(pool.idleCount, 2);

  // Terminate the other idle connection server-side. Scoped to this database
  // and application name so a dev server on the same cluster is never touched.
  const result = await pool.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
     WHERE datname = current_database()
       AND application_name = 'ename-backend'
       AND pid <> pg_backend_pid()`,
  );
  assert.equal(result.rowCount, 1);

  // The termination reaches the idle client asynchronously.
  await waitFor(() => pool.totalCount === 1);

  const { rows } = await pool.query('SELECT 1 AS one');
  assert.equal(rows[0]?.one, 1);
});

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met before timeout');
    }
    await sleep(20);
  }
}
