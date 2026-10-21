import { z } from 'zod';

import { isUniqueViolation } from '../../database/errors.ts';
import { type Database, queryRows } from '../../database/query.ts';
import { UUIDv7Schema } from '../../utilities/uuid.ts';

// ---------------------------------------------------------------------------
// Event domain type and lookups
// ---------------------------------------------------------------------------

// Domain-shaped Event, mirroring the events table (the registry's source of
// truth; see ename-internals.md).
//
// request and outcome are typed `unknown`: the table holds heterogeneous kinds
// (subject.registered, subject.ename-added, future key rotation, …), each with
// its own pair of schemas. Callers narrow by kind and parse each column with
// the kind's definition (see event-kinds.ts).
//
// idempotencyKey is exposed for service-internal use (replay lookup, race
// reconciliation) and admin reads; it is transport metadata, projected out of
// the future public log endpoint by the API layer.
export const EventSchema = z.object({
  sequence: z.coerce.number().int().min(1),
  idempotencyKey: UUIDv7Schema,
  kind: z.string(),
  request: z.unknown(),
  outcome: z.unknown(),
  createdAt: z.date(),
});

export type Event = z.infer<typeof EventSchema>;

const SELECT_EVENT_COLUMNS = 'sequence, idempotency_key, kind, request, outcome, created_at';

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
// transparency-log endpoint.
export async function findEvents(db: Database): Promise<Event[]> {
  return await queryRows(
    db,
    `SELECT ${SELECT_EVENT_COLUMNS} FROM events ORDER BY sequence`,
    [],
    EventSchema,
  );
}

// ---------------------------------------------------------------------------
// Insertion helper
// ---------------------------------------------------------------------------

const EVENTS_IDEMPOTENCY_KEY_CONSTRAINT = 'events_idempotency_key_key';

// INSERT one event row. On a UNIQUE collision on idempotency_key, throws
// IdempotencyRaceError so the caller can roll back and reconcile from the winner.
export async function insertEvent(
  db: Database,
  params: {
    idempotencyKey: string;
    kind: string;
    request: unknown;
    outcome: unknown;
    createdAt: Date;
  },
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO events (idempotency_key, kind, request, outcome, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [params.idempotencyKey, params.kind, params.request, params.outcome, params.createdAt],
    );
  } catch (error) {
    if (isUniqueViolation(error, EVENTS_IDEMPOTENCY_KEY_CONSTRAINT)) {
      throw new IdempotencyRaceError();
    }
    throw error;
  }
}

// Sentinel raised by insertEvent when the events.idempotency_key UNIQUE
// constraint fires: another transaction won the idempotency race. Not a
// DomainError — it's internal control flow, caught by appendEvent to roll back
// and reconcile from the winner's row. Never leaves the event concept.
export class IdempotencyRaceError extends Error {
  public override readonly name = 'IdempotencyRaceError';
  constructor() {
    super('idempotency race');
  }
}
