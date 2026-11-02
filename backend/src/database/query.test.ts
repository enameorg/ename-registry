import { strict as assert } from 'node:assert';
import { randomInt } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import pg from 'pg';
import { pino } from 'pino';
import { z, ZodError } from 'zod';

import { config } from '../config.ts';
import { generateUUIDv7 } from '../utilities/uuid.ts';

import { isUnavailability, UnavailableError } from './errors.ts';
import { pool } from './pool.ts';
import { type Database, queryRows, withTransaction } from './query.ts';
import { useTestDatabase } from './testing.ts';

// Executable specification of the query helpers: withTransaction's nesting, a transaction on the
// pool and a savepoint on a transaction's client, then the translation of a database that does not
// answer (cf. ename-internals.md). The platforms table, which references no other, is only a target
// for rows; raw SQL keeps this test inside src/database/. Inside a block, `db` shadows the outer
// one on purpose: the block's statements run on the block's handle.
const logger = pino({ level: 'silent' });

useTestDatabase();

// ---------------------------------------------------------------------------
// Transaction nesting
// ---------------------------------------------------------------------------

// A row of its own: a random nine-digit identifier, since a platform's registration is UNIQUE and a
// test inserts several rows.
async function insertRow(db: Database): Promise<void> {
  const registrationIdentifier = String(randomInt(1, 1_000_000_000)).padStart(9, '0');
  await db.query(
    `INSERT INTO platforms
       (id, legal_name, jurisdiction, registration_authority_code, registration_identifier, created_at)
     VALUES ($1, 'TEST', 'FR', 'RA000189', $2, $3)`,
    [generateUUIDv7(), registrationIdentifier, new Date()],
  );
}

async function countRows(): Promise<number> {
  const result = await pool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM platforms',
  );
  return result.rows[0]?.count ?? -1;
}

test('a nested block that fails is rolled back to its savepoint, rethrows its own error, and the enclosing transaction goes on', async () => {
  const failure = new Error('nested failure');

  await withTransaction(
    pool,
    async (db) => {
      await insertRow(db);
      await assert.rejects(
        () =>
          withTransaction(
            db,
            async (db) => {
              await insertRow(db);
              throw failure;
            },
            logger,
          ),
        (error: unknown) => error === failure,
      );
      await insertRow(db);
    },
    logger,
  );

  assert.equal(await countRows(), 2);
});

test('a nested block that succeeds is released and committed with the enclosing transaction', async () => {
  await withTransaction(
    pool,
    async (db) => {
      await insertRow(db);
      await withTransaction(db, (db) => insertRow(db), logger);
    },
    logger,
  );

  assert.equal(await countRows(), 2);
});

test('an enclosing transaction that fails after a successful nested block rolls everything back', async () => {
  await assert.rejects(
    () =>
      withTransaction(
        pool,
        async (db) => {
          await withTransaction(db, (db) => insertRow(db), logger);
          await insertRow(db);
          throw new Error('outer failure');
        },
        logger,
      ),
    /outer failure/,
  );

  assert.equal(await countRows(), 0);
});

test('an enclosing transaction that fails after a contained nested failure rolls everything back', async () => {
  await assert.rejects(
    () =>
      withTransaction(
        pool,
        async (db) => {
          await insertRow(db);
          await withTransaction(
            db,
            async (db) => {
              await insertRow(db);
              throw new Error('nested failure');
            },
            logger,
          ).catch(() => undefined);
          throw new Error('outer failure');
        },
        logger,
      ),
    /outer failure/,
  );

  assert.equal(await countRows(), 0);
});

test('sibling nested blocks follow one another in the same transaction, a failed one then a successful one, down to a third level', async () => {
  await withTransaction(
    pool,
    async (db) => {
      await withTransaction(
        db,
        async (db) => {
          await insertRow(db);
          throw new Error('first sibling fails');
        },
        logger,
      ).catch(() => undefined);
      await withTransaction(
        db,
        async (db) => {
          await insertRow(db);
          await withTransaction(db, (db) => insertRow(db), logger);
        },
        logger,
      );
    },
    logger,
  );

  assert.equal(await countRows(), 2);
});

