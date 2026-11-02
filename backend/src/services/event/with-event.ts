import { isDeepStrictEqual } from 'node:util';

import type { Logger } from 'pino';
import { z } from 'zod';

import { pool } from '../../database/pool.ts';
import { type Database, withTransaction } from '../../database/query.ts';
import { UUIDv7Schema } from '../../utilities/uuid.ts';
import {
  assertPortableValues,
  type SignableDocument,
  type Signature,
  SignatureSchema,
} from '../common/index.ts';
import type { ServiceContext } from '../context.ts';
import { DomainError, IdempotencyConflictError, validationErrorFromZodError } from '../errors.ts';

import {
  type EventKindDefinition,
  type EventOutcome,
  type EventRequest,
  type EventResult,
  parseEvent,
} from './event-kind.ts';
import {
  type Event,
  getEventByIdempotencyKey,
  IdempotencyRaceError,
  insertEvent,
} from './event.ts';

const IdempotencyKeyAndSignatureSchema = z.object({
  idempotencyKey: UUIDv7Schema,
  signature: SignatureSchema,
});

// ---------------------------------------------------------------------------
// withEvent — the write protocol
// ---------------------------------------------------------------------------

// Append one event of the given kind to the log, running `work` inside the
// event's transaction to write the projections, and return what `work`
// returned: the rows, in the concept's own types. The event's outcome is what
// the kind's `toOutcome` keeps of that result. A replay runs no work and reads
// the stored event back into the same shape through the kind's `fromEvent`;
// the two agree by the law each kind's test pins. Every write use case goes
// through here (cf. ename-internals.md).
//
// The signer is authenticated first, before any lookup, by the function the
// use case passes: it is given the signable document this protocol builds from
// the kind's operation, the signature's keyId, the idempotency key and the
// parsed request, so what it verifies is exactly what the log stores. It
// returns the signer the work receives, or raises the domain error that
// refuses it: a request whose signer is not established gets neither a write
// nor a replay. The protocol reads nothing of the signer it hands on.
export async function withEvent<Definition extends EventKindDefinition, Signer>(
  definition: Definition,
  params: {
    idempotencyKey: string;
    request: EventRequest<Definition>;
    signature: Signature;
    authenticate: (
      db: Database,
      document: SignableDocument,
      signatureValue: string,
      logger: Logger,
    ) => Promise<Signer>;
    work: (db: Database, createdAt: Date, signer: Signer) => Promise<EventResult<Definition>>;
  },
  context: ServiceContext,
): Promise<EventResult<Definition>> {
  const { logger } = context;
  const request = parseRequest(definition, params.request);
  const { idempotencyKey, signature } = parseIdempotencyKeyAndSignature(
    params.idempotencyKey,
    params.signature,
  );
  const { keyId } = signature;

  // Step 0 — the signer, authenticated on the document this protocol builds.
  const signer = await params.authenticate(
    pool,
    { operation: definition.operation, keyId, idempotencyKey, request },
    signature.value,
    logger,
  );

  // Step 1 — preliminary lookup, outside any transaction.
  const existing = await getEventByIdempotencyKey(pool, idempotencyKey);
  if (existing) {
    logger.info(
      { idempotencyKey, kind: definition.kind, outcome: 'replay' },
      'idempotency replay detected at preliminary lookup',
    );
    return reconcileReplay(definition, existing, request, keyId, logger);
  }

  // Step 2 — one timestamp for the event and every projection row it writes.
  const createdAt = new Date();

  try {
    return await withTransaction(
      pool,
      async (db) => {
        // Step 3 — the use case's projection writes, inside the event's
        // transaction. The outcome is parsed with the kind's strict schema
        // before it is stored: a field toOutcome returns and the kind does not
        // declare rolls the event back rather than entering the log.
        const result = await params.work(db, createdAt, signer);
        const outcome = definition.outcomeSchema.parse(
          definition.toOutcome(result),
        ) as EventOutcome<Definition>;

        // Step 4 — INSERT events. An IdempotencyRaceError means another
        // backend won the race since step 1: we reconcile from its event,
        // outside the transaction.
        await insertEvent(db, {
          idempotencyKey,
          kind: definition.kind,
          request,
          outcome,
          signature,
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
        { idempotencyKey, kind: definition.kind },
        'idempotency race detected at events insert, reconciling from winner',
      );
      const winner = await getEventByIdempotencyKey(pool, idempotencyKey);
      if (!winner) {
        // Pathological: the constraint fired but the row is no longer
        // visible (concurrent ROLLBACK between our INSERT-fail and this
        // SELECT). Surface loud — we cannot decide the outcome.
        throw new Error('idempotency race: conflicting event not found on reconcile');
      }
      return reconcileReplay(definition, winner, request, keyId, logger);
    }
    if (error instanceof DomainError) {
      // A current-state error raised by the work or the events insert (a
      // projection conflict, the 52-char budget, a second anchor) may be the
      // trace of a same-key winner that committed between step 1 and these
      // writes: the replay must win over the conflict, so look for the winner
      // before surfacing the error.
      const winner = await getEventByIdempotencyKey(pool, idempotencyKey);
      if (winner) {
        logger.info(
          { idempotencyKey, kind: definition.kind, error: error.name },
          'domain error overlapped with an idempotency winner, reconciling from winner',
        );
        return reconcileReplay(definition, winner, request, keyId, logger);
      }
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// withEvent — internals
// ---------------------------------------------------------------------------

// A request that fails the kind's strict parse, or that no signature can cover,
// is the caller's fault, raised in the domain's vocabulary so a non-HTTP caller
// gets a ValidationError, never a library error. The outcome and replay parses
// stay raw: a failure there is a bug or a corrupted event, not a malformed
// request.
function parseRequest<Definition extends EventKindDefinition>(
  definition: Definition,
  request: EventRequest<Definition>,
): EventRequest<Definition> {
  const parsed = definition.requestSchema.safeParse(request);
  if (!parsed.success) {
    throw validationErrorFromZodError(parsed.error);
  }
  assertPortableValues(parsed.data);
  // Cast: the definition's schema is generic, so TypeScript cannot relate the
  // parsed data to EventRequest<Definition>; the schema is what defines it.
  return parsed.data as EventRequest<Definition>;
}

// The idempotency key and the signature, parsed like the request: a value of
// the wrong form is the caller's fault, a ValidationError at its path in the
// use case's input, never a lookup that fails in the database. The API parses
// both first; this covers every other caller.
function parseIdempotencyKeyAndSignature(
  idempotencyKey: string,
  signature: Signature,
): { idempotencyKey: string; signature: Signature } {
  const parsed = IdempotencyKeyAndSignatureSchema.safeParse({ idempotencyKey, signature });
  if (!parsed.success) {
    throw validationErrorFromZodError(parsed.error);
  }
  return parsed.data;
}

// Map a found event to a replay result (same signer, same operation, same
// request) or an IdempotencyConflictError (→ 409). The signer is compared
// first, by the key that signed: a signer never reads another's result by
// reusing its idempotency key, nor learns what that key was used for, and two
// keys of one owner are two signers, so a retry is signed by the key that
// signed the first request. Only the keys are compared, never the signatures'
// bytes: ECDSA signs the same document differently each time. Conflict on the
// request is a structural deep-equality between the submitted request and the
// stored one. Messages stay generic for the client; the specifics go to the
// log, correlatable by requestId.
function reconcileReplay<Definition extends EventKindDefinition>(
  definition: Definition,
  existing: Event,
  submittedRequest: EventRequest<Definition>,
  keyId: string,
  logger: Logger,
): EventResult<Definition> {
  if (existing.signature.keyId !== keyId) {
    logger.info(
      { existingKeyId: existing.signature.keyId, keyId },
      'idempotency conflict: existing event has another signer',
    );
    throw new IdempotencyConflictError(
      'This idempotency key has already been used by another signer.',
    );
  }
  if (existing.kind !== definition.kind) {
    logger.info(
      { existingKind: existing.kind, expectedKind: definition.kind },
      'idempotency conflict: existing event has a different kind',
    );
    throw new IdempotencyConflictError(
      'This idempotency key has already been used for a different operation.',
    );
  }
  const stored = parseEvent(definition, existing);
  if (!isDeepStrictEqual(submittedRequest, stored.request)) {
    logger.info(
      { kind: definition.kind, existing: stored.request, requested: submittedRequest },
      'idempotency conflict: existing event has a different request',
    );
    throw new IdempotencyConflictError(
      'This idempotency key has already been used with a different request.',
    );
  }
  // Cast: `fromEvent` is generic over the definition, so TypeScript cannot
  // relate its return to EventResult<Definition>.
  return definition.fromEvent(stored) as EventResult<Definition>;
}
