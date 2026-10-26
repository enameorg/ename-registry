import { isDeepStrictEqual } from 'node:util';

import type { Logger } from 'pino';

import { pool } from '../../database/pool.ts';
import { type Database, withTransaction } from '../../database/query.ts';
import type { ServiceContext } from '../context.ts';
import { DomainError, IdempotencyConflictError, validationErrorFromZodError } from '../errors.ts';

import type { EventKindDefinition, EventOutcome, EventRequest, EventResult } from './event-kind.ts';
import {
  type Event,
  getEventByIdempotencyKey,
  IdempotencyRaceError,
  insertEvent,
} from './event.ts';

// ---------------------------------------------------------------------------
// withEvent — the idempotent-write protocol
// ---------------------------------------------------------------------------

// Append one event of the given kind to the log, running `work` inside the
// event's transaction to write the projections, and return what `work`
// returned: the rows, in the concept's own types. The event's outcome is what
// the kind's `toOutcome` keeps of that result. A replay runs no work and reads
// the stored event back into the same shape through the kind's `fromEvent`;
// the two agree by the law each kind's test pins. Every write use case goes
// through here (cf. ename-internals.md).
export async function withEvent<Definition extends EventKindDefinition>(
  definition: Definition,
  params: {
    idempotencyKey: string;
    request: EventRequest<Definition>;
    work: (db: Database, createdAt: Date) => Promise<EventResult<Definition>>;
  },
  context: ServiceContext,
): Promise<EventResult<Definition>> {
  const { logger } = context;
  // A request that fails the kind's strict parse is the caller's fault, raised
  // in the domain's vocabulary so a non-HTTP caller gets a ValidationError,
  // never a library error. The outcome and replay parses below stay raw: a
  // failure there is a bug or a corrupted event, not a malformed request.
  const parsedRequest = definition.requestSchema.safeParse(params.request);
  if (!parsedRequest.success) {
    throw validationErrorFromZodError(parsedRequest.error);
  }
  // Cast: the definition's schema is generic, so TypeScript cannot relate the
  // parsed data to EventRequest<Definition>; the schema is what defines it.
  const request = parsedRequest.data as EventRequest<Definition>;

  // Step 1 — preliminary lookup, outside any transaction.
  const existing = await getEventByIdempotencyKey(pool, params.idempotencyKey);
  if (existing) {
    logger.info(
      { idempotencyKey: params.idempotencyKey, kind: definition.kind, outcome: 'replay' },
      'idempotency replay detected at preliminary lookup',
    );
    return reconcileReplay(definition, existing, request, logger);
  }

  // Step 2 — one timestamp for the event and every projection row it writes.
  const createdAt = new Date();

  try {
    return await withTransaction(
      pool,
      async (db) => {
        // Step 3 — the use case's projection writes, inside the event's transaction.
        // The outcome is parsed with the kind's strict schema before it is stored:
        // a field toOutcome returns and the kind does not declare rolls the
        // event back rather than entering the log.
        const result = await params.work(db, createdAt);
        const outcome = definition.outcomeSchema.parse(
          definition.toOutcome(result),
        ) as EventOutcome<Definition>;

        // Step 4 — INSERT events. A 23505 on idempotency_key means another
        // backend won the race since step 1; insertEvent raises
        // IdempotencyRaceError and we reconcile outside the transaction.
        await insertEvent(db, {
          idempotencyKey: params.idempotencyKey,
          kind: definition.kind,
          request,
          outcome,
          createdAt,
        });
        return result;
      },
      logger,
    );
  } catch (error) {
    // Both lookups below run on the pool, after the rollback, never inside the
    // transaction: a failed INSERT (the events row, or a projection constraint
    // behind a domain error) leaves the transaction aborted, so nothing can be
    // read on that connection, and its projection writes are to be discarded
    // anyway — the winner's committed state is the truth.
    if (error instanceof IdempotencyRaceError) {
      logger.info(
        { idempotencyKey: params.idempotencyKey, kind: definition.kind },
        'idempotency race detected at events insert, reconciling from winner',
      );
      const winner = await getEventByIdempotencyKey(pool, params.idempotencyKey);
      if (!winner) {
        // Pathological: the constraint fired but the row is no longer
        // visible (concurrent ROLLBACK between our INSERT-fail and this
        // SELECT). Surface loud — we cannot decide the outcome.
        throw new Error('idempotency race: conflicting event not found on reconcile');
      }
      return reconcileReplay(definition, winner, request, logger);
    }
    if (error instanceof DomainError) {
      // A current-state error raised by the work (a projection conflict, the
      // 52-char budget) may be the trace of a same-key winner that committed
      // between step 1 and the work's writes: the replay must win over the
      // conflict, so look for the winner before surfacing the error.
      const winner = await getEventByIdempotencyKey(pool, params.idempotencyKey);
      if (winner) {
        logger.info(
          { idempotencyKey: params.idempotencyKey, kind: definition.kind, error: error.name },
          'domain error overlapped with an idempotency winner, reconciling from winner',
        );
        return reconcileReplay(definition, winner, request, logger);
      }
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// withEvent — internals
// ---------------------------------------------------------------------------

// Map a found event to a replay result (same operation) or an
// IdempotencyConflictError (different operation, → 409). Conflict is a
// structural deep-equality between the submitted request and the stored one.
// Messages stay generic for the client; the specifics go to the log,
// correlatable by requestId.
function reconcileReplay<Definition extends EventKindDefinition>(
  definition: Definition,
  existing: Event,
  submittedRequest: EventRequest<Definition>,
  logger: Logger,
): EventResult<Definition> {
  if (existing.kind !== definition.kind) {
    logger.info(
      { existingKind: existing.kind, expectedKind: definition.kind },
      'idempotency conflict: existing event has a different kind',
    );
    throw new IdempotencyConflictError(
      'This idempotency key has already been used for a different operation.',
    );
  }
  // Casts: same reason as in withEvent — the schemas are generic.
  const request = definition.requestSchema.parse(existing.request) as EventRequest<Definition>;
  const outcome = definition.outcomeSchema.parse(existing.outcome) as EventOutcome<Definition>;
  if (!isDeepStrictEqual(submittedRequest, request)) {
    logger.info(
      { kind: definition.kind, existing: request, requested: submittedRequest },
      'idempotency conflict: existing event has a different request',
    );
    throw new IdempotencyConflictError(
      'This idempotency key has already been used with a different request.',
    );
  }
  // Cast: `fromEvent` is generic over the definition, so TypeScript cannot
  // relate its return to EventResult<Definition>.
  return definition.fromEvent({
    request,
    outcome,
    createdAt: existing.createdAt,
  }) as EventResult<Definition>;
}
