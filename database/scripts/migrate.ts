import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

// Forward-only migration runner, using the sqlx-cli on-disk format
// (<unix_ts>_<name>.up.sql / .down.sql) so the Rust phase can point sqlx-cli at
// database/migrations/ unchanged.
//
// Invariants:
//   1. schema_migrations stores a SHA-256 of each file — detects edits to
//      already-applied migrations.
//   2. One transaction per migration, holding a transaction-level advisory
//      lock (pg_advisory_xact_lock) under which the migration is re-checked as
//      still pending: overlapping runners serialize and converge instead of
//      failing. The PRIMARY KEY on version is the hard guarantee — a double
//      apply fails on the INSERT and its DDL rolls back with it. A session-level
//      lock around the whole run is not an option: Serverless SQL pools
//      connections per transaction, so such a lock stays on one server
//      connection while the next statements run on others.
//   3. A file starting with `-- migrate:no-transaction` (e.g. CREATE INDEX
//      CONCURRENTLY) runs outside any transaction, hence without the lock or
//      the rollback: it must be idempotent, and the runner must be launched by
//      a single job at a time.
//   4. Lexicographic order on filename (the Unix-timestamp prefix is stable
//      across machines).
//   5. Single connection, sequential — no parallelism.
//   6. No `down` command: up migrations only. `.down.sql` exists for sqlx
//      parity and manual rollback, never in production.

const ADVISORY_LOCK_KEY = 9_876_543_210n;

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = resolve(scriptDirectory, '..', 'migrations');

interface Migration {
  version: string;
  name: string;
  sql: string;
  hash: string;
  noTransaction: boolean;
}

interface AppliedRow {
  version: string;
  name: string;
  hash: string;
}

async function run(target: string): Promise<void> {
  const url = resolveTargetUrl(target);
  const client = new pg.Client({ connectionString: url, application_name: 'ename-migrate' });
  await client.connect();

  try {
    // Bootstrap the bookkeeping table under the same lock as the migrations:
    // two runners racing on an empty database would otherwise collide on
    // CREATE TABLE IF NOT EXISTS (a unique violation in pg_type).
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [ADVISORY_LOCK_KEY.toString()]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        hash TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query('COMMIT');

    const appliedResult = await client.query<AppliedRow>(
      'SELECT version, name, hash FROM schema_migrations',
    );
    const applied = new Map(appliedResult.rows.map((row) => [row.version, row]));

    const migrations = await loadMigrations();

    for (const migration of migrations) {
      const appliedRow = applied.get(migration.version);
      if (appliedRow && appliedRow.hash !== migration.hash) {
        throw new Error(
          `Migration ${migration.version} was modified after being applied ` +
            `(hash on disk: ${migration.hash.slice(0, 12)}…, hash in DB: ${appliedRow.hash.slice(0, 12)}…). ` +
            `Migrations are immutable once applied — create a new migration instead.`,
        );
      }
    }

    const pending = migrations.filter((migration) => !applied.has(migration.version));

    if (pending.length === 0) {
      console.log(`[migrate:${target}] no pending migrations (${migrations.length} applied)`);
      return;
    }

    let appliedCount = 0;
    for (const migration of pending) {
      console.log(`[migrate:${target}] applying ${migration.version}…`);
      if (migration.noTransaction) {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name, hash) VALUES ($1, $2, $3)',
          [migration.version, migration.name, migration.hash],
        );
        appliedCount += 1;
      } else if (await applyInTransaction(client, migration)) {
        appliedCount += 1;
      } else {
        console.log(
          `[migrate:${target}] ${migration.version} applied by another runner meanwhile, skipped`,
        );
      }
    }

    console.log(
      `[migrate:${target}] applied ${appliedCount} of ${pending.length} pending migration(s)`,
    );
  } finally {
    await client.end();
  }
}

// Apply one migration in its own transaction. Returns false when another runner
// applied it between our pending computation and our lock acquisition.
async function applyInTransaction(client: pg.Client, migration: Migration): Promise<boolean> {
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [ADVISORY_LOCK_KEY.toString()]);
    const alreadyApplied = await client.query(
      'SELECT 1 FROM schema_migrations WHERE version = $1',
      [migration.version],
    );
    if ((alreadyApplied.rowCount ?? 0) > 0) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(migration.sql);
    await client.query('INSERT INTO schema_migrations (version, name, hash) VALUES ($1, $2, $3)', [
      migration.version,
      migration.name,
      migration.hash,
    ]);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    // The rollback must never mask the original error (cf. ename-internals.md).
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error(
        `rollback of ${migration.version} failed; original error follows:`,
        rollbackError,
      );
    }
    throw error;
  }
}

function resolveTargetUrl(target: string): string {
  const envVar = target === 'test' ? 'TEST_DATABASE_URL' : 'DATABASE_URL';
  const url = process.env[envVar];
  if (!url) {
    throw new Error(`${envVar} is not set (target: ${target})`);
  }
  return url;
}

async function loadMigrations(): Promise<Migration[]> {
  let entries: string[];
  try {
    entries = await readdir(migrationsDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const upFiles = entries.filter((entry) => entry.endsWith('.up.sql')).sort();
  const migrations: Migration[] = [];

  for (const filename of upFiles) {
    const version = filename.slice(0, -'.up.sql'.length);
    const separatorIndex = version.indexOf('_');
    const name = separatorIndex === -1 ? version : version.slice(separatorIndex + 1);
    const sql = await readFile(resolve(migrationsDirectory, filename), 'utf-8');
    const hash = createHash('sha256').update(sql).digest('hex');
    const noTransaction = /^\s*--\s*migrate:no-transaction\b/m.test(sql);
    migrations.push({ version, name, sql, hash, noTransaction });
  }

  return migrations;
}

const target = process.argv[2] ?? 'dev';
if (target !== 'dev' && target !== 'test') {
  console.error(`Unknown target: ${target} (expected 'dev' or 'test')`);
  process.exit(1);
}

try {
  await run(target);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
