import type { Pool, PoolClient } from 'pg';
import type { Logger } from 'pino';
import type { z } from 'zod';

export async function queryRows<T>(
  db: Pool | PoolClient,
  sql: string,
  params: readonly unknown[],
  schema: z.ZodType<T>,
): Promise<T[]> {
  // Cast: `pg`'s `.query` takes a mutable `unknown[]`; our public signature
  // exposes `readonly unknown[]` to discourage callers from mutating shared
  // arrays. `pg` does not mutate the array, so the cast is sound.
  const result = await db.query(sql, params as unknown[]);
  return result.rows.map((row: Record<string, unknown>) => schema.parse(camelize(row)));
}

export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  logger: Logger,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    // Wrap the ROLLBACK in its own try/catch so a rollback failure (typically
    // a dead connection: network drop, server-side idle-in-transaction kill,
    // or a COMMIT that itself rejected) does NOT mask the original error.
    // The original cause is what the operator needs to see; the rollback
    // failure is incidental and goes to the log with full pino context.
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      logger.error(
        { err: rollbackError },
        'transaction rollback failed; original error will be re-thrown',
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

// Convert snake_case keys (DB convention) to camelCase (JS/TS convention) at the
// boundary, so service code never sees snake_case. No reverse conversion: pg
// passes parameters positionally ($1, $2), so column names only appear in raw SQL.
function camelize(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    const camelKey = key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
    out[camelKey] = row[key];
  }
  return out;
}
