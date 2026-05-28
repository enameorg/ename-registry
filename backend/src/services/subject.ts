import { isDeepStrictEqual } from 'node:util';

import type { PoolClient } from 'pg';
import type { Logger } from 'pino';
import { z } from 'zod';

import { pool } from '../database/pool.ts';
import { queryRows, withTransaction } from '../database/query.ts';
import { generateUUIDv7, UUIDV7_REGEX } from '../uuid.ts';

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
// `subject.registered` event request + outcome schemas
// ---------------------------------------------------------------------------

// Inner shapes of the `events.request` and `events.outcome` JSONB columns for
// kind = 'subject.registered'. (`subject.registered` is the v1 kind emitted by
// this endpoint; `subject.ename_added` will be emitted by the future
// POST /api/v1/subjects/{id}/enames endpoint and gets its own pair of schemas.)
// Domain-shaped (entity blocks), no projection-table mirroring, camelCase end
// to end. `created_at` and `idempotency_key` live in their own columns, not in
// these JSONB blobs (cf. ename-internals.md § events table).
//
// The split between request and outcome materializes the boundary between
// what the actor submits (and what the future layer-1 signature will cover)
// and what the server allocates (covered separately by the layer-2 signed
// tree head). For `subject.registered` specifically:
//   - request : fields the client submitted (subject.kind, ename.namePart).
//   - outcome : server-allocated identifiers (subject.id, ename.id, ename.numberPart).
//
// Exported so consumers of the generic `findEvents()` /
// `getEventByIdempotencyKey()` can narrow to this kind and parse each column.
// The Event type in `./event.ts` keeps both columns as `unknown` because the
// table holds heterogeneous kinds.

export const SubjectRegisteredRequestSchema = z.object({
  subject: z.object({
    kind: z.literal('person'),
  }),
  ename: z.object({
    namePart: z.string(),
  }),
});

export const SubjectRegisteredOutcomeSchema = z.object({
  subject: z.object({
    id: z.string().regex(UUIDV7_REGEX),
  }),
  ename: z.object({
    id: z.string().regex(UUIDV7_REGEX),
    // Uses the same (min, max, integer, coerce) chain as the projection
    // schema so an outcome re-parsed from the event log cannot pass a
    // `numberPart` that the original INSERT would have rejected.
    numberPart: NumberPartFieldSchema,
  }),
});

type SubjectRegisteredRequest = z.infer<typeof SubjectRegisteredRequestSchema>;
type SubjectRegisteredOutcome = z.infer<typeof SubjectRegisteredOutcomeSchema>;

// ---------------------------------------------------------------------------
// registerSubject — public types
// ---------------------------------------------------------------------------

// Domain-shaped input: entity blocks (`subject`, `ename`) mirror the event's
// `request` JSONB shape and the public API request body. The body minus
// `idempotencyKey` is exactly what gets persisted in `events.request` —
// no transformation, no impedance mismatch.
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

// Reconstruct the public service result from the persisted request + outcome
// of a `subject.registered` event. Used both on the success path of a fresh
// registration (where request + outcome are built in-memory) and on the
// replay path (where they are re-parsed from the event row).
function buildResult(
  request: SubjectRegisteredRequest,
  outcome: SubjectRegisteredOutcome,
  createdAt: Date,
): RegisterSubjectResult {
  return {
    createdAt,
    subject: { id: outcome.subject.id, kind: request.subject.kind },
    ename: {
      id: outcome.ename.id,
      namePart: request.ename.namePart,
      numberPart: outcome.ename.numberPart,
    },
  };
}

// Map a discovered existing event to either a replay result (same operation,
// return the prior response) or an IdempotencyConflictError (different
// operation, surface as 409).
//
// Conflict detection is a direct structural deep-equal between the current
// input (minus `idempotencyKey`, which lives in its own column) and the
// persisted `request`. No reconstruction, no whitelist of fields — the
// `events.request` column is, by design, exactly what the client submitted,
// so equality is the natural check (cf. ename-internals.md § events table,
// § Service-side idempotency algorithm).
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
  const request = SubjectRegisteredRequestSchema.parse(existing.request);
  const outcome = SubjectRegisteredOutcomeSchema.parse(existing.outcome);
  const submittedRequest: SubjectRegisteredRequest = {
    subject: input.subject,
    ename: input.ename,
  };
  if (!isDeepStrictEqual(submittedRequest, request)) {
    logger.info(
      { existing: request, requested: submittedRequest },
      'idempotency conflict: existing event has a different request body',
    );
    throw new IdempotencyConflictError(
      'this idempotency key has already been used with a different request body',
    );
  }
  return buildResult(request, outcome, existing.createdAt);
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
//      INSERTs and to the event's outcome JSONB — required for deterministic
//      projection-by-replay).
//   3. BEGIN, INSERT subjects.
//   4. INSERT enames with COALESCE(MAX(number_part), 0) + 1, under a
//      SAVEPOINT, retry on UNIQUE collision.
//   5. Enforce the 52-char total length on the resulting ename.
//   6. INSERT events with request (what the client submitted) and outcome
//      (server allocations). On UNIQUE collision on idempotency_key (race
//      between step 1 and step 6), rollback and reconcile from the winner's
//      row.
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
  const subjectId = generateUUIDv7();
  const enameId = generateUUIDv7();
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
        const request: SubjectRegisteredRequest = {
          subject: { kind },
          ename: { namePart },
        };
        const outcome: SubjectRegisteredOutcome = {
          subject: { id: subjectId },
          ename: { id: enameId, numberPart },
        };
        await insertEvent(client, {
          idempotencyKey: input.idempotencyKey,
          kind: 'subject.registered',
          request,
          outcome,
          createdAt,
        });

        return buildResult(request, outcome, createdAt);
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
