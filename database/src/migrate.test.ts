import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import pg from 'pg';

import { loadMigrations, run } from './migrate.ts';

// Reference hashes computed independently with `shasum -a 256` on the exact bytes.
const CREATE_WIDGETS_SQL = '-- 1700000000_create_widgets\nCREATE TABLE widgets (id INT);\n';
const CREATE_WIDGETS_HASH = 'e3fe111512df9c626a78e6c5bed21a97c94b32506a038eb9d0a7c48f6a821655';
const NO_TRANSACTION_SQL = '-- migrate:no-transaction\nSELECT 1;\n';
const NO_TRANSACTION_HASH = 'edd22faa497de670fb4c0112c8822519889fa1e838f5793ce32f3f1958b01989';
// A BOM followed by an invalid UTF-8 byte: the hash covers the raw bytes, not a
// decoded string (decoding would replace 0xFF by U+FFFD).
const RAW_BYTES = Buffer.from([0xef, 0xbb, 0xbf, 0x2d, 0x2d, 0x20, 0xff, 0x0a]);
const RAW_BYTES_HASH = '73c55541d4076b2915bd83efd1f9497d03d3dc288b245b8360afb2b91b973d5f';

test('loadMigrations reads the files in version order with the hash of their raw bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ename-migrations-'));
  try {
    await writeFile(join(directory, '1700000001_second.sql'), NO_TRANSACTION_SQL);
    await writeFile(join(directory, '1700000000_create_widgets.sql'), CREATE_WIDGETS_SQL);
    await writeFile(join(directory, '1700000002_raw.sql'), RAW_BYTES);
    await writeFile(join(directory, 'notes.md'), 'ignored');

    const migrations = await loadMigrations(directory);

    assert.deepEqual(migrations, [
      {
        version: '1700000000_create_widgets',
        name: 'create_widgets',
        sql: CREATE_WIDGETS_SQL,
        hash: CREATE_WIDGETS_HASH,
        noTransaction: false,
      },
      {
        version: '1700000001_second',
        name: 'second',
        sql: NO_TRANSACTION_SQL,
        hash: NO_TRANSACTION_HASH,
        noTransaction: true,
      },
      {
        version: '1700000002_raw',
        name: 'raw',
        sql: RAW_BYTES.toString('utf-8'),
        hash: RAW_BYTES_HASH,
        noTransaction: false,
      },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('run applies the pending migrations in order and records them once', async () => {
  await withFixture(async ({ client, directory }) => {
    await writeFile(join(directory, '1700000000_create_widgets.sql'), CREATE_WIDGETS_SQL);
    await writeFile(
      join(directory, '1700000001_add_name.sql'),
      'ALTER TABLE widgets ADD COLUMN name TEXT;\n',
    );

    const first = await run(client, directory);
    assert.deepEqual(first, {
      applied: ['1700000000_create_widgets', '1700000001_add_name'],
      skipped: [],
    });

    const second = await run(client, directory);
    assert.deepEqual(second, { applied: [], skipped: [] });

    assert.deepEqual(await appliedVersions(client), [
      { version: '1700000000_create_widgets', name: 'create_widgets', hash: CREATE_WIDGETS_HASH },
      {
        version: '1700000001_add_name',
        name: 'add_name',
        hash: 'fd7354623b644a2475bfb7bd7c576b64c9f5d5b9b18029fcb6204d39f9cde879',
      },
    ]);
    const columns = await client.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'widgets' ORDER BY 1",
    );
    assert.deepEqual(
      columns.rows.map((row) => row.column_name),
      ['id', 'name'],
    );
  });
});

test('run refuses a migration modified after being applied, before applying anything', async () => {
  await withFixture(async ({ client, directory }) => {
    const path = join(directory, '1700000000_create_widgets.sql');
    await writeFile(path, CREATE_WIDGETS_SQL);
    await run(client, directory);

    await writeFile(path, CREATE_WIDGETS_SQL + '-- a comment added after the fact\n');
    await writeFile(
      join(directory, '1700000001_add_name.sql'),
      'ALTER TABLE widgets ADD COLUMN name TEXT;\n',
    );

    await assert.rejects(run(client, directory), {
      message: /1700000000_create_widgets.*modified/,
    });
    assert.deepEqual(
      (await appliedVersions(client)).map((row) => row.version),
      ['1700000000_create_widgets'],
    );
  });
});

test('run refuses when an applied migration has no file on disk', async () => {
  await withFixture(async ({ client, directory }) => {
    const path = join(directory, '1700000000_create_widgets.sql');
    await writeFile(path, CREATE_WIDGETS_SQL);
    await run(client, directory);

    await rm(path);
    await writeFile(
      join(directory, '1700000001_add_name.sql'),
      'ALTER TABLE widgets ADD COLUMN name TEXT;\n',
    );

    await assert.rejects(run(client, directory), {
      message: /1700000000_create_widgets.*no file on disk/,
    });
    assert.deepEqual(
      (await appliedVersions(client)).map((row) => row.version),
      ['1700000000_create_widgets'],
    );
  });
});

test('a no-transaction migration runs outside any transaction', async () => {
  await withFixture(async ({ client, directory }) => {
    await writeFile(join(directory, '1700000000_create_widgets.sql'), CREATE_WIDGETS_SQL);
    // CREATE INDEX CONCURRENTLY is refused inside a transaction block.
    await writeFile(
      join(directory, '1700000001_index_widgets.sql'),
      '-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS widgets_id_idx ON widgets (id);\n',
    );

    const report = await run(client, directory);

    assert.deepEqual(report.applied, ['1700000000_create_widgets', '1700000001_index_widgets']);
    const indexes = await client.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'widgets'",
    );
    assert.deepEqual(
      indexes.rows.map((row) => row.indexname),
      ['widgets_id_idx'],
    );
  });
});

test('a failing migration is rolled back and not recorded', async () => {
  await withFixture(async ({ client, directory }) => {
    await writeFile(join(directory, '1700000000_create_widgets.sql'), CREATE_WIDGETS_SQL);
    await writeFile(
      join(directory, '1700000001_broken.sql'),
      'ALTER TABLE widgets ADD COLUMN name TEXT;\nSELECT * FROM no_such_table;\n',
    );

    await assert.rejects(run(client, directory), { message: /no_such_table/ });

    assert.deepEqual(
      (await appliedVersions(client)).map((row) => row.version),
      ['1700000000_create_widgets'],
    );
    const columns = await client.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'widgets'",
    );
    assert.deepEqual(
      columns.rows.map((row) => row.column_name),
      ['id'],
    );
    // The connection is usable after the rollback.
    await client.query('SELECT 1');
  });
});

