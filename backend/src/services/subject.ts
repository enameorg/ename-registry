import { isDeepStrictEqual } from 'node:util';

import type { PoolClient } from 'pg';
import type { Logger } from 'pino';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';

import { pool } from '../database/pool.ts';
import { queryRows, withTransaction } from '../database/query.ts';
import { UUIDV7_REGEX } from '../uuid.ts';

import { IdempotencyConflictError, ValidationError } from './errors.ts';

const MAX_TOTAL_LENGTH = 52;
// Number of allowed retry attempts when the (name_part, number_part) UNIQUE
// constraint fires inside the SAVEPOINT loop. Under READ COMMITTED, two
// concurrent transactions can read the same MAX(number_part) and race to
// insert the same value; each round of collisions eliminates roughly one
// contender, so the budget caps the supported burst of concurrent inserts
// on a single name_part. 20 covers a comfortably pessimistic real-world
// burst; beyond that the request fails loud (500) and the client may retry.
const MAX_NUMBER_PART_RETRIES = 20;
const ENAMES_NUMBER_PART_CONSTRAINT = 'enames_name_part_number_part_key';
const EVENTS_IDEMPOTENCY_KEY_CONSTRAINT = 'events_idempotency_key_key';

// ---------------------------------------------------------------------------
// Payload and row schemas
// ---------------------------------------------------------------------------

// Inner shape of the `events.payload` JSONB column for kind = 'subject.registered'.
// (`subject.registered` is the v1 kind emitted by this endpoint;
// `subject.ename_added` will be emitted by the future
// POST /api/v1/subjects/{id}/enames endpoint and gets its own payload schema.)
// Domain-shaped (entity blocks), no projection-table mirroring, camelCase end
// to end. `created_at` lives in the `events.created_at` column, not in the
// payload (cf. ename-internals.md § events table).
const SubjectRegisteredPayloadSchema = z.object({
  subject: z.object({
    id: z.string().regex(UUIDV7_REGEX),
    kind: z.literal('person'),
  }),
  ename: z.object({
    id: z.string().regex(UUIDV7_REGEX),
    namePart: z.string(),
    numberPart: z.number().int().positive(),
  }),
});

type SubjectRegisteredPayload = z.infer<typeof SubjectRegisteredPayloadSchema>;

// Permissive row for the preliminary idempotency lookup: we want to decide
// whether the existing event is a replay of this same operation or a kind
// collision (409) WITHOUT requiring the payload to match this endpoint's
// expected shape. The kind is checked first; the payload is parsed against
// `SubjectRegisteredPayloadSchema` only when the kind matches.
const ExistingEventRowSchema = z.object({
  payload: z.unknown(),
  createdAt: z.date(),
  kind: z.string(),
});

// Row shape for `INSERT enames ... RETURNING number_part`. The pg driver
// returns BIGINT as a string by default — `z.coerce.number()` accepts both
// the string form and a real number, and keeps validation honest about the
// declared range (CHECK on the DB side is 1..999_999_999_999).
const NumberPartRowSchema = z.object({
  numberPart: z.coerce.number().int().min(1).max(999_999_999_999),
});

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

// Domain-shaped input: entity blocks (`subject`, `ename`) mirror the event
// payload, the response shape, and the public API request body. Same shape
// at the request boundary, the service signature, the event payload and the
// service result — no impedance mismatch between layers.
export type RegisterSubjectInput = {
  idempotencyKey: string;
  subject: { kind: 'person' };
  ename: { namePart: string };
};

export type RegisterSubjectResult = {
  createdAt: Date;
  subject: { id: string; kind: 'person' };
  ename: { id: string; namePart: string; numberPart: number };
};

export type ServiceContext = {
  logger: Logger;
};

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

