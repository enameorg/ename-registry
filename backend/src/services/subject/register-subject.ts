import { z } from 'zod';

import { generateUUIDv7, UUIDv7Schema } from '../../utilities/uuid.ts';
import type { ServiceContext } from '../context.ts';
import {
  type Ename,
  EnameInputSchema,
  insertEnameWithNextNumber,
  NumberPartSchema,
} from '../ename/index.ts';
import { defineEventKind, type EventRequest, withEvent } from '../event/index.ts';

import { insertSubject, type Subject, SubjectInputSchema } from './subject.ts';

// ---------------------------------------------------------------------------
// registerSubject — public types
// ---------------------------------------------------------------------------

// The `subject` and `ename` objects mirror the event's request shape and the API
// body. The input minus idempotencyKey is exactly what lands in events.request.
export type RegisterSubjectInput = {
  idempotencyKey: string;
} & EventRequest<typeof SubjectRegisteredEventKindDefinition>;

// What the use case writes and returns: the two rows, in the concept's types.
export type RegisterSubjectResult = { subject: Subject; ename: Ename };

// ---------------------------------------------------------------------------
// registerSubject — public use case
// ---------------------------------------------------------------------------

// Register a new subject and its first ename atomically, emitting one
// subject.registered event, and return the two rows it wrote. Idempotency
// (replay, 409 on a different request, race reconciliation) is withEvent's.
export async function registerSubject(
  input: RegisterSubjectInput,
  context: ServiceContext,
): Promise<RegisterSubjectResult> {
  return await withEvent(
    SubjectRegisteredEventKindDefinition,
    {
      idempotencyKey: input.idempotencyKey,
      request: { subject: input.subject, ename: input.ename },
      work: async (db, createdAt) => {
        const subject = await insertSubject(db, {
          id: generateUUIDv7(),
          kind: input.subject.kind,
          createdAt,
        });
        const ename = await insertEnameWithNextNumber(
          db,
          {
            enameId: generateUUIDv7(),
            subjectId: subject.id,
            namePart: input.ename.namePart,
            createdAt,
          },
          context.logger,
        );
        return { subject, ename };
      },
    },
    context,
  );
}

// ---------------------------------------------------------------------------
// subject.registered — the event kind registerSubject emits
// ---------------------------------------------------------------------------

// What the write records: the kind literal, the strict pair of schemas that
// parse its request and outcome (cf. ename-internals.md, event-kind.ts), and
// the mapping between the rows written and the event. The request composes the
// concepts' input schemas, so the grammar they carry holds for every caller of
// the use case, not only the HTTP body, and a request re-parsed from the log
// can't pass what the original would have failed.
export const SubjectRegisteredEventKindDefinition = defineEventKind({
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
  toOutcome: ({ subject, ename }: RegisterSubjectResult) => ({
    subject: { id: subject.id },
    ename: { id: ename.id, numberPart: ename.numberPart },
  }),
  fromEvent: ({ request, outcome, createdAt }): RegisterSubjectResult => ({
    subject: { id: outcome.subject.id, kind: request.subject.kind, createdAt },
    ename: {
      id: outcome.ename.id,
      subjectId: outcome.subject.id,
      namePart: request.ename.namePart,
      numberPart: outcome.ename.numberPart,
      createdAt,
    },
  }),
});
