import { generateUUIDv7 } from '../../utilities/uuid.ts';
import type { ServiceContext } from '../context.ts';
import { insertEnameWithNextNumber } from '../ename/index.ts';
import {
  appendEvent,
  type EventRequest,
  SubjectRegisteredEventKindDefinition,
} from '../event/index.ts';

import { insertSubject } from './subject.ts';

// ---------------------------------------------------------------------------
// registerSubject — public types
// ---------------------------------------------------------------------------

// Entity blocks (subject, ename) mirror the event's request shape and the API
// body. The input minus idempotencyKey is exactly what lands in events.request.
export type RegisterSubjectInput = {
  idempotencyKey: string;
} & EventRequest<typeof SubjectRegisteredEventKindDefinition>;

export type RegisterSubjectResult = {
  createdAt: Date;
  subject: { id: string; kind: 'person' };
  ename: { id: string; namePart: string; numberPart: number };
};

// ---------------------------------------------------------------------------
// registerSubject — public use case
// ---------------------------------------------------------------------------

// Register a new subject and its first ename atomically, emitting one
// subject.registered event. Idempotency (replay, 409 on a different request,
// race reconciliation) is appendEvent's.
export async function registerSubject(
  input: RegisterSubjectInput,
  context: ServiceContext,
): Promise<RegisterSubjectResult> {
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
  return {
    createdAt,
    subject: { id: outcome.subject.id, kind: request.subject.kind },
    ename: {
      id: outcome.ename.id,
      namePart: request.ename.namePart,
      numberPart: outcome.ename.numberPart,
    },
  };
}
