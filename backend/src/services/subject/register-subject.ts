import { z } from 'zod';

import { generateUUIDv7, UUIDv7Schema } from '../../utilities/uuid.ts';
import type { ServiceContext } from '../context.ts';
import {
  type Ename,
  EnameInputSchema,
  insertEnameWithNextNumber,
  NumberPartSchema,
} from '../ename/index.ts';
import { appendEvent, type EventKindDefinition, type EventRequest } from '../event/index.ts';

import { insertSubject, type Subject, SubjectInputSchema } from './subject.ts';

// ---------------------------------------------------------------------------
// subject.registered — the event kind this use case emits
// ---------------------------------------------------------------------------

// What the write records: the kind literal and the strict pair of schemas that
// parse its request and outcome (cf. ename-internals.md, event-kind.ts). The
// request composes the concepts' input schemas, so the grammar they carry holds
// for every caller of the use case, not only the HTTP body, and a request
// re-parsed from the log can't pass what the original would have failed.
export const SubjectRegisteredEventKindDefinition = {
  kind: 'subject.registered',
  requestSchema: z.strictObject({
    subject: SubjectInputSchema,
    ename: EnameInputSchema,
  }),
  outcomeSchema: z.strictObject({
    subject: z.strictObject({
      id: UUIDv7Schema,
    }),
    ename: z.strictObject({
      id: UUIDv7Schema,
      // Same chain as the projection schema, so a numberPart re-parsed from the
      // event log can't pass what the original INSERT would have rejected.
      numberPart: NumberPartSchema,
    }),
  }),
} as const satisfies EventKindDefinition;

// ---------------------------------------------------------------------------
// registerSubject — public types
// ---------------------------------------------------------------------------

// The `subject` and `ename` objects mirror the event's request shape and the API
// body. The input minus idempotencyKey is exactly what lands in events.request.
export type RegisterSubjectInput = {
  idempotencyKey: string;
} & EventRequest<typeof SubjectRegisteredEventKindDefinition>;

// ---------------------------------------------------------------------------
// registerSubject — public use case
// ---------------------------------------------------------------------------

// Register a new subject and its first ename atomically, emitting one
// subject.registered event, and return the two rows it wrote. Idempotency
// (replay, 409 on a different request, race reconciliation) is appendEvent's.
export async function registerSubject(
  input: RegisterSubjectInput,
  context: ServiceContext,
): Promise<{ subject: Subject; ename: Ename }> {
  const { subject, ename } = input;
  const { request, outcome, createdAt } = await appendEvent(
    SubjectRegisteredEventKindDefinition,
    {
      idempotencyKey: input.idempotencyKey,
      request: { subject, ename },
      projectionWriter: async (db, createdAt) => {
        const subjectId = generateUUIDv7();
        const enameId = generateUUIDv7();
        await insertSubject(db, {
          id: subjectId,
          kind: subject.kind,
          createdAt,
        });
        const numberPart = await insertEnameWithNextNumber(
          db,
          { enameId, subjectId, namePart: ename.namePart, createdAt },
          context.logger,
        );
        return { subject: { id: subjectId }, ename: { id: enameId, numberPart } };
      },
    },
    context,
  );
  // The rows are rebuilt from the event rather than kept from the writer, so a
  // replay (which runs no writer) returns the same thing as a first write.
  return {
    subject: { id: outcome.subject.id, kind: request.subject.kind, createdAt },
    ename: {
      id: outcome.ename.id,
      subjectId: outcome.subject.id,
      namePart: request.ename.namePart,
      numberPart: outcome.ename.numberPart,
      createdAt,
    },
  };
}
