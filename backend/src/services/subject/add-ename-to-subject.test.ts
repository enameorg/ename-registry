import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { pino } from 'pino';

import { pool } from '../../database/pool.ts';
import { withTransaction } from '../../database/query.ts';
import { truncateProjections, useTestDatabase } from '../../database/testing.ts';
import { generateUUIDv7, UUIDV7_REGEX } from '../../utilities/uuid.ts';
import { findEnames } from '../ename/index.ts';
import { AuthorizationError, ConflictError, NotFoundError, ValidationError } from '../errors.ts';
import { type Event, findEvents, isEventSignatureValid, parseEvent } from '../event/index.ts';
import { getKey } from '../key/index.ts';
import {
  accreditTestPlatform,
  rebuildEvents,
  setUpEventKindDefinitions,
  setUpTestPlatform,
  signInput,
  type TestPlatformSigner,
} from '../testing.ts';

import {
  addEnameToSubject,
  type AddEnameToSubjectResult,
  subjectEnameAddedEventKindDefinition,
} from './add-ename-to-subject.ts';
import { registerSubject, subjectRegisteredEventKindDefinition } from './register-subject.ts';
import { findSubjects } from './subject.ts';

// What this use case adds to the write protocol: its kind's mapping, the row it writes, its rebuild
// from the log, the home-platform rule and its own domain errors; its signer's authentication is
// authenticatePlatform's, tested in services/platform/platform.test.ts; idempotency is withEvent's,
// tested in services/event/with-event.test.ts. Test doctrine: ename-internals.md.
const silentLogger = pino({ level: 'silent' });
const context = { logger: silentLogger };

useTestDatabase();

async function register(platform: TestPlatformSigner, namePart: string) {
  return await registerSubject(
    signInput(subjectRegisteredEventKindDefinition, platform, {
      idempotencyKey: generateUUIDv7(),
      subject: { kind: 'person' },
      ename: { namePart },
    }),
    context,
  );
}

async function addEname(
  platform: TestPlatformSigner,
  subjectId: string,
  namePart: string,
  idempotencyKey = generateUUIDv7(),
) {
  return await addEnameToSubject(
    signInput(subjectEnameAddedEventKindDefinition, platform, {
      idempotencyKey,
      subject: { id: subjectId },
      ename: { namePart },
    }),
    context,
  );
}

// The events the use cases wrote, the setup's anchor and accreditation aside.
async function findSubjectEvents(): Promise<Event[]> {
  return (await findEvents(pool)).filter((event) => event.kind.startsWith('subject.'));
}

// The law withEvent rests on: what toOutcome keeps of the row, read back with the request and the
// timestamp, is the row again.
test('toOutcome keeps what the server allocated, and fromEvent reads it back as the ename row written', () => {
  const subjectId = generateUUIDv7();
  const enameId = generateUUIDv7();
  const createdAt = new Date('2026-05-30T14:32:11.123Z');
  const request = { subject: { id: subjectId }, ename: { namePart: 'new-name' } };
  const row: AddEnameToSubjectResult = {
    id: enameId,
    subjectId,
    namePart: 'new-name',
    numberPart: 2,
    createdAt,
  };

  const outcome = subjectEnameAddedEventKindDefinition.toOutcome(row);
  assert.deepEqual(outcome, { ename: { id: enameId, numberPart: 2 } });
  assert.deepEqual(
    subjectEnameAddedEventKindDefinition.fromEvent({ request, outcome, createdAt }),
    row,
  );
});

test('happy path: adds one ename to an existing subject and emits subject.ename-added', async () => {
  const { platform } = await setUpTestPlatform();
  const registered = await register(platform, 'old-name');
  const idempotencyKey = generateUUIDv7();

  const result = await addEname(platform, registered.subject.id, 'new-name', idempotencyKey);

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

  const events = await findSubjectEvents();
  assert.equal(events.length, 2);
  const addEvent = events[1];
  assert.ok(addEvent);
  assert.equal(addEvent.idempotencyKey, idempotencyKey);
  assert.equal(addEvent.kind, 'subject.ename-added');
  const { request, outcome } = parseEvent(subjectEnameAddedEventKindDefinition, addEvent);
  assert.equal(request.subject.id, registered.subject.id);
  assert.equal(request.ename.namePart, 'new-name');
  assert.equal(outcome.ename.id, result.id);
  assert.equal(outcome.ename.numberPart, 1);
  assert.equal(addEvent.createdAt.getTime(), result.createdAt.getTime());

  // The stored event verifies again from what it stores alone.
  const key = await getKey(pool, addEvent.signature.keyId);
  assert.ok(key);
  assert.equal(key.platformId, platform.platformId);
  assert.equal(isEventSignatureValid(subjectEnameAddedEventKindDefinition, addEvent, key), true);
});