// ---------------------------------------------------------------------------
// Unavailability
// ---------------------------------------------------------------------------

// A database that does not answer surfaces from the helpers as an UnavailableError whose cause is
// the error pg raised; any other failure surfaces as pg raised it. Each case produces the real
// error, on a pool of the test's own (never the singleton), so a pg upgrade that changes one fails
// here. Local TCP servers stand in for a host that never answers or drops the connection.

const ValueSchema = z.object({ value: z.number() });

// A local server on a free port; closing it destroys the sockets it holds.
async function listen(
  onConnection: (socket: Socket) => void,
): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    onConnection(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return {
    port: address.port,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

// Whether `error` is an UnavailableError whose cause satisfies `cause`.
function isUnavailableBecause(cause: (error: Error) => boolean) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof UnavailableError, `not an UnavailableError: ${String(error)}`);
    assert.ok(error.cause instanceof Error);
    assert.ok(cause(error.cause), `unexpected cause: ${error.cause.message}`);
    return true;
  };
}

function hasCode(code: string) {
  return (error: Error) => (error as { code?: unknown }).code === code;
}

function hasMessage(message: string) {
  return (error: Error) => error.message === message;
}

test('a refused connection is an UnavailableError, through queryRows and withTransaction', async () => {
  const { port, close } = await listen(() => undefined);
  await close();
  const refused = new pg.Pool({ host: 'localhost', port, connectionTimeoutMillis: 1_000 });

  try {
    await assert.rejects(
      () => queryRows(refused, 'SELECT 1 AS value', [], ValueSchema),
      isUnavailableBecause(hasCode('ECONNREFUSED')),
    );
    await assert.rejects(
      () => withTransaction(refused, () => Promise.resolve(), logger),
      isUnavailableBecause(hasCode('ECONNREFUSED')),
    );
  } finally {
    await refused.end();
  }
});

test('a host that never answers is an UnavailableError once the connection times out', async () => {
  const { port, close } = await listen(() => undefined);
  const silent = new pg.Pool({ host: '127.0.0.1', port, connectionTimeoutMillis: 100 });

  try {
    await assert.rejects(
      () => withTransaction(silent, () => Promise.resolve(), logger),
      isUnavailableBecause(hasMessage('Connection terminated due to connection timeout')),
    );
  } finally {
    await silent.end();
    await close();
  }
});

test('a connection the host closes is an UnavailableError', async () => {
  const { port, close } = await listen((socket) => socket.end());
  const dropping = new pg.Pool({ host: '127.0.0.1', port, connectionTimeoutMillis: 1_000 });

  try {
    await assert.rejects(
      () => queryRows(dropping, 'SELECT 1 AS value', [], ValueSchema),
      isUnavailableBecause(hasMessage('Connection terminated unexpectedly')),
    );
  } finally {
    await dropping.end();
    await close();
  }
});

test('a saturated pool is an UnavailableError once the wait for a connection times out', async () => {
  const saturated = new pg.Pool({
    connectionString: config.databaseURL,
    max: 1,
    connectionTimeoutMillis: 100,
  });
  const held = await saturated.connect();

  try {
    await assert.rejects(
      () => queryRows(saturated, 'SELECT 1 AS value', [], ValueSchema),
      isUnavailableBecause(hasMessage('timeout exceeded when trying to connect')),
    );
  } finally {
    held.release();
    await saturated.end();
  }
});

test('a server that answers nothing within the read timeout is an UnavailableError', async () => {
  const slow = new pg.Pool({ connectionString: config.databaseURL, query_timeout: 100 });

  try {
    await assert.rejects(
      () => queryRows(slow, 'SELECT pg_sleep(0.5) AS value', [], z.unknown()),
      isUnavailableBecause(hasMessage('Query read timeout')),
    );
  } finally {
    await slow.end();
  }
});

