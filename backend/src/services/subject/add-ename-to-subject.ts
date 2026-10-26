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

import { SubjectReferenceSchema } from './subject.ts';

// ---------------------------------------------------------------------------
// addEnameToSubject — public types
// ---------------------------------------------------------------------------

export type AddEnameToSubjectInput = {
  idempotencyKey: string;
} & EventRequest<typeof SubjectEnameAddedEventKindDefinition>;

// What the use case writes and returns: the ename row, as is.
export type AddEnameToSubjectResult = Ename;

// ---------------------------------------------------------------------------
// addEnameToSubject — public use case
// ---------------------------------------------------------------------------

// Add one ename to an existing subject, emitting one subject.ename-added event,
// and return the row it wrote. Idempotency (replay, 409 on a different request,
// race reconciliation, replay winning over a current-state conflict) is
// withEvent's.
export async function addEnameToSubject(
  input: AddEnameToSubjectInput,
  context: ServiceContext,
): Promise<AddEnameToSubjectResult> {
  return await withEvent(
    SubjectEnameAddedEventKindDefinition,
    {
      idempotencyKey: input.idempotencyKey,
      request: { subject: input.subject, ename: input.ename },
      work: (db, createdAt) =>
        insertEnameWithNextNumber(
          db,
          {
            enameId: generateUUIDv7(),
            subjectId: input.subject.id,
            namePart: input.ename.namePart,
            createdAt,
          },
          context.logger,
        ),
    },
    context,
  );
}

// ---------------------------------------------------------------------------
// subject.ename-added — the event kind addEnameToSubject emits
// ---------------------------------------------------------------------------

// What the write records: the kind literal, the strict pair of schemas that
// parse its request and outcome (cf. ename-internals.md, event-kind.ts), and
// the mapping between the row written and the event. The request composes the
// concepts' input schemas.
export const SubjectEnameAddedEventKindDefinition = defineEventKind({
  kind: 'subject.ename-added',
  requestSchema: z.strictObject({
    subject: SubjectReferenceSchema,
    ename: EnameInputSchema,
  }),
  outcomeSchema: z.strictObject({
    ename: z.strictObject({
      id: UUIDv7Schema,
      numberPart: NumberPartSchema,
    }),
  }),
  toOutcome: (ename: AddEnameToSubjectResult) => ({
    ename: { id: ename.id, numberPart: ename.numberPart },
  }),
  fromEvent: ({ request, outcome, createdAt }): AddEnameToSubjectResult => ({
    id: outcome.ename.id,
    subjectId: request.subject.id,
    namePart: request.ename.namePart,
    numberPart: outcome.ename.numberPart,
    createdAt,
  }),
});
