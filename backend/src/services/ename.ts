import type { PoolClient } from 'pg';
import type { Logger } from 'pino';
import { z } from 'zod';

import { isUniqueViolation } from '../database/errors.ts';
import { pool } from '../database/pool.ts';
import { queryRows } from '../database/query.ts';
import { UUIDV7_REGEX } from '../uuid.ts';

import { ValidationError } from './errors.ts';

// ---------------------------------------------------------------------------
// Ename format constants and shared regex
// ---------------------------------------------------------------------------

// `namePart` grammar per ename-format v0.7: lowercase letters and hyphens
// only, no leading/trailing/consecutive hyphens, at least one letter. The
// single regex expresses the grammar in one pass — clearer and faster than
// a cascade of `.refine()` calls. Shared across layers so API validation,
// docs, and any future endpoint that creates enames all agree on the same
// rule.
//
// Source string without flags so callers can attach it as-is to OpenAPI
// `pattern` fields via Zod's `.regex(NAME_PART_REGEX).openapi(...)` without
// leaking flag delimiters into the generated JSON Schema.
export const NAME_PART_REGEX = /^[a-z]+(-[a-z]+)*$/;

// `namePart` length cap per ename-format v0.7. The `min(1)` side stays
// inline as standard Zod idiom (non-empty); the 50 is a domain-specific
// number that deserves a name.
export const MAX_NAME_PART_LENGTH = 50;

// Upper bound for `numberPart`. Mirrors the `enames_number_part_range`
// CHECK constraint (1..999_999_999_999). Stays well under 2^53 so JSON
// `integer` round-trips losslessly through `number`.
export const MAX_NUMBER_PART = 999_999_999_999;

// Shared Zod sub-schema for a `numberPart` field as it appears on DB rows
// and in event outcomes stored as JSONB. Centralizes the (min, max, integer,
// coerce) chain so the projection schema (`EnameSchema`), the
// INSERT-RETURNING row schema, and the persisted event outcome schema
// (`SubjectRegisteredOutcomeSchema` in subject.ts) all agree on the same
// validation — keeping the read path no laxer than the write path.
//
// `z.coerce` accepts both string and number: BIGINT columns come back as
// strings from the `pg` driver, while JSONB-parsed numbers come back as
// `number`. The API response schema uses a non-coerce variant since the
// wire is JSON and we control the serializer.
export const NumberPartFieldSchema = z.coerce.number().int().min(1).max(MAX_NUMBER_PART);

// 52-character total budget on `<namePart>#<numberPart>`. Enforced after
// `numberPart` allocation because the digit count is not known at request
// time. Public constant: surfaced in error messages and in the documented
// API contract.
export const MAX_ENAME_LENGTH = 52;

// Number of allowed retry attempts when the (name_part, number_part) UNIQUE
// constraint fires inside the SAVEPOINT loop. Under READ COMMITTED, two
// concurrent transactions can read the same MAX(number_part) and race to
// insert the same value; each round of collisions eliminates roughly one
// contender, so the budget caps the supported burst of concurrent inserts
// on a single name_part. 20 covers a comfortably pessimistic real-world
// burst; beyond that the request fails loud (500) and the client may retry.
const MAX_NUMBER_PART_RETRIES = 20;

const ENAMES_NUMBER_PART_CONSTRAINT = 'enames_name_part_number_part_key';

// ---------------------------------------------------------------------------
// Ename domain type and lookups
// ---------------------------------------------------------------------------

