import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { pool } from '../../database/pool.ts';
import { useTestDatabase } from '../../database/testing.ts';
import { generateUUIDv7 } from '../../utilities/uuid.ts';
import { ConflictError } from '../errors.ts';
import { subjectRegisteredEventKindDefinition } from '../subject/index.ts';
import { generateTestKey, signRequest } from '../testing.ts';

import { defineEventKind } from './event-kind.ts';
import {
  type Event,
  findEvents,
  getEventByIdempotencyKey,
  IdempotencyRaceError,
  insertEvent,
  isEventSignatureValid,
} from './event.ts';

// Direct tests of the event data-access primitives (insert + read round-trip,
// the windowed read over a log with a gap, the two UNIQUE collisions
// insertEvent translates: a reused idempotency key, a second anchor), then the
// check of a stored event's signature. The kind vocabulary is tested against
// its CHECK where the list of definitions lives, in services/application. The
// primitives are tested in isolation so use-case tests can read state back
// through them and trust the result — see ename-internals.md. A
// single-statement write needs no transaction, so the primitives are called
// with the pool directly.
useTestDatabase();

// ---------------------------------------------------------------------------
// Data-access primitives
// ---------------------------------------------------------------------------

// A signature the primitives store and read as given: they verify nothing.
function makeSignature() {
  return { keyId: generateUUIDv7(), value: 'c2lnbmF0dXJl' };
}

test('insertEvent then read back round-trips kind, request, outcome, idempotencyKey, signature and createdAt', async () => {
  const idempotencyKey = generateUUIDv7();
  const createdAt = new Date();
  const signature = makeSignature();
  const request = { subject: { kind: 'person' }, ename: { namePart: 'jean-dupont' } };
  const outcome = {
    subject: { id: generateUUIDv7() },
    ename: { id: generateUUIDv7(), numberPart: 1 },
  };

  await insertEvent(pool, {
    idempotencyKey,
    kind: 'subject.registered',
    request,
    outcome,
    signature,
    createdAt,
  });

  const found = await getEventByIdempotencyKey(pool, idempotencyKey);
  assert.ok(found);
  assert.equal(found.idempotencyKey, idempotencyKey);
  assert.equal(found.kind, 'subject.registered');
  assert.deepEqual(found.request, request);
  assert.deepEqual(found.outcome, outcome);
  assert.deepEqual(found.signature, signature);
  assert.equal(found.createdAt.getTime(), createdAt.getTime());
  assert.ok(found.sequence >= 1);

  const all = await findEvents(pool);
  assert.equal(all.length, 1);
  assert.equal(all[0]?.idempotencyKey, idempotencyKey);
});

test('getEventByIdempotencyKey returns undefined for an unknown key', async () => {
  assert.equal(await getEventByIdempotencyKey(pool, generateUUIDv7()), undefined);
});

test('insertEvent twice with the same idempotencyKey throws IdempotencyRaceError', async () => {
  const idempotencyKey = generateUUIDv7();
  const params = {
    idempotencyKey,
    kind: 'subject.registered',
    request: {},
    outcome: {},
    signature: makeSignature(),
    createdAt: new Date(),
  };

  await insertEvent(pool, params);

  await assert.rejects(
    () => insertEvent(pool, params),
    (error: unknown) => error instanceof IdempotencyRaceError,
  );
});

// The log admits one anchor, whatever the idempotency key.
test('insertEvent of a second registry.anchored event throws ConflictError', async () => {
  const params = {
    kind: 'registry.anchored',
    request: {},
    outcome: {},
    signature: makeSignature(),
    createdAt: new Date(),
  };

  await insertEvent(pool, { ...params, idempotencyKey: generateUUIDv7() });

  await assert.rejects(
    () => insertEvent(pool, { ...params, idempotencyKey: generateUUIDv7() }),
    (error: unknown) =>
      error instanceof ConflictError && error.message === 'The registry is already anchored.',
  );
  assert.equal((await findEvents(pool)).length, 1);
});

// A failed insert burns a sequence value, as an aborted transaction does, so
// the log below has a gap between its second and third events. Each page
// resumes after the last sequence it read and loses nothing across the gap.
test('findEvents reads the log a window at a time, across a gap in sequence', async () => {
  const keys = [generateUUIDv7(), generateUUIDv7(), generateUUIDv7(), generateUUIDv7()];
  for (const [index, idempotencyKey] of keys.entries()) {
    const params = {
      idempotencyKey,
      kind: 'subject.registered',
      request: {},
      outcome: {},
      signature: makeSignature(),
      createdAt: new Date(),
    };
    await insertEvent(pool, params);
    if (index === 1) await assert.rejects(() => insertEvent(pool, params));
  }

  const first = await findEvents(pool, { limit: 2 });
  const second = await findEvents(pool, { afterSequence: first[1]?.sequence ?? 0, limit: 2 });
  const third = await findEvents(pool, { afterSequence: second[1]?.sequence ?? 0, limit: 2 });

  assert.deepEqual(
    first.map((event) => event.idempotencyKey),
    keys.slice(0, 2),
  );
  assert.deepEqual(
    second.map((event) => event.idempotencyKey),
    keys.slice(2),
  );
  assert.deepEqual(third, []);
  assert.equal(second[0]?.sequence, (first[1]?.sequence ?? 0) + 2);
  assert.deepEqual(await findEvents(pool), [...first, ...second]);
});

// ---------------------------------------------------------------------------
// Signature of a stored event
// ---------------------------------------------------------------------------

// An event as the log stores it, signed by a new key, and that key as the
// registry records it. No database: the check reads only the event and the
// key it is given.
function makeSignedEvent() {
  const { publicKey, privateKey } = generateTestKey();
  const key = { id: generateUUIDv7(), algorithm: 'ecdsa-p256-sha256' as const, value: publicKey };
  const idempotencyKey = generateUUIDv7();
  const request = { subject: { kind: 'person' as const }, ename: { namePart: 'jean-dupont' } };
  const event: Event = {
    sequence: 1,
    idempotencyKey,
    kind: subjectRegisteredEventKindDefinition.kind,
    request,
    outcome: {},
    signature: signRequest(
      subjectRegisteredEventKindDefinition,
      { keyId: key.id, privateKey },
      { idempotencyKey, request },
    ),
    createdAt: new Date(),
  };
  return { event, key };
}

test('isEventSignatureValid verifies a stored event against the key it names', () => {
  const { event, key } = makeSignedEvent();

  assert.equal(isEventSignatureValid(subjectRegisteredEventKindDefinition, event, key), true);
});

// The definition differs from the event's by its kind alone: the operation
// is the same, so the signature itself would verify.
test('isEventSignatureValid refuses an event of another kind than the definition', () => {
  const { event, key } = makeSignedEvent();
  const otherKind = defineEventKind({
    ...subjectRegisteredEventKindDefinition,
    kind: 'subject.ename-added',
  });

  assert.equal(isEventSignatureValid(otherKind, event, key), false);
});

// The same public key under another id: the signature itself would verify,
// but the event names the key it was signed by.
test('isEventSignatureValid refuses a key other than the one the event names, even with the same public key', () => {
  const { event, key } = makeSignedEvent();

  assert.equal(
    isEventSignatureValid(subjectRegisteredEventKindDefinition, event, {
      ...key,
      id: generateUUIDv7(),
    }),
    false,
  );
});