// The second way this kind's rows get written (cf. ename-internals.md): with the projections
// emptied, rebuilding the log in sequence order — each event through the definition of its kind —
// writes the same rows the use cases wrote, and leaves the log as it was. The added ename takes #2
// of a namePart another subject registered first.
test('rebuilding the log writes back exactly the ename addEnameToSubject wrote', async () => {
  const { platform } = await setUpTestPlatform();
  await register(platform, 'marie-curie');
  const registered = await register(platform, 'other-name');
  const added = await addEname(platform, registered.subject.id, 'marie-curie');
  assert.equal(added.numberPart, 2);
  const subjects = await findSubjects(pool);
  const enames = await findEnames(pool);
  const events = await findEvents(pool);
  assert.deepEqual(
    (await findSubjectEvents()).map((event) => event.kind),
    ['subject.registered', 'subject.registered', 'subject.ename-added'],
  );

  await truncateProjections();
  assert.deepEqual(await findEnames(pool), []);

  await withTransaction(
    pool,
    (db) =>
      rebuildEvents(db, events, [
        ...setUpEventKindDefinitions,
        subjectRegisteredEventKindDefinition,
        subjectEnameAddedEventKindDefinition,
      ]),
    silentLogger,
  );

  assert.deepEqual(await findSubjects(pool), subjects);
  assert.deepEqual(await findEnames(pool), enames);
  assert.deepEqual(await findEvents(pool), events);
});

test('same namePart on a different subject receives the next global numberPart', async () => {
  const { platform } = await setUpTestPlatform();
  await register(platform, 'marie-curie');
  const secondSubject = await register(platform, 'other-name');

  const added = await addEname(platform, secondSubject.subject.id, 'marie-curie');

  assert.equal(added.numberPart, 2);
});

test('a platform that is not the home platform of the subject gets an AuthorizationError and writes nothing', async () => {
  const { registry, platform } = await setUpTestPlatform();
  const other = await accreditTestPlatform(registry);
  const registered = await register(platform, 'old-name');

  await assert.rejects(
    () => addEname(other, registered.subject.id, 'new-name'),
    (error: unknown) =>
      error instanceof AuthorizationError &&
      error.message === 'Only the home platform of this subject may add an ename to it.',
  );

  assert.equal((await findEnames(pool)).length, 1);
  assert.equal((await findSubjectEvents()).length, 1);
});

test('duplicate namePart for the same subject throws ConflictError and writes nothing', async () => {
  const { platform } = await setUpTestPlatform();
  const registered = await register(platform, 'same-name');

  await assert.rejects(
    () => addEname(platform, registered.subject.id, 'same-name'),
    (error: unknown) =>
      error instanceof ConflictError &&
      error.message === 'This subject already has an ename with this namePart.',
  );

  assert.equal((await findSubjects(pool)).length, 1);
  assert.equal((await findEnames(pool)).length, 1);
  assert.equal((await findSubjectEvents()).length, 1);
});

test('unknown subject throws NotFoundError and writes nothing', async () => {
  const { platform } = await setUpTestPlatform();
  await assert.rejects(
    () => addEname(platform, generateUUIDv7(), 'new-name'),
    (error: unknown) => error instanceof NotFoundError && error.message === 'Subject not found.',
  );

  assert.equal((await findSubjects(pool)).length, 0);
  assert.equal((await findEnames(pool)).length, 0);
  assert.equal((await findSubjectEvents()).length, 0);
});

test('concurrent duplicate adds with different idempotencyKeys produce one success and conflicts', async () => {
  const { platform } = await setUpTestPlatform();
  const registered = await register(platform, 'old-name');
  const concurrency = 10;

  const outcomes = await Promise.allSettled(
    Array.from({ length: concurrency }, () =>
      addEname(platform, registered.subject.id, 'new-name'),
    ),
  );

  const successes = outcomes.filter((outcome) => outcome.status === 'fulfilled');
  const conflicts = outcomes.filter(
    (outcome) => outcome.status === 'rejected' && outcome.reason instanceof ConflictError,
  );
  assert.equal(successes.length, 1);
  assert.equal(conflicts.length, concurrency - 1);
  assert.equal((await findSubjectEvents()).length, 2);
  assert.equal((await findEnames(pool)).length, 2);
});

test('a namePart outside the grammar is rejected before anything is written', async () => {
  const { platform } = await setUpTestPlatform();
  const registered = await register(platform, 'old-name');

  await assert.rejects(
    () => addEname(platform, registered.subject.id, 'new--name'),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.ok(
        error.errors.some((issue) => issue.path[0] === 'ename' && issue.path[1] === 'namePart'),
      );
      return true;
    },
  );

  assert.equal((await findEnames(pool)).length, 1);
  assert.equal((await findSubjectEvents()).length, 1);
});
