import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { pino } from 'pino';
import { ZodError } from 'zod';

import { pool } from '../../database/pool.ts';
import { useTestDb } from '../../database/testing.ts';
import { generateUUIDv7 } from '../../utilities/uuid.ts';
import { ConflictError, IdempotencyConflictError, ValidationError } from '../errors.ts';
import {
  findSubjects,
  insertSubject,
  type RegisterSubjectResult,
  SubjectEnameAddedEventKindDefinition,
  SubjectRegisteredEventKindDefinition,
} from '../subject/index.ts';

import { defineEventKind } from './event-kind.ts';
import { findEvents, insertEvent } from './event.ts';
import { withEvent } from './with-event.ts';

// Tests of the idempotent-write protocol at its own interface, with a real
// kind (the events.kind CHECK admits no test kind) and a work the test
// controls: it can return rows without touching a projection, throw a domain
// error, or wait for a concurrent commit, which makes every branch of the
// protocol deterministic. A first write returns the work's rows; a replay
// returns what the kind's fromEvent reads from the stored event. Test
// doctrine: ename-internals.md.
const context = { logger: pino({ level: 'silent' }) };

useTestDb();

const request = { subject: { kind: 'person' as const }, ename: { namePart: 'jean-dupont' } };

// The rows a work returns, consistent with `request` and the event's createdAt.
function makeRows(createdAt = new Date()): RegisterSubjectResult {
  const subjectId = generateUUIDv7();
  return {
    subject: { id: subjectId, kind: 'person', createdAt },
    ename: { id: generateUUIDv7(), subjectId, namePart: 'jean-dupont', numberPart: 1, createdAt },
  };
}

// The outcome a concurrent winner stored.
function makeOutcome() {
  return {
    subject: { id: generateUUIDv7() },
    ename: { id: generateUUIDv7(), numberPart: 1 },
  };
}

test('appends one event carrying the kind, the request, the outcome kept from the rows the work returned and a single createdAt', async () => {
  const idempotencyKey = generateUUIDv7();
  let rows: RegisterSubjectResult | undefined;

  const appended = await withEvent(
    SubjectRegisteredEventKindDefinition,
    {
      idempotencyKey,
      request,
      work: (_db, createdAt) => {
        rows = makeRows(createdAt);
        return Promise.resolve(rows);
      },
    },
    context,
  );

  assert.ok(rows);
  assert.deepEqual(appended, rows);

  const events = await findEvents(pool);
  assert.equal(events.length, 1);
  const [event] = events;
  assert.ok(event);
  assert.equal(event.kind, 'subject.registered');
  assert.equal(event.idempotencyKey, idempotencyKey);
  assert.deepEqual(event.request, request);
  assert.deepEqual(event.outcome, SubjectRegisteredEventKindDefinition.toOutcome(rows));
  assert.equal(event.createdAt.getTime(), rows.subject.createdAt.getTime());
});

test('replays the stored result for the same idempotencyKey and request, without running the work again', async () => {
  const idempotencyKey = generateUUIDv7();
  const first = await withEvent(
    SubjectRegisteredEventKindDefinition,
    { idempotencyKey, request, work: (_db, createdAt) => Promise.resolve(makeRows(createdAt)) },
    context,
  );

  let workRuns = 0;
  const second = await withEvent(
    SubjectRegisteredEventKindDefinition,
    {
      idempotencyKey,
      request,
      work: (_db, createdAt) => {
        workRuns += 1;
        return Promise.resolve(makeRows(createdAt));
      },
    },
    context,
  );

  assert.equal(workRuns, 0);
  // The replay reads the stored event back through fromEvent: the two paths
  // agree, the law each kind's test pins, here on the real kind.
  assert.deepEqual(second, first);
  assert.equal((await findEvents(pool)).length, 1);
});

