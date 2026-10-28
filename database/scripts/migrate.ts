import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { run } from '../src/migrate.ts';

// Thin entry point over src/migrate.ts: connect to the database DATABASE_URL
// names, run, print the report labelled with that database, exit. The runner's
// invariants live with the library.

const url = process.env['DATABASE_URL'];
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = resolve(scriptDirectory, '..', 'migrations');

const client = new pg.Client({ connectionString: url, application_name: 'ename-migrate' });
const label = `migrate:${client.database}`;
try {
  await client.connect();
  const report = await run(client, migrationsDirectory);
  for (const version of report.applied) {
    console.log(`[${label}] applied ${version}`);
  }
  for (const version of report.skipped) {
    console.log(`[${label}] ${version} applied by another runner meanwhile, skipped`);
  }
  if (report.applied.length === 0 && report.skipped.length === 0) {
    console.log(`[${label}] no pending migrations`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.end();
}
