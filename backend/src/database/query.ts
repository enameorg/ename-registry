import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';

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

export async function queryRows<T>(
  db: Pool | PoolClient,
  sql: string,
  params: readonly unknown[],
  schema: z.ZodType<T>,
): Promise<T[]> {
  const result = await db.query(sql, params as unknown[]);
  return result.rows.map((row: Record<string, unknown>) => schema.parse(camelize(row)));
}

export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
