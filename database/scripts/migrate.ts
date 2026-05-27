import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

// Forward-only migration runner. Adopts the sqlx-cli on-disk format
// (<unix_ts>_<name>.up.sql / .down.sql) from day one, so the Rust phase can
// point sqlx-cli at database/migrations/ without any transformation.
//
// Invariants enforced:
//   1. pg_advisory_lock around the whole run — prevents concurrent runners
//      (CI + app boot race).
//   2. schema_migrations stores a SHA-256 of each file content — detects
//      post-hoc edits to applied migrations (silent drift killer).
//   3. Each migration runs inside its own transaction, unless its file starts
//      with a `-- migrate:no-transaction` header (needed for statements like
//      CREATE INDEX CONCURRENTLY that cannot run in a transaction).
//   4. Lexicographic ordering on filename. The Unix-timestamp prefix gives a
//      total order that is stable across machines.
//   5. Single connection, sequential application — no parallelism.
//   6. No `down` command exposed: this script applies up migrations only.
//      `.down.sql` files exist for sqlx parity and manual rollback, never as
//      a production command.

const ADVISORY_LOCK_KEY = 9_876_543_210n;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(scriptDir, '..', 'migrations');

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

async function loadMigrations(): Promise<Migration[]> {
  let entries: string[];
  try {
    entries = await readdir(migrationsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const upFiles = entries.filter((entry) => entry.endsWith('.up.sql')).sort();
  const migrations: Migration[] = [];

  for (const filename of upFiles) {
    const version = filename.slice(0, -'.up.sql'.length);
    const underscoreIdx = version.indexOf('_');
    const name = underscoreIdx === -1 ? version : version.slice(underscoreIdx + 1);
    const sql = await readFile(resolve(migrationsDir, filename), 'utf-8');
    const hash = createHash('sha256').update(sql).digest('hex');
    const noTransaction = /^\s*--\s*migrate:no-transaction\b/m.test(sql);
    migrations.push({ version, name, sql, hash, noTransaction });
  }

  return migrations;
}

function resolveTargetUrl(target: string): string {
  const envVar = target === 'test' ? 'TEST_DATABASE_URL' : 'DATABASE_URL';
  const url = process.env[envVar];
  if (!url) {
    throw new Error(`${envVar} is not set (target: ${target})`);
  }
  return url;
}

async function run(target: string): Promise<void> {
  const url = resolveTargetUrl(target);
  const client = new pg.Client({ connectionString: url, application_name: 'ename-migrate' });
  await client.connect();

  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY.toString()]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        hash TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const appliedResult = await client.query<AppliedRow>(
      'SELECT version, name, hash FROM schema_migrations',
    );
    const applied = new Map(appliedResult.rows.map((row) => [row.version, row]));

    const migrations = await loadMigrations();

    for (const migration of migrations) {
      const appliedRow = applied.get(migration.version);
      if (appliedRow && appliedRow.hash !== migration.hash) {
        throw new Error(
          `Migration ${migration.version} (${migration.name}) was modified after being applied ` +
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

    for (const migration of pending) {
      console.log(`[migrate:${target}] applying ${migration.version}_${migration.name}…`);
      if (migration.noTransaction) {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name, hash) VALUES ($1, $2, $3)',
          [migration.version, migration.name, migration.hash],
        );
      } else {
        try {
          await client.query('BEGIN');
          await client.query(migration.sql);
          await client.query(
            'INSERT INTO schema_migrations (version, name, hash) VALUES ($1, $2, $3)',
            [migration.version, migration.name, migration.hash],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
    }

    console.log(`[migrate:${target}] applied ${pending.length} migration(s)`);
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY.toString()]);
    } finally {
      await client.end();
    }
  }
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
