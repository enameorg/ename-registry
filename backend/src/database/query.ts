import pg, { type Pool, type PoolClient, type QueryConfig, type QueryResult } from 'pg';
import type { Logger } from 'pino';
import type { z } from 'zod';

import { isUnavailability, UnavailableError } from './errors.ts';

// What every function that talks to the database receives: the pool outside a transaction, the
// transaction's client inside one. The union exposes only what both share (running a statement), so
// a callee can neither check out nor release a connection; Pool and PoolClient themselves stay
// inside src/database/.
export type Database = Pool | PoolClient;

// Open levels per connection: 1 once BEGIN ran, one more per nested block. The depth names the
// savepoint, so each level targets its own and never an enclosing one, and the set of statement
// texts stays bounded. Kept on the connection (a WeakMap keyed by the client, released with it),
// the way sqlx and Django track transaction depth — not a process-wide counter.
const transactionDepths = new WeakMap<PoolClient, number>();

export async function queryRows<T>(
  db: Database,
  sql: string,
  params: readonly unknown[],
  schema: z.ZodType<T>,
): Promise<T[]> {
  const result = await execute(db, sql, params);
  return result.rows.map((row: Record<string, unknown>) => schema.parse(camelize(row)));
}

// Run `work` atomically. On a Pool, that is a transaction on a connection checked out for its
// duration; on a PoolClient — which only ever exists inside such a transaction — it is a savepoint,
// so a nested withTransaction is contained: its failure rolls back to the savepoint, rethrows the
// original error, and leaves the enclosing transaction usable (cf. ename-internals.md).
export async function withTransaction<T>(
  db: Database,
  work: (db: Database) => Promise<T>,
  logger: Logger,
): Promise<T> {
  if (db instanceof pg.Pool) {
    return await runTransaction(db, work, logger);
  }
  return await runSavepoint(db, work, logger);
}

async function runTransaction<T>(
  pool: Pool,
  work: (db: Database) => Promise<T>,
  logger: Logger,
): Promise<T> {
  const client = await connect(pool);
  // pg-pool removes its error listener from a client it hands out, and pg emits 'error' when the
  // connection drops: without a listener of our own, a connection lost mid-transaction would crash
  // the process. The statement in flight, or the next one, already rejects with the failure.
  const onConnectionLost = (error: Error) => {
    logger.warn({ err: error }, 'transaction connection lost');
  };
  client.on('error', onConnectionLost);
  try {
    await execute(client, 'BEGIN');
    transactionDepths.set(client, 1);
    const result = await work(client);
    await execute(client, 'COMMIT');
    return result;
  } catch (error) {
    // Wrap the ROLLBACK in its own try/catch so a rollback failure (typically a dead connection:
    // network drop, server-side idle-in-transaction kill, or a COMMIT that itself rejected) does
    // NOT mask the original error. The original cause is what the operator needs to see; the
    // rollback failure is incidental and goes to the log with full pino context.
    try {
      await execute(client, 'ROLLBACK');
    } catch (rollbackError) {
      logger.error(
        { err: rollbackError },
        'transaction rollback failed; original error will be re-thrown',
      );
    }
    throw error;
  } finally {
    transactionDepths.delete(client);
    client.removeListener('error', onConnectionLost);
    client.release();
  }
}

async function runSavepoint<T>(
  client: PoolClient,
  work: (db: Database) => Promise<T>,
  logger: Logger,
): Promise<T> {
  const enclosingDepth = transactionDepths.get(client) ?? 1;
  const depth = enclosingDepth + 1;
  // Interpolated, not a placeholder: SAVEPOINT takes no parameter, and the name is built from the
  // depth, never from input.
  const savepoint = `savepoint_${depth - 1}`;
  await execute(client, `SAVEPOINT ${savepoint}`);
  transactionDepths.set(client, depth);
  try {
    const result = await work(client);
    await execute(client, `RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    // Same rule as the transaction: the cleanup never masks the original error. ROLLBACK TO keeps
    // the savepoint, so it is released afterwards: the level leaves nothing open behind it, and a
    // loop of failed blocks stays flat.
    try {
      await execute(client, `ROLLBACK TO SAVEPOINT ${savepoint}`);
      await execute(client, `RELEASE SAVEPOINT ${savepoint}`);
    } catch (rollbackError) {
      logger.error(
        { err: rollbackError, savepoint },
        'rollback to savepoint failed; original error will be re-thrown',
      );
    }
    throw error;
  } finally {
    transactionDepths.set(client, enclosingDepth);
  }
}

// Trivial round trip to the database, bounded by a per-query read timeout (pg honors
// `query_timeout` on a query config at runtime; @types/pg omits it, hence the widened type).
// Rejects on any failure, the timeout included, an unavailability as an UnavailableError; the
// caller decides what that means.
export async function pingDatabase(db: Database, timeoutMs: number): Promise<void> {
  const probe: QueryConfig & { query_timeout: number } = {
    text: 'SELECT 1',
    query_timeout: timeoutMs,
  };
  await execute(db, probe);
}

// Every statement the helpers send, and every connection they check out, goes through these two, so
// an unavailability always surfaces as an UnavailableError and any other failure as pg raised it.
async function execute(
  db: Database,
  statement: string | QueryConfig,
  params: readonly unknown[] = [],
): Promise<QueryResult> {
  try {
    // Cast: `pg`'s `.query` takes a mutable `unknown[]`; our public signature exposes
    // `readonly unknown[]` to discourage callers from mutating shared arrays. `pg` does not mutate
    // the array, so the cast is sound.
    return typeof statement === 'string'
      ? await db.query(statement, params as unknown[])
      : await db.query(statement);
  } catch (error) {
    throw translateUnavailability(error);
  }
}

async function connect(pool: Pool): Promise<PoolClient> {
  try {
    return await pool.connect();
  } catch (error) {
    throw translateUnavailability(error);
  }
}

function translateUnavailability(error: unknown): unknown {
  return isUnavailability(error) ? new UnavailableError({ cause: error }) : error;
}

// Convert snake_case keys (DB convention) to camelCase (JS/TS convention) at the boundary, so
// service code never sees snake_case. No reverse conversion: pg passes parameters positionally
// ($1, $2), so column names only appear in raw SQL.
function camelize(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    const camelKey = key.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase());
    out[camelKey] = row[key];
  }
  return out;
}
