import type { Logger } from 'pino';
import { z } from 'zod';

import {
  isCheckViolation,
  isForeignKeyViolation,
  isUniqueViolation,
} from '../../database/errors.ts';
import { type Database, queryRows, withTransaction } from '../../database/query.ts';
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

// Derived from the 52-character ename budget of docs/ename-format.md:
// 52 minus `#` minus the shortest numberPart, one digit.
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

// 52-char total budget on <namePart>#<numberPart>, mirroring the
// enames_total_length CHECK. The digit count of numberPart is only known once
// allocated, so the database enforces the budget on the row and the allocation
// translates the violation (see insertEnameWithNextNumber).
const MAX_ENAME_LENGTH = 52;

// Retry budget when the (name_part, number_part) UNIQUE constraint fires in the
// allocation loop. Under READ COMMITTED two transactions can read the same
// MAX(number_part) and race; each collision round eliminates ~one contender, so
// the budget caps the concurrent burst on a single name_part. Beyond it, the
// allocation gives up with a retryable ContentionError (503 + Retry-After) and
// the client retries with the same idempotency key.
const MAX_NUMBER_PART_RETRIES = 20;

const ENAMES_NUMBER_PART_CONSTRAINT = 'enames_name_part_number_part_key';
const ENAMES_SUBJECT_NAME_PART_CONSTRAINT = 'enames_subject_id_name_part_key';
const ENAMES_SUBJECT_ID_CONSTRAINT = 'enames_subject_id_fkey';
const ENAMES_TOTAL_LENGTH_CONSTRAINT = 'enames_total_length';

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

export async function getEnameByNamePartAndNumberPart(
  db: Database,
  params: { namePart: string; numberPart: number },
): Promise<Ename | undefined> {
  const rows = await queryRows(
    db,
    `SELECT ${SELECT_ENAME_COLUMNS} FROM enames WHERE name_part = $1 AND number_part = $2`,
    [params.namePart, params.numberPart],
    EnameSchema,
  );
  return rows[0];
}

// Ordered by (created_at, id): deterministic; id (UUIDv7) breaks ties on
// equal created_at.
export async function findEnames(db: Database): Promise<Ename[]> {
  return await queryRows(
    db,
    `SELECT ${SELECT_ENAME_COLUMNS} FROM enames ORDER BY created_at, id`,
    [],
    EnameSchema,
  );
}

// ---------------------------------------------------------------------------
// Insertion helpers
// ---------------------------------------------------------------------------

// Row shape for `INSERT enames ... RETURNING number_part`.
const NumberPartRowSchema = z.object({
  numberPart: NumberPartSchema,
});

// INSERT the ename with the next number_part for this name_part, computed
// atomically via COALESCE(MAX(...), 0)+1. Two backends can pick the same MAX,
// so each attempt runs in a nested withTransaction — a savepoint inside the
// caller's transaction, whose other writes survive across attempts — and the
// 23505 is retried. Returns a numberPart whose full ename fits the 52-char
// budget, or throws the domain error the violated constraint translates to.
export async function insertEnameWithNextNumber(
  db: Database,
  params: {
    enameId: string;
    subjectId: string;
    namePart: string;
    createdAt: Date;
  },
  logger: Logger,
): Promise<number> {
  for (let attempt = 1; attempt <= MAX_NUMBER_PART_RETRIES; attempt += 1) {
    try {
      return await withTransaction(db, (db) => insertEnameOnce(db, params), logger);
    } catch (error) {
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
      if (isCheckViolation(error, ENAMES_TOTAL_LENGTH_CONSTRAINT)) {
        // The next numberPart has one digit too many for this namePart (→ 422).
        // Specifics to the log; the thrown message stays client-safe.
        logger.warn(
          { namePart: params.namePart, namePartLength: params.namePart.length },
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

// One attempt: the INSERT and its RETURNING, raw — every error reaches the
// retry loop above, which rolls the attempt back through withTransaction and
// translates or retries.
async function insertEnameOnce(
  db: Database,
  params: { enameId: string; subjectId: string; namePart: string; createdAt: Date },
): Promise<number> {
  const rows = await queryRows(
    db,
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
    // row); defensive against a future refactor.
    throw new Error('insert enames returned no row');
  }
  return row.numberPart;
}
