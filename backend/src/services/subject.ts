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

// Thin wrapper for symmetry with insertEnameWithNextNumber / insertEvent:
// each table's write lives in the service that owns it, even when trivial.
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

// request/outcome shapes for kind = 'subject.registered':
//   - request : fields the client submitted (subject.kind, ename.namePart).
//   - outcome : server-allocated ids (subject.id, ename.id, ename.numberPart).
// The request/outcome split and its two signature scopes are in
// ename-internals.md. Exported so generic event readers can narrow to this
// kind and parse each column.

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
    // Same chain as the projection schema, so a numberPart re-parsed from the
    // event log can't pass what the original INSERT would have rejected.
    numberPart: NumberPartFieldSchema,
  }),
});

type SubjectRegisteredRequest = z.infer<typeof SubjectRegisteredRequestSchema>;
type SubjectRegisteredOutcome = z.infer<typeof SubjectRegisteredOutcomeSchema>;

// ---------------------------------------------------------------------------
// registerSubject — public types
// ---------------------------------------------------------------------------

// Entity blocks (subject, ename) mirror the event's request shape and the API
// body. The body minus idempotencyKey is exactly what lands in events.request.
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

// Build the public result from a request + outcome pair — used both on a fresh
// registration (built in-memory) and on replay (re-parsed from the event row).
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

// Map a found event to a replay result (same operation) or an
// IdempotencyConflictError (different operation, → 409). Conflict is a
// structural deep-equal between the submitted body (minus idempotencyKey) and
// the stored request. Messages stay generic for the client; the specifics
// (which kind, which field differed) go to the log, correlatable by requestId.
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

// Register a new subject and its first ename atomically, emitting one
// subject.registered event. Idempotent via idempotencyKey: a retry with the
// same body replays the original result, a different body raises
// IdempotencyConflictError (409). The algorithm is in ename-internals.md;
// its steps are marked inline below.
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

  // Convenience locals for the transaction body.
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

        // Step 6 — INSERT events. A 23505 on idempotency_key means another
        // backend won the race since step 1; insertEvent raises
        // IdempotencyRaceError and we reconcile outside the transaction.
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
