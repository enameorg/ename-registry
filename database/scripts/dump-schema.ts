import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import pg from 'pg';

import { run } from '../src/migrate.ts';

// Write schema.sql from the migrations alone: create a throwaway database on the cluster of
// DATABASE_URL, apply every migration to it, dump its schema and drop it. The dump never reads a
// working database, whose state depends on its history. pg_dump runs in the Compose service `db`,
// so the dump matches the server's version; DATABASE_URL must therefore name that cluster, or
// pg_dump finds no database to dump.

const clusterURL = process.env['DATABASE_URL'];
if (!clusterURL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDirectory = resolve(packageDirectory, 'migrations');
const schemaPath = resolve(packageDirectory, 'schema.sql');
const databaseName = `ename_schema_dump_${randomUUID().replaceAll('-', '')}`;

const maintenance = new pg.Client({
  connectionString: clusterURL,
  application_name: 'ename-dump-schema',
});
await maintenance.connect();
try {
  await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  const databaseURL = new URL(clusterURL);
  databaseURL.pathname = `/${databaseName}`;
  const client = new pg.Client({
    connectionString: databaseURL.href,
    application_name: 'ename-dump-schema',
  });
  await client.connect();
  try {
    await run(client, migrationsDirectory);
  } finally {
    await client.end();
  }

  // The restrict key is fixed so the dump is the same bytes from one run to the next.
  const { stdout } = await promisify(execFile)(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'db',
      'pg_dump',
      '-U',
      'postgres',
      '-d',
      databaseName,
      '--schema-only',
      '--no-owner',
      '--no-privileges',
      '--restrict-key=enameschemadump',
    ],
    { cwd: packageDirectory, maxBuffer: 16 * 1024 * 1024 },
  );
  await writeFile(schemaPath, stdout);
  console.log('[dump-schema] schema.sql written from the migrations');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await maintenance.end();
}
