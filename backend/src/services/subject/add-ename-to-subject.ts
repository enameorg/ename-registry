import { generateUUIDv7 } from '../../utilities/uuid.ts';
import type { ServiceContext } from '../context.ts';
import { insertEnameWithNextNumber } from '../ename/index.ts';
import {
  appendEvent,
  type EventRequest,
  SubjectEnameAddedEventKindDefinition,
} from '../event/index.ts';

// ---------------------------------------------------------------------------
// addEnameToSubject — public types
// ---------------------------------------------------------------------------

export type AddEnameToSubjectInput = {
  idempotencyKey: string;
} & EventRequest<typeof SubjectEnameAddedEventKindDefinition>;

export type AddEnameToSubjectResult = {
  createdAt: Date;
  subject: { id: string };
  ename: { id: string; namePart: string; numberPart: number };
};

// ---------------------------------------------------------------------------
// addEnameToSubject — public use case
// ---------------------------------------------------------------------------

// Add one ename to an existing subject, emitting one subject.ename-added event.
// Idempotency (replay, 409 on a different request, race reconciliation, replay
// winning over a current-state conflict) is appendEvent's.
export async function addEnameToSubject(
  input: AddEnameToSubjectInput,
  context: ServiceContext,
): Promise<AddEnameToSubjectResult> {
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
  return {
    createdAt,
    subject: { id: request.subject.id },
    ename: {
      id: outcome.ename.id,
      namePart: request.ename.namePart,
      numberPart: outcome.ename.numberPart,
    },
  };
}