test('rejects the same idempotencyKey with a different request as an IdempotencyConflictError, without running the work', async () => {
  const idempotencyKey = generateUUIDv7();
  await withEvent(
    SubjectRegisteredEventKindDefinition,
    { idempotencyKey, request, work: () => Promise.resolve(makeRows()) },
    context,
  );

  let workRuns = 0;
  await assert.rejects(
    () =>
      withEvent(
        SubjectRegisteredEventKindDefinition,
        {
          idempotencyKey,
          request: { ...request, ename: { namePart: 'other-name' } },
          work: () => {
            workRuns += 1;
            return Promise.resolve(makeRows());
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
  assert.equal(workRuns, 0);
  assert.equal((await findEvents(pool)).length, 1);
});

test('rejects the same idempotencyKey used by an event of another kind, before parsing its request', async () => {
  const idempotencyKey = generateUUIDv7();
  // Seed a subject.ename-added row directly: its request has no subject.kind,
  // so a parse with the subject.registered schema would fail — the kind check
  // must come first.
  await insertEvent(pool, {
    idempotencyKey,
    kind: SubjectEnameAddedEventKindDefinition.kind,
    request: { subject: { id: generateUUIDv7() }, ename: { namePart: 'jean-dupont' } },
    outcome: { ename: { id: generateUUIDv7(), numberPart: 2 } },
    createdAt: new Date(),
  });

  await assert.rejects(
    () =>
      withEvent(
        SubjectRegisteredEventKindDefinition,
        { idempotencyKey, request, work: () => Promise.resolve(makeRows()) },
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

  const appended = await withEvent(
    SubjectRegisteredEventKindDefinition,
    {
      idempotencyKey,
      request,
      work: async (db, createdAt) => {
        await insertSubject(db, {
          id: generateUUIDv7(),
          kind: 'person',
          createdAt,
        });
        // Another backend commits the same key, same request, on its own
        // connection, after our preliminary lookup and before our events insert.
        await insertEvent(pool, {
          idempotencyKey,
          kind: SubjectRegisteredEventKindDefinition.kind,
          request,
          outcome: winnerOutcome,
          createdAt: winnerCreatedAt,
        });
        return makeRows(createdAt);
      },
    },
    context,
  );

  assert.deepEqual(
    appended,
    SubjectRegisteredEventKindDefinition.fromEvent({
      request,
      outcome: winnerOutcome,
      createdAt: winnerCreatedAt,
    }),
  );
  assert.equal((await findEvents(pool)).length, 1);
  assert.equal((await findSubjects(pool)).length, 0);
});

test('a domain error raised by the work is reconciled against a concurrent same-key winner before it surfaces', async () => {
  const idempotencyKey = generateUUIDv7();
  const winnerOutcome = makeOutcome();

  const appended = await withEvent(
    SubjectRegisteredEventKindDefinition,
    {
      idempotencyKey,
      request,
      work: async () => {
        // The winner commits first; our projection write then hits a
        // current-state conflict that the winner explains.
        await insertEvent(pool, {
          idempotencyKey,
          kind: SubjectRegisteredEventKindDefinition.kind,
          request,
          outcome: winnerOutcome,
          createdAt: new Date(),
        });
        throw new ConflictError('This subject already has an ename with this namePart.');
      },
    },
    context,
  );

  assert.equal(appended.subject.id, winnerOutcome.subject.id);
  assert.equal(appended.ename.id, winnerOutcome.ename.id);
  assert.equal((await findEvents(pool)).length, 1);
});

test('a domain error raised by the work with no winner surfaces as is, and nothing is written', async () => {
  await assert.rejects(
    () =>
      withEvent(
        SubjectRegisteredEventKindDefinition,
        {
          idempotencyKey: generateUUIDv7(),
          request,
          work: async (db, createdAt) => {
            await insertSubject(db, {
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
  assert.equal((await findEvents(pool)).length, 0);
  assert.equal((await findSubjects(pool)).length, 0);
});

test('an invalid request fails before any write', async () => {
  let workRuns = 0;
  await assert.rejects(
    () =>
      withEvent(
        SubjectRegisteredEventKindDefinition,
        {
          idempotencyKey: generateUUIDv7(),
          // Cast: deliberately malformed to exercise the Service-side parse.
          request: {
            subject: { kind: 'robot' },
            ename: { namePart: 'x' },
          } as unknown as typeof request,
          work: () => {
            workRuns += 1;
            return Promise.resolve(makeRows());
          },
        },
        context,
      ),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.ok(
        error.errors.some((issue) => issue.path[0] === 'subject' && issue.path[1] === 'kind'),
      );
      return true;
    },
  );
  assert.equal(workRuns, 0);
  assert.equal((await findEvents(pool)).length, 0);
});

test('a request carrying a field the kind does not declare fails before any write, never stripped', async () => {
  let workRuns = 0;
  await assert.rejects(
    () =>
      withEvent(
        SubjectRegisteredEventKindDefinition,
        {
          idempotencyKey: generateUUIDv7(),
          // Cast: a field the kind does not know, nested in an entity object —
          // what a wire schema ahead of the kind definition would let through.
          request: {
            subject: { kind: 'person', publicKey: 'not-yet-a-field' },
            ename: { namePart: 'jean-dupont' },
          } as unknown as typeof request,
          work: () => {
            workRuns += 1;
            return Promise.resolve(makeRows());
          },
        },
        context,
      ),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.ok(error.errors.some((issue) => issue.message.includes('"publicKey"')));
      return true;
    },
  );
  assert.equal(workRuns, 0);
  assert.equal((await findEvents(pool)).length, 0);
});

// The real kind with a toOutcome that keeps a field the kind does not declare:
// what a kind whose outcome schema lags behind its toOutcome would do. A fault
// of the kind, not of the caller, so it surfaces as the raw ZodError, never as
// a ValidationError.
const leakyDefinition = defineEventKind({
  ...SubjectRegisteredEventKindDefinition,
  toOutcome: (result: RegisterSubjectResult) => ({
    ...SubjectRegisteredEventKindDefinition.toOutcome(result),
    platform: { id: generateUUIDv7() },
  }),
});

test('an outcome carrying a field the kind does not declare rolls the event back, projection writes included', async () => {
  await assert.rejects(
    () =>
      withEvent(
        leakyDefinition,
        {
          idempotencyKey: generateUUIDv7(),
          request,
          work: async (db, createdAt) => {
            await insertSubject(db, {
              id: generateUUIDv7(),
              kind: 'person',
              createdAt,
            });
            return makeRows(createdAt);
          },
        },
        context,
      ),
    (error: unknown) => error instanceof ZodError,
  );
  assert.equal((await findEvents(pool)).length, 0);
  assert.equal((await findSubjects(pool)).length, 0);
});
