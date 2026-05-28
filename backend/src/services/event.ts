import type { PoolClient } from 'pg';
import { z } from 'zod';

import { isUniqueViolation } from '../database/errors.ts';
import { pool } from '../database/pool.ts';
import { queryRows } from '../database/query.ts';
import { UUIDV7_REGEX } from '../uuid.ts';

const EVENTS_IDEMPOTENCY_KEY_CONSTRAINT = 'events_idempotency_key_key';

// Sentinel raised by `insertEvent` when the UNIQUE constraint on
// `events.idempotency_key` fires — signals to the caller that another
// transaction won the idempotency race between the preliminary lookup and
// this INSERT. Not a `DomainError`: it is an internal control-flow sentinel
// caught by the service that owns the use case (e.g. `registerSubject`),
// which then rolls back the surrounding transaction and reconciles from
// the winner's row. Must never reach the API layer.
export class IdempotencyRaceError extends Error {
  public override readonly name = 'IdempotencyRaceError';
  constructor() {
    super('idempotency race');
  }
}

// Domain-shaped Event. Mirrors the `events` table — single source of truth of
// the registry per the event-sourcing model (cf. ename-internals.md § Registry
// architecture as a verifiable event log).
//
// `payload` is intentionally `unknown`: the table holds heterogeneous event
// kinds (v1: `subject.registered`; future: `subject.ename_added`, key rotation,
// recovery, etc.), each with its own payload schema. Callers narrow by `kind`
// and parse `payload` with the schema specific to that kind (e.g. the service
// for `subject.registered` parses with `SubjectRegisteredPayloadSchema`).
//
// `idempotencyKey` is included here for service-internal use (replay lookup,
// race reconciliation) and operator/admin reads. Per ename-internals.md § events
// table, it is transport metadata, not part of the event's semantic content —
// the future public log endpoint will project it out. That filtering is the
// API layer's responsibility, not this type's.
export const EventSchema = z.object({
  sequence: z.coerce.number().int().min(1),
  idempotencyKey: z.string().regex(UUIDV7_REGEX),
  kind: z.string(),
  payload: z.unknown(),
  createdAt: z.date(),
});

export type Event = z.infer<typeof EventSchema>;

const SELECT_EVENT_COLUMNS = 'sequence, idempotency_key, kind, payload, created_at';

export async function getEventByIdempotencyKey(idempotencyKey: string): Promise<Event | undefined> {
  const rows = await queryRows(
    pool,
    `SELECT ${SELECT_EVENT_COLUMNS} FROM events WHERE idempotency_key = $1`,
    [idempotencyKey],
    EventSchema,
  );
  return rows[0];
}

// Returns events ordered by `sequence` — the canonical order of the log. The
// same order will surface on the future public transparency-log endpoint.
export async function findEvents(): Promise<Event[]> {
  return await queryRows(
    pool,
    `SELECT ${SELECT_EVENT_COLUMNS} FROM events ORDER BY sequence`,
    [],
    EventSchema,
  );
}

// INSERT one event row. On UNIQUE collision on `idempotency_key`, throws
// `IdempotencyRaceError` so the caller can rollback the surrounding
// transaction and reconcile from the winner's row.
export async function insertEvent(
  client: PoolClient,
  params: {
    idempotencyKey: string;
    kind: string;
    payload: unknown;
    createdAt: Date;
  },
): Promise<void> {
  try {
    await client.query(
      `INSERT INTO events (idempotency_key, kind, payload, created_at)
       VALUES ($1, $2, $3, $4)`,
      [params.idempotencyKey, params.kind, params.payload, params.createdAt],
    );
  } catch (error) {
    if (isUniqueViolation(error, EVENTS_IDEMPOTENCY_KEY_CONSTRAINT)) {
      throw new IdempotencyRaceError();
    }
    throw error;
  }
}
