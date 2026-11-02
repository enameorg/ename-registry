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
import { AuthorizationError, NotFoundError } from '../errors.ts';
import { defineEventKind, type EventRequest, withEvent } from '../event/index.ts';
import { authenticatePlatform } from '../platform/index.ts';

import { getSubject, SubjectReferenceSchema } from './subject.ts';

// ---------------------------------------------------------------------------
// addEnameToSubject — public types
// ---------------------------------------------------------------------------

export type AddEnameToSubjectInput = {
  idempotencyKey: string;
  signature: Signature;
} & EventRequest<typeof subjectEnameAddedEventKindDefinition>;

// What the use case writes and returns: the ename row, as is.
export type AddEnameToSubjectResult = Ename;

// ---------------------------------------------------------------------------
// addEnameToSubject — public use case
// ---------------------------------------------------------------------------

// Add one ename to an existing subject, emitting one subject.ename-added
// event, and return the row it wrote. Only the subject's home platform may add
// one: the work checks the signing platform against the subject.
export async function addEnameToSubject(
  input: AddEnameToSubjectInput,
  context: ServiceContext,
): Promise<AddEnameToSubjectResult> {
  return await withEvent(
    subjectEnameAddedEventKindDefinition,
    {
      idempotencyKey: input.idempotencyKey,
      request: { subject: input.subject, ename: input.ename },
      signature: input.signature,
      authenticate: authenticatePlatform,
      work: async (db, createdAt, signer) => {
        // A read before the write: who serves the subject is a rule no
        // constraint of the enames insert can state. Subjects are never
        // deleted, so the subject read here is still there at the insert.
        const subject = await getSubject(db, input.subject.id);
        if (subject === undefined) {
          context.logger.info({ subjectId: input.subject.id }, 'subject not found');
          throw new NotFoundError('Subject not found.');
        }
        if (subject.homePlatformId !== signer.platformId) {
          context.logger.info(
            {
              subjectId: subject.id,
              homePlatformId: subject.homePlatformId,
              platformId: signer.platformId,
            },
            'ename addition by a platform that is not the home platform',
          );
          throw new AuthorizationError(
            'Only the home platform of this subject may add an ename to it.',
          );
        }
        return await insertEnameWithNextNumber(
          db,
          {
            id: generateUUIDv7(),
            subjectId: subject.id,
            namePart: input.ename.namePart,
            createdAt,
          },
          context.logger,
        );
      },
    },
    context,
  );
}

// ---------------------------------------------------------------------------
// subject.ename-added — the event kind addEnameToSubject emits
// ---------------------------------------------------------------------------

// What the write records (cf. ename-internals.md, event-kind.ts).
export const subjectEnameAddedEventKindDefinition = defineEventKind({
  kind: 'subject.ename-added',
  operation: 'subject.add-ename',
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
  rebuild: async (db, ename) => {
    await insertEname(db, ename);
  },
});
