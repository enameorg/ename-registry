import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { pino } from 'pino';
import { ZodError } from 'zod';

import { pool } from '../../database/pool.ts';
import { withTransaction } from '../../database/query.ts';
import { useTestDb } from '../../database/testing.ts';
import { generateUUIDv7 } from '../../uuid.ts';
import { ConflictError, IdempotencyConflictError } from '../errors.ts';
import { findSubjects, insertSubject } from '../subject/index.ts';

import { appendEvent } from './append-event.ts';
import {
  SubjectEnameAddedEventKindDefinition,
  SubjectRegisteredEventKindDefinition,
} from './event-kinds.ts';
import { findEvents, insertEvent } from './event.ts';

// Tests of the idempotent-write protocol at its own interface, with a real
// kind (the events.kind CHECK admits no test kind) and a projection writer the
// test controls: it can return an outcome without touching a projection, throw a
// domain error, or wait for a concurrent commit, which makes every branch of
// the protocol deterministic. Test doctrine: ename-internals.md.
const context = { logger: pino({ level: 'silent' }) };

useTestDb();

const request = { subject: { kind: 'person' as const }, ename: { namePart: 'jean-dupont' } };

function makeOutcome() {
  return {
    subject: { id: generateUUIDv7() },
    ename: { id: generateUUIDv7(), numberPart: 1 },
  };
}

test('appends one event carrying the kind, the request, the outcome of the projection writer and a single createdAt', async () => {
  const idempotencyKey = generateUUIDv7();
  const outcome = makeOutcome();
  let createdAtSeenByWriter: Date | undefined;

  const appended = await appendEvent(
    SubjectRegisteredEventKindDefinition,
    {
      idempotencyKey,
      request,
      projectionWriter: (_client, createdAt) => {
        createdAtSeenByWriter = createdAt;
        return Promise.resolve(outcome);
      },
    },
    context,
  );

  assert.deepEqual(appended.request, request);
  assert.deepEqual(appended.outcome, outcome);
  assert.equal(appended.createdAt, createdAtSeenByWriter);

  const events = await findEvents();
  assert.equal(events.length, 1);
  const [event] = events;
  assert.ok(event);
  assert.equal(event.kind, 'subject.registered');
  assert.equal(event.idempotencyKey, idempotencyKey);
  assert.deepEqual(event.request, request);
  assert.deepEqual(event.outcome, outcome);
  assert.equal(event.createdAt.getTime(), appended.createdAt.getTime());
});

test('replays the stored result for the same idempotencyKey and request, without running the projection writer again', async () => {
  const idempotencyKey = generateUUIDv7();
  const outcome = makeOutcome();
  const first = await appendEvent(
    SubjectRegisteredEventKindDefinition,
    { idempotencyKey, request, projectionWriter: () => Promise.resolve(outcome) },
    context,
  );

  let writerRuns = 0;
  const second = await appendEvent(
    SubjectRegisteredEventKindDefinition,
    {
      idempotencyKey,
      request,
      projectionWriter: () => {
        writerRuns += 1;
        return Promise.resolve(makeOutcome());
      },
    },
    context,
  );

  assert.equal(writerRuns, 0);
  assert.deepEqual(second.request, first.request);
  assert.deepEqual(second.outcome, first.outcome);
  assert.equal(second.createdAt.getTime(), first.createdAt.getTime());
  assert.equal((await findEvents()).length, 1);
});

test('rejects the same idempotencyKey with a different request as an IdempotencyConflictError, without running the projection writer', async () => {
  const idempotencyKey = generateUUIDv7();
  await appendEvent(
    SubjectRegisteredEventKindDefinition,
    { idempotencyKey, request, projectionWriter: () => Promise.resolve(makeOutcome()) },
    context,
  );

  let writerRuns = 0;
  await assert.rejects(
    () =>
      appendEvent(
        SubjectRegisteredEventKindDefinition,
        {
          idempotencyKey,
          request: { ...request, ename: { namePart: 'other-name' } },
          projectionWriter: () => {
            writerRuns += 1;
            return Promise.resolve(makeOutcome());
          },
        },
        context,
      ),
    (error: unknown) => {
      assert.ok(error instanceof IdempotencyConflictError);
      assert.equal(
        error.message,
        'This idempotency key has already been used with a different request.',
      );
      return true;
    },
  );
  assert.equal(writerRuns, 0);
  assert.equal((await findEvents()).length, 1);
});

