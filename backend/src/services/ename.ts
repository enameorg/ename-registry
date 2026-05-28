import { z } from 'zod';

import { pool } from '../database/pool.ts';
import { queryRows } from '../database/query.ts';
import { UUIDV7_REGEX } from '../uuid.ts';

// Domain-shaped Ename. Mirrors the `enames` projection table.
//
// `numberPart` is BIGINT on the DB side (1..999_999_999_999); the pg driver
// returns BIGINT as a string by default. `z.coerce.number()` accepts both the
// string form and a real number and keeps validation honest about the declared
// range. Upper bound matches the CHECK constraint in the schema.
export const EnameSchema = z.object({
  id: z.string().regex(UUIDV7_REGEX),
  subjectId: z.string().regex(UUIDV7_REGEX),
  namePart: z.string(),
  numberPart: z.coerce.number().int().min(1).max(999_999_999_999),
  createdAt: z.date(),
});

export type Ename = z.infer<typeof EnameSchema>;

const SELECT_ENAME_COLUMNS = 'id, subject_id, name_part, number_part, created_at';

export async function getEname(namePart: string, numberPart: number): Promise<Ename | undefined> {
  const rows = await queryRows(
    pool,
    `SELECT ${SELECT_ENAME_COLUMNS} FROM enames WHERE name_part = $1 AND number_part = $2`,
    [namePart, numberPart],
    EnameSchema,
  );
  return rows[0];
}

// Returns enames ordered by `(created_at, id)` — deterministic for tests and
// for any admin listing. `id` is a UUIDv7 so it provides a stable tiebreaker
// for rows with the same `created_at` (e.g. created inside the same
// transaction).
export async function findEnames(): Promise<Ename[]> {
  return await queryRows(
    pool,
    `SELECT ${SELECT_ENAME_COLUMNS} FROM enames ORDER BY created_at, id`,
    [],
    EnameSchema,
  );
}
