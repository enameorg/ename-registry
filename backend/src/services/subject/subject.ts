import { z } from 'zod';

import { type Database, queryRows } from '../../database/query.ts';
import { UUIDv7Schema } from '../../utilities/uuid.ts';

// ---------------------------------------------------------------------------
// Subject kind rule
// ---------------------------------------------------------------------------

// The kinds of subject the registry admits, as a pure schema: the single
// declaration of the rule. The projection row, the input a client submits, the
// insert and the use-case result all derive from it, and the API wraps it with
// its OpenAPI example (cf. ename-internals.md). A natural person is the only
// kind today; organizations are [Q-ORG] in ename-synthesis.md. The
// subjects_kind_allowed CHECK holds the same list, so a new kind lands with a
// migration, not here alone; subject.test.ts pins that the two agree.
export const SubjectKindSchema = z.enum(['person']);

export type SubjectKind = z.infer<typeof SubjectKindSchema>;

// ---------------------------------------------------------------------------
// Subject domain type and lookups
// ---------------------------------------------------------------------------

// Domain-shaped Subject. Mirrors the `subjects` projection table.
export const SubjectSchema = z.object({
  id: UUIDv7Schema,
  kind: SubjectKindSchema,
  createdAt: z.date(),
});

export type Subject = z.infer<typeof SubjectSchema>;

// What a client submits for a subject, declared once and strict: the event kinds
// compose these schemas into their request, the API wraps them in place as its
// OpenAPI components (cf. ename-internals.md). An unknown field fails here, at the
// seam that stores the request, never stripped.
export const SubjectInputSchema = z.strictObject({
  kind: SubjectKindSchema,
});

// Names an existing subject by id alone: what an operation that acts on a
// subject without creating it carries.
export const SubjectReferenceSchema = z.strictObject({
  id: UUIDv7Schema,
});

const SELECT_SUBJECT_COLUMNS = 'id, kind, created_at';

export async function getSubject(db: Database, id: string): Promise<Subject | undefined> {
  const rows = await queryRows(
    db,
    `SELECT ${SELECT_SUBJECT_COLUMNS} FROM subjects WHERE id = $1`,
    [id],
    SubjectSchema,
  );
  return rows[0];
}

// Ordered by (created_at, id): deterministic; id (UUIDv7) breaks ties on
// equal created_at.
export async function findSubjects(db: Database): Promise<Subject[]> {
  return await queryRows(
    db,
    `SELECT ${SELECT_SUBJECT_COLUMNS} FROM subjects ORDER BY created_at, id`,
    [],
    SubjectSchema,
  );
}

// ---------------------------------------------------------------------------
// Insertion helper
// ---------------------------------------------------------------------------

// Each table's write lives in the concept that owns it, even when trivial.
// Returns the row as the database wrote it, so a caller never reassembles it
// from the parameters.
export async function insertSubject(
  db: Database,
  params: { id: string; kind: SubjectKind; createdAt: Date },
): Promise<Subject> {
  const rows = await queryRows(
    db,
    `INSERT INTO subjects (id, kind, created_at) VALUES ($1, $2, $3)
     RETURNING ${SELECT_SUBJECT_COLUMNS}`,
    [params.id, params.kind, params.createdAt],
    SubjectSchema,
  );
  const row = rows[0];
  if (!row) {
    // Unreachable in practice (a successful INSERT ... RETURNING returns a
    // row); defensive against a future refactor.
    throw new Error('insert subjects returned no row');
  }
  return row;
}