test('rejects the same idempotencyKey used by an event of another kind, before parsing its request', async () => {
  const idempotencyKey = generateUUIDv7();
  // Seed a subject.ename_added row directly: its request has no subject.kind,
  // so a parse with the subject.registered schema would throw a ZodError — the
  // kind check must come first.
  await withTransaction(
    pool,
    (client) =>
      insertEvent(client, {
        idempotencyKey,
        kind: SubjectEnameAddedEventKindDefinition.kind,
        request: { subject: { id: generateUUIDv7() }, ename: { namePart: 'jean-dupont' } },
        outcome: { ename: { id: generateUUIDv7(), numberPart: 2 } },
        createdAt: new Date(),
      }),
    context.logger,
  );

  await assert.rejects(
    () =>
      appendEvent(
        SubjectRegisteredEventKindDefinition,
        { idempotencyKey, request, projectionWriter: () => Promise.resolve(makeOutcome()) },
        context,
      ),
    (error: unknown) => {
      assert.ok(error instanceof IdempotencyConflictError);
      assert.equal(
        error.message,
        'This idempotency key has already been used for a different operation.',
      );
      return true;
    },
  );
});

test('loses the race at the events insert to a concurrent same-key commit, rolls back the projection writes and replays the winner', async () => {
  const idempotencyKey = generateUUIDv7();
  const winnerOutcome = makeOutcome();
  const winnerCreatedAt = new Date();

  const appended = await appendEvent(
    SubjectRegisteredEventKindDefinition,
    {
      idempotencyKey,
      request,
      projectionWriter: async (client, createdAt) => {
        await insertSubject(client, {
          id: generateUUIDv7(),
          kind: 'person',
          createdAt,
        });
        // Another backend commits the same key, same request, on its own
        // connection, after our preliminary lookup and before our events insert.
        await withTransaction(
          pool,
          (winnerClient) =>
            insertEvent(winnerClient, {
              idempotencyKey,
              kind: SubjectRegisteredEventKindDefinition.kind,
              request,
              outcome: winnerOutcome,
              createdAt: winnerCreatedAt,
            }),
          context.logger,
        );
        return makeOutcome();
      },
    },
    context,
  );

  assert.deepEqual(appended.outcome, winnerOutcome);
  assert.equal(appended.createdAt.getTime(), winnerCreatedAt.getTime());
  assert.equal((await findEvents()).length, 1);
  assert.equal((await findSubjects()).length, 0);
});

test('a domain error raised by the projection writer is reconciled against a concurrent same-key winner before it surfaces', async () => {
  const idempotencyKey = generateUUIDv7();
  const winnerOutcome = makeOutcome();

  const appended = await appendEvent(
    SubjectRegisteredEventKindDefinition,
    {
      idempotencyKey,
      request,
      projectionWriter: async () => {
        // The winner commits first; our projection write then hits a
        // current-state conflict that the winner explains.
        await withTransaction(
          pool,
          (winnerClient) =>
            insertEvent(winnerClient, {
              idempotencyKey,
              kind: SubjectRegisteredEventKindDefinition.kind,
              request,
              outcome: winnerOutcome,
              createdAt: new Date(),
            }),
          context.logger,
        );
        throw new ConflictError('This subject already has an ename with this namePart.');
      },
    },
    context,
  );

  assert.deepEqual(appended.outcome, winnerOutcome);
  assert.equal((await findEvents()).length, 1);
});

test('a domain error raised by the projection writer with no winner surfaces as is, and nothing is written', async () => {
  await assert.rejects(
    () =>
      appendEvent(
        SubjectRegisteredEventKindDefinition,
        {
          idempotencyKey: generateUUIDv7(),
          request,
          projectionWriter: async (client, createdAt) => {
            await insertSubject(client, {
              id: generateUUIDv7(),
              kind: 'person',
              createdAt,
            });
            throw new ConflictError('This subject already has an ename with this namePart.');
          },
        },
        context,
      ),
    (error: unknown) => error instanceof ConflictError,
  );
  assert.equal((await findEvents()).length, 0);
  assert.equal((await findSubjects()).length, 0);
});

test('an invalid request fails before any write', async () => {
  let writerRuns = 0;
  await assert.rejects(
    () =>
      appendEvent(
        SubjectRegisteredEventKindDefinition,
        {
          idempotencyKey: generateUUIDv7(),
          // Cast: deliberately malformed to exercise the Service-side parse.
          request: {
            subject: { kind: 'robot' },
            ename: { namePart: 'x' },
          } as unknown as typeof request,
          projectionWriter: () => {
            writerRuns += 1;
            return Promise.resolve(makeOutcome());
          },
        },
        context,
      ),
    (error: unknown) => error instanceof ZodError,
  );
  assert.equal(writerRuns, 0);
  assert.equal((await findEvents()).length, 0);
});
