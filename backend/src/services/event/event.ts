import { z } from 'zod';

import { isUniqueViolation } from '../../database/errors.ts';
import { type Database, queryRows } from '../../database/query.ts';
import type { PublicKey } from '../../utilities/signature.ts';
import { UUIDv7Schema } from '../../utilities/uuid.ts';
import { isSignatureValid, type Signature, SignatureSchema } from '../common/index.ts';
import { ConflictError } from '../errors.ts';

import type { EventKindDefinition } from './event-kind.ts';

// ---------------------------------------------------------------------------
// Event domain type and lookups
// ---------------------------------------------------------------------------

// Domain-shaped Event, read from the events table (the registry's source of
// truth; see ename-internals.md).
//
// request and outcome are typed `unknown`: the table holds every kind, each
// with its own pair of schemas. Callers narrow by kind and parse each column
// with the kind's definition, declared by the use case that emits it (see
// event-kind.ts).
//
// idempotencyKey is exposed for service-internal use (replay lookup, race
// reconciliation) and admin reads; it is transport metadata, projected out of
// the future public log endpoint by the API layer.
//
// signature is the signer's, as it was submitted: the key that signed the
// event's document and the signature's value, from which anyone holding the
// log can verify the event again (see isEventSignatureValid). Stored in two
// columns, assembled by the SELECT.
export const EventSchema = z.object({
  sequence: z.coerce.number().int().min(1),
  idempotencyKey: UUIDv7Schema,
  kind: z.string(),
  request: z.unknown(),
  outcome: z.unknown(),
  signature: SignatureSchema,
  createdAt: z.date(),
});

export type Event = z.infer<typeof EventSchema>;

const SELECT_EVENT_COLUMNS = `sequence, idempotency_key, kind, request, outcome,
  json_build_object('keyId', signature_key_id, 'value', signature_value) AS signature,
  created_at`;

export async function getEventByIdempotencyKey(
  db: Database,
  idempotencyKey: string,
): Promise<Event | undefined> {
  const rows = await queryRows(
    db,
    `SELECT ${SELECT_EVENT_COLUMNS} FROM events WHERE idempotency_key = $1`,
    [idempotencyKey],
    EventSchema,
  );
  return rows[0];
}

// Ordered by sequence — the canonical log order, same as the future public
// transparency-log endpoint. The window reads the log a page at a time: the
// events after `afterSequence`, at most `limit` of them. A page resumes after
// the last sequence it read, never at a computed one, because sequence has
// gaps. With no window, the whole log.
export async function findEvents(
  db: Database,
  { afterSequence = 0, limit }: { afterSequence?: number; limit?: number } = {},
): Promise<Event[]> {
  // pg sends an undefined limit as NULL, and LIMIT NULL is LIMIT ALL.
  return await queryRows(
    db,
    `SELECT ${SELECT_EVENT_COLUMNS} FROM events WHERE sequence > $1 ORDER BY sequence LIMIT $2`,
    [afterSequence, limit],
    EventSchema,
  );
}

// ---------------------------------------------------------------------------
// Signature of a stored event
// ---------------------------------------------------------------------------

// Whether a stored event's signature verifies against the key it names, from
// nothing but what the event stores: the document is rebuilt from the kind's
// operation, the key, the idempotency key and the request read back from the
// log. The check a verifier of the log runs on every event; each kind's test
// runs it on the events its use case writes. The caller resolves the key; its
// id is checked against the event's, since one public key may be recorded
// under two ids.
export function isEventSignatureValid(
  definition: EventKindDefinition,
  event: Event,
  key: PublicKey & { id: string },
): boolean {
  if (event.kind !== definition.kind || key.id !== event.signature.keyId) return false;
  return isSignatureValid(
    key,
    {
      operation: definition.operation,
      keyId: event.signature.keyId,
      idempotencyKey: event.idempotencyKey,
      request: event.request,
    },
    event.signature.value,
  );
}

// ---------------------------------------------------------------------------
// Insertion helper
// ---------------------------------------------------------------------------

const EVENTS_IDEMPOTENCY_KEY_CONSTRAINT = 'events_idempotency_key_key';
const EVENTS_SINGLE_ANCHOR_INDEX = 'events_single_anchor_idx';

// INSERT one event row. On a UNIQUE collision on idempotency_key, throws
// IdempotencyRaceError so the caller can roll back and reconcile from the
// winner. A second anchor, which the log admits once (cf. ename-internals.md),
// is a ConflictError.
export async function insertEvent(
  db: Database,
  params: {
    idempotencyKey: string;
    kind: string;
    request: unknown;
    outcome: unknown;
    signature: Signature;
    createdAt: Date;
  },
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO events
         (idempotency_key, kind, request, outcome, signature_key_id, signature_value, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        params.idempotencyKey,
        params.kind,
        params.request,
        params.outcome,
        params.signature.keyId,
        params.signature.value,
        params.createdAt,
      ],
    );
  } catch (error) {
    if (isUniqueViolation(error, EVENTS_IDEMPOTENCY_KEY_CONSTRAINT)) {
      throw new IdempotencyRaceError();
    }
    if (isUniqueViolation(error, EVENTS_SINGLE_ANCHOR_INDEX)) {
      throw new ConflictError('The registry is already anchored.');
    }
    throw error;
  }
}

// Sentinel raised by insertEvent when the events.idempotency_key UNIQUE
// constraint fires: another transaction won the idempotency race. Not a
// DomainError — it's internal control flow, caught by withEvent to roll back
// and reconcile from the winner's row. Never leaves the event concept.
export class IdempotencyRaceError extends Error {
  public override readonly name = 'IdempotencyRaceError';
  constructor() {
    super('idempotency race');
  }
}