test('two concurrent runners converge: each migration is applied exactly once', async () => {
  await withFixture(async ({ client, directory, databaseUrl }) => {
    const versions: string[] = [];
    for (let i = 0; i < 5; i++) {
      const version = `170000000${i}_step_${i}`;
      versions.push(version);
      // pg_sleep widens the window in which the other runner can catch up.
      await writeFile(
        join(directory, `${version}.sql`),
        `CREATE TABLE step_${i} (id INT);\nSELECT pg_sleep(0.05);\n`,
      );
    }
    const other = new pg.Client({ connectionString: databaseUrl });
    await other.connect();
    try {
      const [first, second] = await Promise.all([run(client, directory), run(other, directory)]);

      assert.deepEqual([...first.applied, ...first.skipped].sort(), versions);
      assert.deepEqual([...second.applied, ...second.skipped].sort(), versions);
      assert.deepEqual([...first.applied, ...second.applied].sort(), versions);
      assert.deepEqual(
        (await appliedVersions(client)).map((row) => row.version),
        versions,
      );
    } finally {
      await other.end();
    }
  });
});

interface Fixture {
  client: pg.Client;
  databaseUrl: string;
  directory: string;
}

// One throwaway database and one empty migrations directory per test: the
// runner creates, breaks and replays migrations, so it never shares ename_test
// with the backend suite. The database is created on the cluster of
// DATABASE_URL and dropped afterwards.
async function withFixture(body: (fixture: Fixture) => Promise<void>): Promise<void> {
  const clusterUrl = process.env['DATABASE_URL'];
  if (!clusterUrl) throw new Error('DATABASE_URL is not set');

  const databaseName = `ename_migrate_test_${randomUUID().replaceAll('-', '')}`;
  const maintenance = new pg.Client({ connectionString: clusterUrl });
  await maintenance.connect();
  await maintenance.query(`CREATE DATABASE "${databaseName}"`);

  const databaseUrl = new URL(clusterUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const client = new pg.Client({ connectionString: databaseUrl.href });
  await client.connect();

  const directory = await mkdtemp(join(tmpdir(), 'ename-migrations-'));
  try {
    await body({ client, databaseUrl: databaseUrl.href, directory });
  } finally {
    await client.end();
    await maintenance.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await maintenance.end();
    await rm(directory, { recursive: true, force: true });
  }
}

async function appliedVersions(client: pg.Client) {
  const result = await client.query<{ version: string; name: string; hash: string }>(
    'SELECT version, name, hash FROM schema_migrations ORDER BY version',
  );
  return result.rows;
}