// The server ends the connection under a running statement: the statement fails, with 57P01 or with
// the closed socket depending on which pg reads first; once the socket is gone, the next statement
// finds the client unusable; and the process survives the connection's error event.
test('a connection terminated mid-transaction is an UnavailableError, statement after statement', async () => {
  const own = new pg.Pool({ connectionString: config.databaseURL });

  try {
    await assert.rejects(
      () =>
        withTransaction(
          own,
          async (db) => {
            const [backend] = await queryRows(
              db,
              'SELECT pg_backend_pid() AS pid',
              [],
              z.object({ pid: z.number() }),
            );
            assert.ok(backend);
            // Inside a transaction, db is the transaction's client.
            const ended = new Promise((resolve) => (db as pg.PoolClient).once('end', resolve));
            const sleeping = queryRows(db, 'SELECT pg_sleep(5) AS value', [], z.unknown());
            await waitUntilActive(backend.pid);
            await pool.query('SELECT pg_terminate_backend($1)', [backend.pid]);

            await assert.rejects(
              () => sleeping,
              isUnavailableBecause(
                (error) =>
                  hasCode('57P01')(error) ||
                  hasMessage('Connection terminated unexpectedly')(error),
              ),
            );
            await ended;
            await assert.rejects(
              () => queryRows(db, 'SELECT 1 AS value', [], ValueSchema),
              isUnavailableBecause(
                hasMessage('Client has encountered a connection error and is not queryable'),
              ),
            );
          },
          logger,
        ),
      (error: unknown) => error instanceof UnavailableError,
    );
  } finally {
    await own.end();
  }
});

async function waitUntilActive(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query<{ active: boolean }>(
      "SELECT state = 'active' AS active FROM pg_stat_activity WHERE pid = $1",
      [pid],
    );
    if (result.rows[0]?.active === true) return;
    await sleep(20);
  }
  assert.fail(`backend ${pid} never became active`);
}

test('the SQLSTATEs of a server that refuses or drops the connection are an unavailability, and only those', () => {
  const withCode = (code: string) =>
    Object.assign(new pg.DatabaseError('server error', 0, 'error'), { code });

  for (const code of ['08006', '08001', '57P01', '57P02', '57P03', '53300']) {
    assert.equal(isUnavailability(withCode(code)), true, code);
  }
  for (const code of ['57014', '53100', '53200', '23505', '42601']) {
    assert.equal(isUnavailability(withCode(code)), false, code);
  }
});

test('a failure of a database that answered surfaces as pg or Zod raised it', async () => {
  await insertRow(pool);
  const [row] = await queryRows(
    pool,
    'SELECT registration_identifier AS value FROM platforms',
    [],
    z.object({ value: z.string() }),
  );
  assert.ok(row);

  // A unique violation, a statement canceled by statement_timeout, a parameter pg cannot serialize,
  // and a row the schema refuses.
  await assert.rejects(
    () =>
      pool.query(
        `INSERT INTO platforms
           (id, legal_name, jurisdiction, registration_authority_code, registration_identifier, created_at)
         VALUES ($1, 'TEST', 'FR', 'RA000189', $2, $3)`,
        [generateUUIDv7(), row.value, new Date()],
      ),
    hasCode('23505'),
  );
  await assert.rejects(
    () =>
      withTransaction(
        pool,
        async (db) => {
          await queryRows(
            db,
            "SELECT set_config('statement_timeout', '50', true)",
            [],
            z.unknown(),
          );
          await queryRows(db, 'SELECT pg_sleep(1) AS value', [], z.unknown());
        },
        logger,
      ),
    (error: unknown) => !(error instanceof UnavailableError) && hasCode('57014')(error as Error),
  );
  const circular: Record<string, unknown> = {};
  circular['self'] = circular;
  await assert.rejects(
    () => queryRows(pool, 'SELECT $1::jsonb AS value', [circular], z.unknown()),
    (error: unknown) => error instanceof Error && !(error instanceof UnavailableError),
  );
  await assert.rejects(
    () => queryRows(pool, 'SELECT 1 AS value', [], z.object({ value: z.string() })),
    (error: unknown) => error instanceof ZodError,
  );
});
