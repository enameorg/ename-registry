import { isDeepStrictEqual } from 'node:util';

import type { PoolClient } from 'pg';
import type { Logger } from 'pino';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';

import { pool } from '../database/pool.ts';
import { queryRows, withTransaction } from '../database/query.ts';
import { UUIDV7_REGEX } from '../uuid.ts';

import type { ServiceContext } from './context.ts';
import {
  enforceMaxEnameLength,
  insertEnameWithNextNumber,
  NumberPartFieldSchema,
} from './ename.ts';
import { IdempotencyConflictError } from './errors.ts';
import {
  type Event,
  getEventByIdempotencyKey,
  IdempotencyRaceError,
  insertEvent,
} from './event.ts';

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

// Returns subjects ordered by `(created_at, id)` — deterministic for tests and
// for any admin listing. `id` is a UUIDv7 so it provides a stable tiebreaker
// for rows sharing the same `created_at`.
export async function findSubjects(): Promise<Subject[]> {
  return await queryRows(
    pool,
    `SELECT ${SELECT_SUBJECT_COLUMNS} FROM subjects ORDER BY created_at, id`,
    [],
    SubjectSchema,
  );
}

// INSERT one subject row. Thin wrapper kept for symmetry with
// `insertEnameWithNextNumber` and `insertEvent`: each table's write
// belongs to the service that owns the table, even when the SQL is a
// one-liner.
async function insertSubject(
  client: PoolClient,
  params: { id: string; kind: 'person'; createdAt: Date },
): Promise<void> {
  await client.query('INSERT INTO subjects (id, kind, created_at) VALUES ($1, $2, $3)', [
    params.id,
    params.kind,
    params.createdAt,
  ]);
}

// ---------------------------------------------------------------------------
// `subject.registered` event payload schema
// ---------------------------------------------------------------------------

// Inner shape of the `events.payload` JSONB column for kind = 'subject.registered'.
// (`subject.registered` is the v1 kind emitted by this endpoint;
// `subject.ename_added` will be emitted by the future
// POST /api/v1/subjects/{id}/enames endpoint and gets its own payload schema.)
// Domain-shaped (entity blocks), no projection-table mirroring, camelCase end
// to end. `created_at` lives in the `events.created_at` column, not in the
// payload (cf. ename-internals.md § events table).
//
// Exported so consumers of the generic `findEvents()` / `getEventByIdempotencyKey()`
// can narrow to this kind and parse the payload. The Event type in `./event.ts`
// keeps `payload: unknown` because the table holds heterogeneous kinds.
export const SubjectRegisteredPayloadSchema = z.object({
  subject: z.object({
    id: z.string().regex(UUIDV7_REGEX),
    kind: z.literal('person'),
  }),
  ename: z.object({
    id: z.string().regex(UUIDV7_REGEX),
    namePart: z.string(),
    // Uses the same (min, max, integer, coerce) chain as the projection
    // schema so a payload re-parsed from the event log cannot pass a
    // `numberPart` that the original INSERT would have rejected.
    numberPart: NumberPartFieldSchema,
  }),
});

type SubjectRegisteredPayload = z.infer<typeof SubjectRegisteredPayloadSchema>;

// ---------------------------------------------------------------------------
// registerSubject — public types
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

// ---------------------------------------------------------------------------
// registerSubject — internals
// ---------------------------------------------------------------------------

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

// Map a discovered existing event to either a replay result (same operation,
// return the prior response) or an IdempotencyConflictError (different
// operation, surface as 409).
//
// Error messages are intentionally generic: they describe the situation to
// the client without echoing internal vocabulary (event kinds, column names).
// The technical specifics — which kind was actually stored, which field
// differed — are logged so operators can correlate via `requestId`.
function reconcileReplay(
  existing: Event,
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

// ---------------------------------------------------------------------------
// registerSubject — public use case
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
  const existing = await getEventByIdempotencyKey(input.idempotencyKey);
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
        await insertSubject(client, { id: subjectId, kind, createdAt });

        // Step 4 — INSERT enames with retry.
        const numberPart = await insertEnameWithNextNumber(
          client,
          { enameId, subjectId, namePart, createdAt },
          logger,
        );

        // Step 5 — 52-char guard. Depends on numberPart so cannot live in
        // Zod input validation. Throws ValidationError (→ 422).
        enforceMaxEnameLength({ namePart, numberPart }, logger);

        // Step 6 — INSERT events. A 23505 on idempotency_key signals a race
        // against another backend that won between step 1 and here;
        // `insertEvent` raises `IdempotencyRaceError` and we reconcile
        // from outside the transaction.
        const payload: SubjectRegisteredPayload = {
          subject: { id: subjectId, kind },
          ename: { id: enameId, namePart, numberPart },
        };
        await insertEvent(client, {
          idempotencyKey: input.idempotencyKey,
          kind: 'subject.registered',
          payload,
          createdAt,
        });

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
      const winner = await getEventByIdempotencyKey(input.idempotencyKey);
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
