import { isDeepStrictEqual } from 'node:util';

import type { Logger } from 'pino';
import { z } from 'zod';

import { pool } from '../../database/pool.ts';
import { withTransaction } from '../../database/query.ts';
import { generateUUIDv7, UUIDV7_REGEX } from '../../uuid.ts';
import type { ServiceContext } from '../context.ts';
import {
  enforceMaxEnameLength,
  insertEnameWithNextNumber,
  NumberPartFieldSchema,
} from '../ename/index.ts';
import { ConflictError, IdempotencyConflictError } from '../errors.ts';
import {
  type Event,
  getEventByIdempotencyKey,
  IdempotencyRaceError,
  insertEvent,
} from '../event/index.ts';

// ---------------------------------------------------------------------------
// addEnameToSubject — public types
// ---------------------------------------------------------------------------

export type AddEnameToSubjectInput = {
  idempotencyKey: string;
  subject: { id: string };
  ename: { namePart: string };
};

export type AddEnameToSubjectResult = {
  createdAt: Date;
  subject: { id: string };
  ename: { id: string; namePart: string; numberPart: number };
};

// ---------------------------------------------------------------------------
// `subject.ename_added` event request + outcome schemas
// ---------------------------------------------------------------------------

export const SubjectEnameAddedRequestSchema = z.object({
  subject: z.object({
    id: z.string().regex(UUIDV7_REGEX),
  }),
  ename: z.object({
    namePart: z.string(),
  }),
});

export const SubjectEnameAddedOutcomeSchema = z.object({
  ename: z.object({
    id: z.string().regex(UUIDV7_REGEX),
    numberPart: NumberPartFieldSchema,
  }),
});

type SubjectEnameAddedRequest = z.infer<typeof SubjectEnameAddedRequestSchema>;
type SubjectEnameAddedOutcome = z.infer<typeof SubjectEnameAddedOutcomeSchema>;

// ---------------------------------------------------------------------------
// addEnameToSubject — public use case
// ---------------------------------------------------------------------------

// Add one ename to an existing subject, emitting one subject.ename_added event.
// Idempotency has priority over current-state conflicts: an exact retry replays
// the original result even though the first attempt already inserted the ename.
export async function addEnameToSubject(
  input: AddEnameToSubjectInput,
  context: ServiceContext,
): Promise<AddEnameToSubjectResult> {
  const { logger } = context;

  const existing = await getEventByIdempotencyKey(input.idempotencyKey);
  if (existing) {
    logger.info(
      { idempotencyKey: input.idempotencyKey, outcome: 'replay' },
      'idempotency replay detected at preliminary lookup',
    );
    return reconcileReplay(existing, input, logger);
  }

  const enameId = generateUUIDv7();
  const createdAt = new Date();
  const { id: subjectId } = input.subject;
  const { namePart } = input.ename;

  try {
    return await withTransaction(
      pool,
      async (client) => {
        const numberPart = await insertEnameWithNextNumber(
          client,
          { enameId, subjectId, namePart, createdAt },
          logger,
        );

        enforceMaxEnameLength({ namePart, numberPart }, logger);

        const request: SubjectEnameAddedRequest = {
          subject: { id: subjectId },
          ename: { namePart },
        };
        const outcome: SubjectEnameAddedOutcome = {
          ename: { id: enameId, numberPart },
        };
        await insertEvent(client, {
          idempotencyKey: input.idempotencyKey,
          kind: 'subject.ename_added',
          request,
          outcome,
          createdAt,
        });

        return buildResult(request, outcome, createdAt);
      },
      logger,
    );
  } catch (error) {
    if (error instanceof IdempotencyRaceError) {
      logger.info(
        { idempotencyKey: input.idempotencyKey },
        'idempotency race detected at events insert, reconciling from winner',
      );
      const winner = await getEventByIdempotencyKey(input.idempotencyKey);
      if (!winner) {
        throw new Error('idempotency race: conflicting event not found on reconcile');
      }
      return reconcileReplay(winner, input, logger);
    }
    if (error instanceof ConflictError) {
      const winner = await getEventByIdempotencyKey(input.idempotencyKey);
      if (winner) {
        logger.info(
          { idempotencyKey: input.idempotencyKey },
          'ename conflict overlapped with an idempotency winner, reconciling from winner',
        );
        return reconcileReplay(winner, input, logger);
      }
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// addEnameToSubject — internals
// ---------------------------------------------------------------------------

function reconcileReplay(
  existing: Event,
  input: AddEnameToSubjectInput,
  logger: Logger,
): AddEnameToSubjectResult {
  if (existing.kind !== 'subject.ename_added') {
    logger.info(
      { existingKind: existing.kind, expectedKind: 'subject.ename_added' },
      'idempotency conflict: existing event has a different kind',
    );
    throw new IdempotencyConflictError(
      'This idempotency key has already been used for a different operation.',
    );
  }
  const request = SubjectEnameAddedRequestSchema.parse(existing.request);
  const outcome = SubjectEnameAddedOutcomeSchema.parse(existing.outcome);
  const submittedRequest: SubjectEnameAddedRequest = {
    subject: input.subject,
    ename: input.ename,
  };
  if (!isDeepStrictEqual(submittedRequest, request)) {
    logger.info(
      { existing: request, requested: submittedRequest },
      'idempotency conflict: existing event has a different request',
    );
    throw new IdempotencyConflictError(
      'This idempotency key has already been used with a different request.',
    );
  }
  return buildResult(request, outcome, existing.createdAt);
}

function buildResult(
  request: SubjectEnameAddedRequest,
  outcome: SubjectEnameAddedOutcome,
  createdAt: Date,
): AddEnameToSubjectResult {
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
