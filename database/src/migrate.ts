import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type pg from 'pg';

// Forward-only migration runner over <unix_ts>_<name>.sql files. The
// schema_migrations table and the hash are the contract the Rust
// reimplementation honors (cf. ename-internals.md, ADR-0009).
//
// Invariants:
//   1. schema_migrations stores a SHA-256 of each file's raw bytes, comments
//      included. An applied migration is frozen, content and presence: an
//      edited, deleted or renamed file is detected and the run refuses to apply
//      anything. No re-hash.
//   2. One transaction per migration, holding a transaction-level advisory
//      lock (pg_advisory_xact_lock) under which the migration is re-checked as
//      still pending: overlapping runners serialize and converge instead of
//      failing. A session-level lock around the whole run is not an option:
//      Serverless SQL pools connections per transaction, so such a lock stays
//      on one server connection while the next statements run on others.
//   3. A file starting with `-- migrate:no-transaction` (e.g. CREATE INDEX
//      CONCURRENTLY) runs outside any transaction, hence without the lock or
//      the rollback.
//   4. Lexicographic order on filename (the Unix-timestamp prefix is stable
//      across machines).
//   5. Single connection, sequential — no parallelism.
//   6. No `down` command and no down files: a local rollback is a database reset.

const ADVISORY_LOCK_KEY = 9_876_543_210n;

export interface Migration {
  version: string;
  name: string;
  sql: string;
  hash: string;
  noTransaction: boolean;
}

export interface AppliedMigration {
  version: string;
  name: string;
  hash: string;
}

export interface IntegrityReport {
  // Applied versions whose file on disk no longer hashes to the recorded hash.
  modified: string[];
  // Applied versions with no file on disk (deleted, or renamed).
  missing: string[];
}

export interface RunReport {
  applied: string[];
  // Versions another runner applied between this run's pending computation and
  // its own attempt.
  skipped: string[];
}

// Apply every pending migration of the directory on the given connection and
// report what this run did. The connection is the caller's: the runner neither
// opens nor closes it, and it uses it sequentially.
export async function run(client: pg.Client, migrationsDirectory: string): Promise<RunReport> {
  await bootstrap(client);

  const appliedResult = await client.query<AppliedMigration>(
    'SELECT version, name, hash FROM schema_migrations',
  );
  const applied = appliedResult.rows;
  const migrations = await loadMigrations(migrationsDirectory);

  const integrity = verifyApplied(migrations, applied);
  if (integrity.modified.length > 0 || integrity.missing.length > 0) {
    throw new Error(describeIntegrityFailure(integrity));
  }

  const appliedVersions = new Set(applied.map((row) => row.version));
  const pending = migrations.filter((migration) => !appliedVersions.has(migration.version));

  const report: RunReport = { applied: [], skipped: [] };
  for (const migration of pending) {
    const appliedHere = migration.noTransaction
      ? await applyWithoutTransaction(client, migration)
      : await applyInTransaction(client, migration);
    (appliedHere ? report.applied : report.skipped).push(migration.version);
  }
  return report;
}

// Create the bookkeeping table under the same lock as the migrations: two
// runners racing on an empty database would otherwise collide on CREATE TABLE
// IF NOT EXISTS (a unique violation in pg_type).
async function bootstrap(client: pg.Client): Promise<void> {
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
}

// Read every `<version>.sql` of the directory, in lexicographic order of
// filename (the Unix-timestamp prefix is stable across machines). The hash is a
// SHA-256 of the file's raw bytes, comments included; only the SQL text is
// decoded, and the decoding never feeds the hash.
export async function loadMigrations(migrationsDirectory: string): Promise<Migration[]> {
  let entries: string[];
  try {
    entries = await readdir(migrationsDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const files = entries.filter((entry) => entry.endsWith('.sql')).sort();
  const migrations: Migration[] = [];

  for (const filename of files) {
    const version = filename.slice(0, -'.sql'.length);
    const separatorIndex = version.indexOf('_');
    const name = separatorIndex === -1 ? version : version.slice(separatorIndex + 1);
    const bytes = await readFile(resolve(migrationsDirectory, filename));
    const sql = bytes.toString('utf-8');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const noTransaction = /^\s*--\s*migrate:no-transaction\b/m.test(sql);
    migrations.push({ version, name, sql, hash, noTransaction });
  }

  return migrations;
}

// Confront the applied migrations with the files on disk. A migration is
// frozen byte for byte once applied (ADR-0009), and that freeze covers its
// presence: an applied version whose file was edited, deleted or renamed is
// reported, and the run refuses to apply anything.
export function verifyApplied(
  migrations: Migration[],
  applied: AppliedMigration[],
): IntegrityReport {
  const onDisk = new Map(migrations.map((migration) => [migration.version, migration]));
  const report: IntegrityReport = { modified: [], missing: [] };
  for (const row of applied) {
    const migration = onDisk.get(row.version);
    if (!migration) {
      report.missing.push(row.version);
    } else if (migration.hash !== row.hash) {
      report.modified.push(row.version);
    }
  }
  return report;
}

function describeIntegrityFailure(integrity: IntegrityReport): string {
  const lines = [
    'Applied migrations are frozen; the files on disk no longer match schema_migrations.',
  ];
  for (const version of integrity.modified) {
    lines.push(`  ${version}: modified after being applied`);
  }
  for (const version of integrity.missing) {
    lines.push(`  ${version}: applied but no file on disk (deleted or renamed)`);
  }
  lines.push('Restore the files, or reset a local database (npm run db:reset).');
  return lines.join('\n');
}

// Apply one migration in its own transaction, under the transaction-level
// advisory lock. Returns false when another runner applied it between our
// pending computation and our lock acquisition: overlapping runners serialize
// and converge. The PRIMARY KEY on version is the hard guarantee — a double
// apply fails on the INSERT and its DDL rolls back with it.
async function applyInTransaction(client: pg.Client, migration: Migration): Promise<boolean> {
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [ADVISORY_LOCK_KEY.toString()]);
    if (await isApplied(client, migration.version)) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(migration.sql);
    await record(client, migration);
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

// A `-- migrate:no-transaction` migration (e.g. CREATE INDEX CONCURRENTLY)
// runs outside any transaction, hence without the lock or the rollback. The
// re-check refreshes the pending computation but cannot close the window: such
// a migration must be idempotent, and the runner launched by a single job at a
// time.
async function applyWithoutTransaction(client: pg.Client, migration: Migration): Promise<boolean> {
  if (await isApplied(client, migration.version)) return false;
  await client.query(migration.sql);
  await record(client, migration);
  return true;
}

async function isApplied(client: pg.Client, version: string): Promise<boolean> {
  const result = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [
    version,
  ]);
  return (result.rowCount ?? 0) > 0;
}

async function record(client: pg.Client, migration: Migration): Promise<void> {
  await client.query('INSERT INTO schema_migrations (version, name, hash) VALUES ($1, $2, $3)', [
    migration.version,
    migration.name,
    migration.hash,
  ]);
}
