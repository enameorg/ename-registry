import type { PoolClient } from 'pg';
import { z } from 'zod';

import { pool } from '../../database/pool.ts';
import { queryRows } from '../../database/query.ts';
import { UUIDV7_REGEX } from '../../uuid.ts';

// ---------------------------------------------------------------------------
// Subject domain type and lookups
// ---------------------------------------------------------------------------

// Domain-shaped Subject. Mirrors the `subjects` projection table.
export const SubjectSchema = z.object({
  id: z.string().regex(UUIDV7_REGEX),
  kind: z.literal('person'),
  createdAt: z.date(),
});

export type Subject = z.infer<typeof SubjectSchema>;

const SELECT_SUBJECT_COLUMNS = 'id, kind, created_at';

export async function getSubject(id: string): Promise<Subject | undefined> {
  const rows = await queryRows(
    pool,
    `SELECT ${SELECT_SUBJECT_COLUMNS} FROM subjects WHERE id = $1`,
    [id],
    SubjectSchema,
  );
  return rows[0];
}

// Ordered by (created_at, id): deterministic; id (UUIDv7) breaks ties on
// equal created_at.
export async function findSubjects(): Promise<Subject[]> {
  return await queryRows(
    pool,
    `SELECT ${SELECT_SUBJECT_COLUMNS} FROM subjects ORDER BY created_at, id`,
    [],
    SubjectSchema,
  );
}

// ---------------------------------------------------------------------------
// Insertion helper
// ---------------------------------------------------------------------------

// Thin wrapper for symmetry with insertEnameWithNextNumber / insertEvent:
// each table's write lives in the concept that owns it, even when trivial.
export async function insertSubject(
  client: PoolClient,
  params: { id: string; kind: 'person'; createdAt: Date },
): Promise<void> {
  await client.query('INSERT INTO subjects (id, kind, created_at) VALUES ($1, $2, $3)', [
    params.id,
    params.kind,
    params.createdAt,
  ]);
}
