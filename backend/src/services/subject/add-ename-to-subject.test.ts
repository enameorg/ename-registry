import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { pino } from 'pino';
import { z } from 'zod';

import { pool } from '../../database/pool.ts';
import { useTestDb } from '../../database/testing.ts';
import { generateUUIDv7, UUIDV7_REGEX } from '../../utilities/uuid.ts';
import { findEnames } from '../ename/index.ts';
import { ConflictError, NotFoundError } from '../errors.ts';
import { findEvents } from '../event/index.ts';

import { addEnameToSubject, SubjectEnameAddedEventKindDefinition } from './add-ename-to-subject.ts';
import { registerSubject } from './register-subject.ts';
import { findSubjects } from './subject.ts';

// Idempotency (replay, conflict, race, replay winning over a current-state
// conflict) is appendEvent's and is tested at its interface in
// services/event/append-event.test.ts; the tests below cover what this use case
// adds: the projection writes and their own domain errors.
const silentLogger = pino({ level: 'silent' });
const context = { logger: silentLogger };

useTestDb();

test('happy path: adds one ename to an existing subject and emits subject.ename-added', async () => {
  const registered = await registerSubject(
    {
      idempotencyKey: generateUUIDv7(),
      subject: { kind: 'person' },
      ename: { namePart: 'old-name' },
    },
    context,
  );
  const idempotencyKey = generateUUIDv7();

  const result = await addEnameToSubject(
    {
      idempotencyKey,
      subject: { id: registered.subject.id },
      ename: { namePart: 'new-name' },
    },
    context,
  );

  assert.equal(result.subjectId, registered.subject.id);
  assert.match(result.id, UUIDV7_REGEX);
  assert.equal(result.namePart, 'new-name');
  assert.equal(result.numberPart, 1);

  const subjects = await findSubjects(pool);
  assert.equal(subjects.length, 1);
  assert.equal(subjects[0]?.id, registered.subject.id);
  assert.equal(subjects[0]?.createdAt.getTime(), registered.subject.createdAt.getTime());

  const enames = await findEnames(pool);
  assert.equal(enames.length, 2);
  const addedEname = enames.find((ename) => ename.id === result.id);
  assert.ok(addedEname);
  assert.equal(addedEname.subjectId, registered.subject.id);
  assert.equal(addedEname.namePart, 'new-name');
  assert.equal(addedEname.createdAt.getTime(), result.createdAt.getTime());

  const events = await findEvents(pool);
  assert.equal(events.length, 2);
  const addEvent = events[1];
  assert.equal(addEvent?.idempotencyKey, idempotencyKey);
  assert.equal(addEvent?.kind, 'subject.ename-added');
  const request = SubjectEnameAddedEventKindDefinition.requestSchema.parse(addEvent?.request);
  assert.equal(request.subject.id, registered.subject.id);
  assert.equal(request.ename.namePart, 'new-name');
  const outcome = SubjectEnameAddedEventKindDefinition.outcomeSchema.parse(addEvent?.outcome);
  assert.equal(outcome.ename.id, result.id);
  assert.equal(outcome.ename.numberPart, 1);
  assert.equal(addEvent?.createdAt.getTime(), result.createdAt.getTime());
});

test('same namePart on a different subject receives the next global numberPart', async () => {
  await registerSubject(
    {
      idempotencyKey: generateUUIDv7(),
      subject: { kind: 'person' },
      ename: { namePart: 'marie-curie' },
    },
    context,
  );
  const secondSubject = await registerSubject(
    {
      idempotencyKey: generateUUIDv7(),
      subject: { kind: 'person' },
      ename: { namePart: 'other-name' },
    },
    context,
  );

  const added = await addEnameToSubject(
    {
      idempotencyKey: generateUUIDv7(),
      subject: { id: secondSubject.subject.id },
      ename: { namePart: 'marie-curie' },
    },
    context,
  );

  assert.equal(added.numberPart, 2);
});

test('duplicate namePart for the same subject throws ConflictError and writes nothing', async () => {
  const registered = await registerSubject(
    {
      idempotencyKey: generateUUIDv7(),
      subject: { kind: 'person' },
      ename: { namePart: 'same-name' },
    },
    context,
  );

  await assert.rejects(
    () =>
      addEnameToSubject(
        {
          idempotencyKey: generateUUIDv7(),
          subject: { id: registered.subject.id },
          ename: { namePart: 'same-name' },
        },
        context,
      ),
    (error: unknown) =>
      error instanceof ConflictError &&
      error.message === 'This subject already has an ename with this namePart.',
  );

  assert.equal((await findSubjects(pool)).length, 1);
  assert.equal((await findEnames(pool)).length, 1);
  assert.equal((await findEvents(pool)).length, 1);
});

test('unknown subject throws NotFoundError and writes nothing', async () => {
  await assert.rejects(
    () =>
      addEnameToSubject(
        {
          idempotencyKey: generateUUIDv7(),
          subject: { id: generateUUIDv7() },
          ename: { namePart: 'new-name' },
        },
        context,
      ),
    (error: unknown) => error instanceof NotFoundError && error.message === 'Subject not found.',
  );

  assert.equal((await findSubjects(pool)).length, 0);
  assert.equal((await findEnames(pool)).length, 0);
  assert.equal((await findEvents(pool)).length, 0);
});

test('concurrent duplicate adds with different idempotencyKeys produce one success and conflicts', async () => {
  const registered = await registerSubject(
    {
      idempotencyKey: generateUUIDv7(),
      subject: { kind: 'person' },
      ename: { namePart: 'old-name' },
    },
    context,
  );
  const concurrency = 10;

  const outcomes = await Promise.allSettled(
    Array.from({ length: concurrency }, () =>
      addEnameToSubject(
        {
          idempotencyKey: generateUUIDv7(),
          subject: { id: registered.subject.id },
          ename: { namePart: 'new-name' },
        },
        context,
      ),
    ),
  );

  const successes = outcomes.filter((outcome) => outcome.status === 'fulfilled');
  const conflicts = outcomes.filter(
    (outcome) => outcome.status === 'rejected' && outcome.reason instanceof ConflictError,
  );
  assert.equal(successes.length, 1);
  assert.equal(conflicts.length, concurrency - 1);
  assert.equal((await findEvents(pool)).length, 2);
  assert.equal((await findEnames(pool)).length, 2);
});

test('a namePart outside the grammar is rejected before anything is written', async () => {
  const registered = await registerSubject(
    {
      idempotencyKey: generateUUIDv7(),
      subject: { kind: 'person' },
      ename: { namePart: 'old-name' },
    },
    context,
  );

  await assert.rejects(
    () =>
      addEnameToSubject(
        {
          idempotencyKey: generateUUIDv7(),
          subject: { id: registered.subject.id },
          ename: { namePart: 'new--name' },
        },
        context,
      ),
    (error: unknown) => {
      assert.ok(error instanceof z.ZodError);
      assert.ok(
        error.issues.some((issue) => issue.path[0] === 'ename' && issue.path[1] === 'namePart'),
      );
      return true;
    },
  );

  assert.equal((await findEnames(pool)).length, 1);
  assert.equal((await findEvents(pool)).length, 1);
});
