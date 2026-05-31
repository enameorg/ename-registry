import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { pino } from 'pino';

import { useTestDb } from '../../database/testing.ts';
import { generateUUIDv7, UUIDV7_REGEX } from '../../uuid.ts';
import { findEnames } from '../ename/index.ts';
import { ConflictError, IdempotencyConflictError, NotFoundError } from '../errors.ts';
import { findEvents } from '../event/index.ts';

import {
  addEnameToSubject,
  SubjectEnameAddedOutcomeSchema,
  SubjectEnameAddedRequestSchema,
} from './add-ename-to-subject.ts';
import { registerSubject } from './register-subject.ts';
import { findSubjects } from './subject.ts';

const silentLogger = pino({ level: 'silent' });
const context = { logger: silentLogger };

useTestDb();

test('happy path: adds one ename to an existing subject and emits subject.ename_added', async () => {
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

  assert.equal(result.subject.id, registered.subject.id);
  assert.match(result.ename.id, UUIDV7_REGEX);
  assert.equal(result.ename.namePart, 'new-name');
  assert.equal(result.ename.numberPart, 1);

  const subjects = await findSubjects();
  assert.equal(subjects.length, 1);
  assert.equal(subjects[0]?.id, registered.subject.id);
  assert.equal(subjects[0]?.createdAt.getTime(), registered.createdAt.getTime());

  const enames = await findEnames();
  assert.equal(enames.length, 2);
  const addedEname = enames.find((ename) => ename.id === result.ename.id);
  assert.ok(addedEname);
  assert.equal(addedEname.subjectId, registered.subject.id);
  assert.equal(addedEname.namePart, 'new-name');
  assert.equal(addedEname.createdAt.getTime(), result.createdAt.getTime());

  const events = await findEvents();
  assert.equal(events.length, 2);
  const addEvent = events[1];
  assert.equal(addEvent?.idempotencyKey, idempotencyKey);
  assert.equal(addEvent?.kind, 'subject.ename_added');
  const request = SubjectEnameAddedRequestSchema.parse(addEvent?.request);
  assert.equal(request.subject.id, registered.subject.id);
  assert.equal(request.ename.namePart, 'new-name');
  const outcome = SubjectEnameAddedOutcomeSchema.parse(addEvent?.outcome);
  assert.equal(outcome.ename.id, result.ename.id);
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

  assert.equal(added.ename.numberPart, 2);
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

  assert.equal((await findSubjects()).length, 1);
  assert.equal((await findEnames()).length, 1);
  assert.equal((await findEvents()).length, 1);
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

  assert.equal((await findSubjects()).length, 0);
  assert.equal((await findEnames()).length, 0);
  assert.equal((await findEvents()).length, 0);
});

test('idempotent replay has priority over the duplicate-name conflict', async () => {
  const registered = await registerSubject(
    {
      idempotencyKey: generateUUIDv7(),
      subject: { kind: 'person' },
      ename: { namePart: 'old-name' },
    },
    context,
  );
  const input = {
    idempotencyKey: generateUUIDv7(),
    subject: { id: registered.subject.id },
    ename: { namePart: 'new-name' },
  };

  const first = await addEnameToSubject(input, context);
  const second = await addEnameToSubject(input, context);

  assert.equal(first.subject.id, second.subject.id);
  assert.equal(first.ename.id, second.ename.id);
  assert.equal(first.ename.numberPart, second.ename.numberPart);
  assert.equal(first.createdAt.getTime(), second.createdAt.getTime());
  assert.equal((await findEvents()).length, 2);
  assert.equal((await findEnames()).length, 2);
});

test('idempotency conflict: same key with a different path or body throws IdempotencyConflictError', async () => {
  const firstSubject = await registerSubject(
    {
      idempotencyKey: generateUUIDv7(),
      subject: { kind: 'person' },
      ename: { namePart: 'first-subject' },
    },
    context,
  );
  const secondSubject = await registerSubject(
    {
      idempotencyKey: generateUUIDv7(),
      subject: { kind: 'person' },
      ename: { namePart: 'second-subject' },
    },
    context,
  );
  const idempotencyKey = generateUUIDv7();

  await addEnameToSubject(
    {
      idempotencyKey,
      subject: { id: firstSubject.subject.id },
      ename: { namePart: 'shared-new-name' },
    },
    context,
  );

  await assert.rejects(
    () =>
      addEnameToSubject(
        {
          idempotencyKey,
          subject: { id: secondSubject.subject.id },
          ename: { namePart: 'shared-new-name' },
        },
        context,
      ),
    (error: unknown) => error instanceof IdempotencyConflictError,
  );
});

test('concurrent exact replays with the same idempotencyKey produce a single added ename', async () => {
  const registered = await registerSubject(
    {
      idempotencyKey: generateUUIDv7(),
      subject: { kind: 'person' },
      ename: { namePart: 'old-name' },
    },
    context,
  );
  const input = {
    idempotencyKey: generateUUIDv7(),
    subject: { id: registered.subject.id },
    ename: { namePart: 'new-name' },
  };
  const concurrency = 10;

  const results = await Promise.all(
    Array.from({ length: concurrency }, () => addEnameToSubject(input, context)),
  );

  const first = results[0];
  assert.ok(first);
  for (const result of results) {
    assert.equal(result.subject.id, first.subject.id);
    assert.equal(result.ename.id, first.ename.id);
    assert.equal(result.ename.numberPart, first.ename.numberPart);
    assert.equal(result.createdAt.getTime(), first.createdAt.getTime());
  }
  assert.equal((await findEvents()).length, 2);
  assert.equal((await findEnames()).length, 2);
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
  assert.equal((await findEvents()).length, 2);
  assert.equal((await findEnames()).length, 2);
});
