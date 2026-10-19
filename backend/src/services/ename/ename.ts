import type { PoolClient } from 'pg';
import type { Logger } from 'pino';
import { z } from 'zod';

import { isForeignKeyViolation, isUniqueViolation } from '../../database/errors.ts';
import { pool } from '../../database/pool.ts';
import { queryRows } from '../../database/query.ts';
import { UUIDv7Schema } from '../../utilities/uuid.ts';
import { ConflictError, ContentionError, NotFoundError, ValidationError } from '../errors.ts';

// ---------------------------------------------------------------------------
// Ename format rules
// ---------------------------------------------------------------------------

// namePart grammar per docs/ename-format.md: lowercase letters and single hyphens,
// no leading/trailing/consecutive hyphens, at least one letter.
//
// No regex flags: the OpenAPI generator derives `pattern` from the regex source,
// and a flag would not carry over into the generated JSON Schema.
const NAME_PART_REGEX = /^[a-z]+(-[a-z]+)*$/;

// namePart length cap per docs/ename-format.md.
const MAX_NAME_PART_LENGTH = 50;

// The namePart grammar as a pure schema: the single definition of the rule and
// of its client-facing message. The HTTP body, the event request and the
// projection row all parse a namePart through it; the API layer wraps it with
// its OpenAPI example rather than re-assembling it (cf. ename-internals.md).
export const NamePartSchema = z.string().min(1).max(MAX_NAME_PART_LENGTH).regex(NAME_PART_REGEX, {
  message:
    'must be lowercase letters separated by single hyphens (no leading, trailing or consecutive hyphens)',
});

// Upper bound for numberPart, mirroring the enames_number_part_range CHECK
// (1..999_999_999_999). Well under 2^53, so it round-trips as a JSON integer.
export const MAX_NUMBER_PART = 999_999_999_999;

// Shared numberPart sub-schema (DB rows + event outcome JSONB). Centralizing
// the (coerce, int, min, max) chain keeps the read path no laxer than the write
// path. z.coerce accepts both string and number: BIGINT comes back as a string
// from pg, JSONB as a number. The API response schema uses a non-coerce variant
// (the wire is JSON, we control the serializer).
export const NumberPartSchema = z.coerce.number().int().min(1).max(MAX_NUMBER_PART);

// 52-char total budget on <namePart>#<numberPart>. Enforced after numberPart
// allocation, since the digit count isn't known at request time.
export const MAX_ENAME_LENGTH = 52;

// Retry budget when the (name_part, number_part) UNIQUE constraint fires in the
// SAVEPOINT loop. Under READ COMMITTED two transactions can read the same
// MAX(number_part) and race; each collision round eliminates ~one contender, so
// the budget caps the concurrent burst on a single name_part. Beyond it, the
// allocation gives up with a retryable ContentionError (503 + Retry-After) and
// the client retries with the same idempotency key.
const MAX_NUMBER_PART_RETRIES = 20;

const ENAMES_NUMBER_PART_CONSTRAINT = 'enames_name_part_number_part_key';
const ENAMES_SUBJECT_NAME_PART_CONSTRAINT = 'enames_subject_id_name_part_key';
const ENAMES_SUBJECT_ID_CONSTRAINT = 'enames_subject_id_fkey';

// ---------------------------------------------------------------------------
// Ename domain type and lookups
// ---------------------------------------------------------------------------

// Domain-shaped Ename, mirroring the enames projection. numberPart is BIGINT on
// the DB side; see NumberPartSchema above for the chain.
export const EnameSchema = z.object({
  id: UUIDv7Schema,
  subjectId: UUIDv7Schema,
  namePart: NamePartSchema,
  numberPart: NumberPartSchema,
  createdAt: z.date(),
});

export type Ename = z.infer<typeof EnameSchema>;

const SELECT_ENAME_COLUMNS = 'id, subject_id, name_part, number_part, created_at';

export async function getEnameByNamePartAndNumberPart(params: {
  namePart: string;
  numberPart: number;
}): Promise<Ename | undefined> {
  const rows = await queryRows(
    pool,
    `SELECT ${SELECT_ENAME_COLUMNS} FROM enames WHERE name_part = $1 AND number_part = $2`,
    [params.namePart, params.numberPart],
    EnameSchema,
  );
  return rows[0];
}

// Ordered by (created_at, id): deterministic; id (UUIDv7) breaks ties on
// equal created_at.
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
  numberPart: NumberPartSchema,
});

// INSERT the ename with the next number_part for this name_part, computed
// atomically via COALESCE(MAX(...), 0)+1. Two backends can pick the same MAX,
// so each attempt runs under a SAVEPOINT and retries on 23505 — the surrounding
// transaction's other INSERTs survive across attempts.
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
        // Unreachable in practice (a successful INSERT ... RETURNING returns a
        // row); defensive against a future refactor. Thrown BEFORE RELEASE
        // SAVEPOINT so the catch's ROLLBACK targets a still-existing savepoint.
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
      if (isUniqueViolation(error, ENAMES_SUBJECT_NAME_PART_CONSTRAINT)) {
        logger.info(
          { subjectId: params.subjectId, namePart: params.namePart },
          'subject already has an ename with this name_part',
        );
        throw new ConflictError('This subject already has an ename with this namePart.');
      }
      if (isForeignKeyViolation(error, ENAMES_SUBJECT_ID_CONSTRAINT)) {
        logger.info({ subjectId: params.subjectId }, 'subject not found while inserting ename');
        throw new NotFoundError('Subject not found.');
      }
      throw error;
    }
  }
  // Budget exhausted: a transient capacity condition, not a server fault —
  // a retryable ContentionError (→ 503), not a raw 500. Specifics to the log
  // (correlatable by requestId); the thrown message stays client-safe.
  logger.warn(
    { namePart: params.namePart, attempts: MAX_NUMBER_PART_RETRIES },
    'number_part allocation retry budget exhausted under contention',
  );
  throw new ContentionError(
    'Too many concurrent ename creations for this name right now; please retry shortly.',
  );
}

// Enforce the 52-char total budget on <namePart>#<numberPart>. Can't live in
// Zod input validation: numberPart's digit count is only known after
// allocation. Throws ValidationError (→ 422); specifics are logged, the public
// detail stays generic.
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
      `The resulting ename would exceed the ${MAX_ENAME_LENGTH}-character limit; choose a shorter namePart.`,
      [
        {
          path: ['ename', 'namePart'],
          message: `namePart is too long: combined with the next available numberPart it would exceed ${MAX_ENAME_LENGTH} characters`,
        },
      ],
    );
  }
}
