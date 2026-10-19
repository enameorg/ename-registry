import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { run } from '../src/migrate.ts';

// Thin entry point over src/migrate.ts: pick the target database from argv,
// open the connection, run, print the report, exit. The runner's invariants
// live with the library.

const target = process.argv[2] ?? 'dev';
if (target !== 'dev' && target !== 'test') {
  console.error(`Unknown target: ${target} (expected 'dev' or 'test')`);
  process.exit(1);
}

const envVar = target === 'test' ? 'TEST_DATABASE_URL' : 'DATABASE_URL';
const url = process.env[envVar];
if (!url) {
  console.error(`${envVar} is not set (target: ${target})`);
  process.exit(1);
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = resolve(scriptDirectory, '..', 'migrations');

const client = new pg.Client({ connectionString: url, application_name: 'ename-migrate' });
try {
  await client.connect();
  const report = await run(client, migrationsDirectory);
  for (const version of report.applied) {
    console.log(`[migrate:${target}] applied ${version}`);
  }
  for (const version of report.skipped) {
    console.log(`[migrate:${target}] ${version} applied by another runner meanwhile, skipped`);
  }
  if (report.applied.length === 0 && report.skipped.length === 0) {
    console.log(`[migrate:${target}] no pending migrations`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.end();
}
