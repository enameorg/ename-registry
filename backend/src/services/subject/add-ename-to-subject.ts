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

import { SubjectReferenceSchema } from './subject.ts';

// ---------------------------------------------------------------------------
// subject.ename-added — the event kind this use case emits
// ---------------------------------------------------------------------------

// What the write records: the kind literal and the strict pair of schemas that
// parse its request and outcome (cf. ename-internals.md, event-kind.ts). The
// request composes the concepts' input schemas.
export const SubjectEnameAddedEventKindDefinition = {
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
} as const satisfies EventKindDefinition;

// ---------------------------------------------------------------------------
// addEnameToSubject — public types
// ---------------------------------------------------------------------------

export type AddEnameToSubjectInput = {
  idempotencyKey: string;
} & EventRequest<typeof SubjectEnameAddedEventKindDefinition>;

// ---------------------------------------------------------------------------
// addEnameToSubject — public use case
// ---------------------------------------------------------------------------

// Add one ename to an existing subject, emitting one subject.ename-added event,
// and return the row it wrote. Idempotency (replay, 409 on a different request,
// race reconciliation, replay winning over a current-state conflict) is
// appendEvent's.
export async function addEnameToSubject(
  input: AddEnameToSubjectInput,
  context: ServiceContext,
): Promise<Ename> {
  const { subject, ename } = input;
  const { request, outcome, createdAt } = await appendEvent(
    SubjectEnameAddedEventKindDefinition,
    {
      idempotencyKey: input.idempotencyKey,
      request: { subject, ename },
      projectionWriter: async (db, createdAt) => {
        const enameId = generateUUIDv7();
        const numberPart = await insertEnameWithNextNumber(
          db,
          { enameId, subjectId: subject.id, namePart: ename.namePart, createdAt },
          context.logger,
        );
        return { ename: { id: enameId, numberPart } };
      },
    },
    context,
  );
  // Rebuilt from the event rather than kept from the writer, so a replay (which
  // runs no writer) returns the same thing as a first write.
  return {
    id: outcome.ename.id,
    subjectId: request.subject.id,
    namePart: request.ename.namePart,
    numberPart: outcome.ename.numberPart,
    createdAt,
  };
}