// Sentinel used to signal a 23505 on `events.idempotency_key` from inside the
// transaction up to the outer reconciliation block. Never escapes this file.
class IdempotencyRaceError extends Error {
  public override readonly name = 'IdempotencyRaceError';
  constructor() {
    super('idempotency race');
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (!(error instanceof Error)) return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === '23505' && candidate.constraint === constraint;
}

function payloadToResult(
  payload: SubjectRegisteredPayload,
  createdAt: Date,
): RegisterSubjectResult {
  return {
    createdAt,
    subject: { id: payload.subject.id, kind: payload.subject.kind },
    ename: {
      id: payload.ename.id,
      namePart: payload.ename.namePart,
      numberPart: payload.ename.numberPart,
    },
  };
}

async function findEventByIdempotencyKey(
  idempotencyKey: string,
): Promise<z.infer<typeof ExistingEventRowSchema> | undefined> {
  const rows = await queryRows(
    pool,
    'SELECT payload, created_at, kind FROM events WHERE idempotency_key = $1',
    [idempotencyKey],
    ExistingEventRowSchema,
  );
  return rows[0];
}

// Map a discovered existing event to either a replay result (same operation,
// return the prior response) or an IdempotencyConflictError (different
// operation, surface as 409).
//
// Error messages are intentionally generic: they describe the situation to
// the client without echoing internal vocabulary (event kinds, column names).
// The technical specifics — which kind was actually stored, which field
// differed — are logged so operators can correlate via `requestId`.
function reconcileReplay(
  existing: z.infer<typeof ExistingEventRowSchema>,
  input: RegisterSubjectInput,
  logger: Logger,
): RegisterSubjectResult {
  if (existing.kind !== 'subject.registered') {
    logger.info(
      { existingKind: existing.kind, expectedKind: 'subject.registered' },
      'idempotency conflict: existing event has a different kind',
    );
    throw new IdempotencyConflictError(
      'this idempotency key has already been used for a different operation',
    );
  }
  const payload = SubjectRegisteredPayloadSchema.parse(existing.payload);
  // Structural equality between the input's entity blocks and the payload's
  // entity blocks. Field-by-field equality (`payload.subject.kind === ...`)
  // would be a whitelist that silently breaks the idempotency contract
  // (same key + different body → same response) the day a new field is
  // added to `RegisterSubjectInput` without updating this comparison.
  // Here we reconstruct the payload that THIS input would have produced —
  // re-using the server-allocated fields from the existing payload — and
  // deep-equal the whole shape. Adding a field to the input automatically
  // participates in the equality; the only list to maintain is the small
  // set of server-allocated fields spread on the expected side
  // (subject.id, ename.id, ename.numberPart).
  const expectedPayload = {
    subject: { ...input.subject, id: payload.subject.id },
    ename: { ...input.ename, id: payload.ename.id, numberPart: payload.ename.numberPart },
  };
  if (!isDeepStrictEqual(expectedPayload, payload)) {
    logger.info(
      {
        existing: payload,
        requested: { subject: input.subject, ename: input.ename },
      },
      'idempotency conflict: existing event has a different request body',
    );
    throw new IdempotencyConflictError(
      'this idempotency key has already been used with a different request body',
    );
  }
  return payloadToResult(payload, existing.createdAt);
}

// INSERT the ename with the next number_part for the given name_part. The
// number is computed atomically inside the INSERT via COALESCE(MAX(...), 0)+1.
// Two concurrent backends can pick the same MAX, so we protect each attempt
// with a SAVEPOINT and retry on 23505 — the already-inserted subject row
// survives across attempts.
async function insertEnameWithNextNumber(
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

// ---------------------------------------------------------------------------
// Public use case
// ---------------------------------------------------------------------------

// Register a new subject and its first ename atomically.
//
// Emits one `subject.registered` event in the log (the subject and its first
// ename are created atomically — a subject without an ename has no meaning in
// the registry), and projects one row each
// into `subjects` and `enames`. Idempotent via `input.idempotencyKey`: a
// retry with the same key returns the original result; a retry with a
// different body raises `IdempotencyConflictError` (mapped to 409 by the
// API layer).
//
// Algorithm (cf. docs/ename-internals.md):
//   1. Preliminary SELECT on events.idempotency_key (outside transaction).
//      Found → reconcile (replay or conflict). Not found → proceed.
//   2. Generate UUIDv7 ids and a single createdAt (propagated to all three
//      INSERTs and to the event payload — required for deterministic
//      projection-by-replay).
//   3. BEGIN, INSERT subjects.
//   4. INSERT enames with COALESCE(MAX(number_part), 0) + 1, under a
//      SAVEPOINT, retry on UNIQUE collision.
//   5. Enforce the 52-char total length on the resulting ename.
//   6. INSERT events. On UNIQUE collision on idempotency_key (race between
//      step 1 and step 6), rollback and reconcile from the winner's row.
//   7. COMMIT, return.
export async function registerSubject(
  input: RegisterSubjectInput,
  context: ServiceContext,
): Promise<RegisterSubjectResult> {
  const { logger } = context;

  // Step 1 — preliminary idempotency lookup.
  const existing = await findEventByIdempotencyKey(input.idempotencyKey);
  if (existing) {
    logger.info(
      { idempotencyKey: input.idempotencyKey, outcome: 'replay' },
      'idempotency replay detected at preliminary lookup',
    );
    return reconcileReplay(existing, input, logger);
  }

  // Step 2 — capture identity + timestamp once.
  const subjectId = uuidv7();
  const enameId = uuidv7();
  const createdAt = new Date();

  // Convenience locals — avoid repeating `input.subject.kind` and
  // `input.ename.namePart` throughout the transaction body.
  const { kind } = input.subject;
  const { namePart } = input.ename;

  try {
    return await withTransaction(
      pool,
      async (client) => {
        // Step 3 — INSERT subjects.
        await client.query('INSERT INTO subjects (id, kind, created_at) VALUES ($1, $2, $3)', [
          subjectId,
          kind,
          createdAt,
        ]);

        // Step 4 — INSERT enames with retry.
        const numberPart = await insertEnameWithNextNumber(
          client,
          { enameId, subjectId, namePart, createdAt },
          logger,
        );

        // Step 5 — 52-char guard. Depends on numberPart so cannot live in Zod
        // input validation. Raised as a domain error to be mapped to 422.
        // The public detail stays generic; arithmetic specifics go to the log
        // (correlatable by `requestId`).
        const numberPartDigits = String(numberPart).length;
        const totalLength = namePart.length + 1 + numberPartDigits;
        if (totalLength > MAX_TOTAL_LENGTH) {
          logger.warn(
            {
              namePartLength: namePart.length,
              numberPart,
              numberPartDigits,
              totalLength,
              maxTotalLength: MAX_TOTAL_LENGTH,
            },
            '52-char overflow on ename creation',
          );
          throw new ValidationError(
            `the resulting ename would exceed the ${MAX_TOTAL_LENGTH}-character limit; choose a shorter namePart`,
            [
              {
                path: ['ename', 'namePart'],
                message: `namePart is too long: combined with the next available numberPart it would exceed ${MAX_TOTAL_LENGTH} characters`,
              },
            ],
          );
        }

        // Step 6 — INSERT events. The payload is built now that numberPart
        // is known. A 23505 on idempotency_key signals a race against another
        // backend that won between step 1 and here; we rollback and reconcile
        // from outside.
        const payload: SubjectRegisteredPayload = {
          subject: { id: subjectId, kind },
          ename: { id: enameId, namePart, numberPart },
        };

        try {
          await client.query(
            `INSERT INTO events (idempotency_key, kind, payload, created_at)
           VALUES ($1, $2, $3, $4)`,
            [input.idempotencyKey, 'subject.registered', payload, createdAt],
          );
        } catch (error) {
          if (isUniqueViolation(error, EVENTS_IDEMPOTENCY_KEY_CONSTRAINT)) {
            throw new IdempotencyRaceError();
          }
          throw error;
        }

        return payloadToResult(payload, createdAt);
      },
      logger,
    );
  } catch (error) {
    if (error instanceof IdempotencyRaceError) {
      logger.info(
        { idempotencyKey: input.idempotencyKey },
        'idempotency race detected at events insert, reconciling from winner',
      );
      const winner = await findEventByIdempotencyKey(input.idempotencyKey);
      if (!winner) {
        // Pathological: the constraint fired but the row is no longer
        // visible (concurrent ROLLBACK between our INSERT-fail and this
        // SELECT). Surface loud — we cannot decide the outcome.
        throw new Error('idempotency race: conflicting event not found on reconcile');
      }
      return reconcileReplay(winner, input, logger);
    }
    throw error;
  }
}
