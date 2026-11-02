import { z } from 'zod';

import { generateUUIDv7, UUIDv7Schema } from '../../utilities/uuid.ts';
import type { Signature } from '../common/index.ts';
import type { ServiceContext } from '../context.ts';
import {
  type Ename,
  EnameInputSchema,
  insertEname,
  insertEnameWithNextNumber,
  NumberPartSchema,
} from '../ename/index.ts';
import { defineEventKind, type EventRequest, withEvent } from '../event/index.ts';
import { authenticatePlatform } from '../platform/index.ts';

import { insertSubject, type Subject, SubjectInputSchema } from './subject.ts';

// ---------------------------------------------------------------------------
// registerSubject — public types
// ---------------------------------------------------------------------------

export type RegisterSubjectInput = {
  idempotencyKey: string;
  signature: Signature;
} & EventRequest<typeof subjectRegisteredEventKindDefinition>;

// What the use case writes and returns: the two rows, in the concepts' types.
export type RegisterSubjectResult = { subject: Subject; ename: Ename };

// ---------------------------------------------------------------------------
// registerSubject — public use case
// ---------------------------------------------------------------------------

// Register a new subject and its first ename atomically, emitting one subject.registered event, and
// return the two rows it wrote. The platform that signs the registration becomes the subject's home
// platform.
export async function registerSubject(
  input: RegisterSubjectInput,
  context: ServiceContext,
): Promise<RegisterSubjectResult> {
  return await withEvent(
    subjectRegisteredEventKindDefinition,
    {
      idempotencyKey: input.idempotencyKey,
      request: { subject: input.subject, ename: input.ename },
      signature: input.signature,
      authenticate: authenticatePlatform,
      work: async (db, createdAt, signer) => {
        const subject = await insertSubject(db, {
          id: generateUUIDv7(),
          kind: input.subject.kind,
          homePlatformId: signer.platformId,
          createdAt,
        });
        const ename = await insertEnameWithNextNumber(
          db,
          {
            id: generateUUIDv7(),
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

// What the write records (cf. ename-internals.md, event-kind.ts). The home platform is in the
// outcome: the registry derives it from the signing key, the client never submits it.
export const subjectRegisteredEventKindDefinition = defineEventKind({
  kind: 'subject.registered',
  operation: 'subject.register',
  requestSchema: z.strictObject({
    subject: SubjectInputSchema,
    ename: EnameInputSchema,
  }),
  outcomeSchema: z.strictObject({
    subject: z.strictObject({
      id: UUIDv7Schema,
      homePlatform: z.strictObject({
        id: UUIDv7Schema,
      }),
    }),
    ename: z.strictObject({
      id: UUIDv7Schema,
      // Same chain as the projection schema, so a numberPart re-parsed from the event log can't
      // pass what the original INSERT would have rejected.
      numberPart: NumberPartSchema,
    }),
  }),
  toOutcome: ({ subject, ename }: RegisterSubjectResult) => ({
    subject: { id: subject.id, homePlatform: { id: subject.homePlatformId } },
    ename: { id: ename.id, numberPart: ename.numberPart },
  }),
  fromEvent: ({ request, outcome, createdAt }): RegisterSubjectResult => ({
    subject: {
      id: outcome.subject.id,
      kind: request.subject.kind,
      homePlatformId: outcome.subject.homePlatform.id,
      createdAt,
    },
    ename: {
      id: outcome.ename.id,
      subjectId: outcome.subject.id,
      namePart: request.ename.namePart,
      numberPart: outcome.ename.numberPart,
      createdAt,
    },
  }),
  rebuild: async (db, { subject, ename }) => {
    await insertSubject(db, subject);
    await insertEname(db, ename);
  },
});