// Domain-shaped Ename. Mirrors the `enames` projection table. `numberPart`
// is BIGINT on the DB side; see `NumberPartFieldSchema` above for the
// (coerce, range) chain used here and across every other consumer.
export const EnameSchema = z.object({
  id: z.string().regex(UUIDV7_REGEX),
  subjectId: z.string().regex(UUIDV7_REGEX),
  namePart: z.string(),
  numberPart: NumberPartFieldSchema,
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

// ---------------------------------------------------------------------------
// Insertion helpers and post-allocation guard
// ---------------------------------------------------------------------------

// Row shape for `INSERT enames ... RETURNING number_part`.
const NumberPartRowSchema = z.object({
  numberPart: NumberPartFieldSchema,
});

// INSERT the ename with the next number_part for the given name_part. The
// number is computed atomically inside the INSERT via COALESCE(MAX(...), 0)+1.
// Two concurrent backends can pick the same MAX, so we protect each attempt
// with a SAVEPOINT and retry on 23505 — the surrounding transaction's other
// INSERTs (e.g. the subjects row) survive across attempts.
export async function insertEnameWithNextNumber(
  client: PoolClient,
  params: {
    enameId: string;
    subjectId: string;
    namePart: string;
    createdAt: Date;
  },
  logger: Logger,
): Promise<number> {
  for (let attempt = 1; attempt <= MAX_NUMBER_PART_RETRIES; attempt += 1) {
    await client.query('SAVEPOINT ename_attempt');
    try {
      const rows = await queryRows(
        client,
        `INSERT INTO enames (id, subject_id, name_part, number_part, created_at)
         SELECT $1, $2, $3, COALESCE(MAX(number_part), 0) + 1, $4
         FROM enames WHERE name_part = $3
         RETURNING number_part`,
        [params.enameId, params.subjectId, params.namePart, params.createdAt],
        NumberPartRowSchema,
      );
      const row = rows[0];
      if (!row) {
        // Unreachable in practice: an INSERT ... RETURNING that succeeds
        // always returns one row. Defensive against a future SQL refactor.
        // Thrown BEFORE RELEASE SAVEPOINT so the catch's ROLLBACK targets a
        // still-existing savepoint — releasing first would make the rollback
        // fail with "no such savepoint" and mask the real error.
        throw new Error('insert enames returned no row');
      }
      await client.query('RELEASE SAVEPOINT ename_attempt');
      return row.numberPart;
    } catch (error) {
      // Same defensive pattern as `withTransaction`: a SAVEPOINT rollback
      // failure (typically a dead connection or an already-aborted txn)
      // must not mask the original INSERT error.
      try {
        await client.query('ROLLBACK TO SAVEPOINT ename_attempt');
      } catch (rollbackError) {
        logger.error(
          { err: rollbackError, namePart: params.namePart, attempt },
          'rollback to savepoint failed; original error will be re-thrown',
        );
      }
      if (isUniqueViolation(error, ENAMES_NUMBER_PART_CONSTRAINT)) {
        logger.warn(
          { namePart: params.namePart, attempt },
          'number_part collision on enames insert, retrying',
        );
        continue;
      }
      throw error;
    }
  }
  throw new Error(
    `failed to allocate number_part for namePart=${params.namePart} after ${MAX_NUMBER_PART_RETRIES} attempts`,
  );
}

// Enforce the 52-character total budget on `<namePart>#<numberPart>`.
// Cannot live in Zod input validation because the digit count of `numberPart`
// is only known after server-side allocation. Throws `ValidationError` so
// the API layer maps it to 422; the public detail stays generic, while the
// arithmetic specifics are logged (correlatable by `requestId`).
export function enforceMaxEnameLength(
  params: { namePart: string; numberPart: number },
  logger: Logger,
): void {
  const numberPartDigits = String(params.numberPart).length;
  const totalLength = params.namePart.length + 1 + numberPartDigits;
  if (totalLength > MAX_ENAME_LENGTH) {
    logger.warn(
      {
        namePartLength: params.namePart.length,
        numberPart: params.numberPart,
        numberPartDigits,
        totalLength,
        maxEnameLength: MAX_ENAME_LENGTH,
      },
      `${MAX_ENAME_LENGTH}-char overflow on ename creation`,
    );
    throw new ValidationError(
      `the resulting ename would exceed the ${MAX_ENAME_LENGTH}-character limit; choose a shorter namePart`,
      [
        {
          path: ['ename', 'namePart'],
          message: `namePart is too long: combined with the next available numberPart it would exceed ${MAX_ENAME_LENGTH} characters`,
        },
      ],
    );
  }
}
