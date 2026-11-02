import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { pino } from 'pino';
import { ZodError } from 'zod';

import { pool } from '../../database/pool.ts';
import { useTestDatabase } from '../../database/testing.ts';
import { generateUUIDv7 } from '../../utilities/uuid.ts';
import type { SignableDocument } from '../common/index.ts';
import {
  AuthenticationError,
  ConflictError,
  IdempotencyConflictError,
  UnavailableError,
  ValidationError,
} from '../errors.ts';
import {
  addPlatformKey,
  authenticatePlatform,
  platformAccreditedEventKindDefinition,
  platformKeyAddedEventKindDefinition,
} from '../platform/index.ts';
import { authenticateRegistry } from '../registry/index.ts';
import {
  findSubjects,
  insertSubject,
  type RegisterSubjectResult,
  subjectEnameAddedEventKindDefinition,
  subjectRegisteredEventKindDefinition,
} from '../subject/index.ts';
import {
  accreditTestPlatform,
  generateTestKey,
  makePlatformInput,
  setUpTestPlatform,
  signInput,
  signRequest,
  type TestPlatformSigner,
} from '../testing.ts';

import { defineEventKind } from './event-kind.ts';
import { findEvents, insertEvent } from './event.ts';
import { withEvent } from './with-event.ts';

// Tests of the write protocol at its own interface, with a real kind (the
// events.kind CHECK admits no test kind) and a work the test controls: it can
// return rows without touching a projection, throw a domain error, or wait
// for a concurrent commit, which makes every branch of the protocol
// deterministic. A first write returns the work's rows; a replay returns what
// the kind's fromEvent reads from the stored event. Every request is signed by
// the platform accredited before each test and authenticated by the real
// authenticatePlatform, unless the test is about what the protocol hands its
// authenticator. Which keys an authenticator admits is tested with the
// authenticator. Test doctrine: ename-internals.md.
const context = { logger: pino({ level: 'silent' }) };

useTestDatabase();

const request = { subject: { kind: 'person' as const }, ename: { namePart: 'jean-dupont' } };

// The rows a work returns, consistent with `request`, the event's createdAt and
// the platform that signed.
function makeRows(platformId: string, createdAt = new Date()): RegisterSubjectResult {
  const subjectId = generateUUIDv7();
  return {
    subject: { id: subjectId, kind: 'person', homePlatformId: platformId, createdAt },
    ename: { id: generateUUIDv7(), subjectId, namePart: 'jean-dupont', numberPart: 1, createdAt },
  };
}

// The outcome a concurrent winner stored.
function makeOutcome(platformId: string) {
  return {
    subject: { id: generateUUIDv7(), homePlatform: { id: platformId } },
    ename: { id: generateUUIDv7(), numberPart: 1 },
  };
}

// The signature of `request` (or another) under this idempotency key.
function sign(
  signer: TestPlatformSigner,
  idempotencyKey: string,
  requestToSign: typeof request = request,
) {
  return signRequest(subjectRegisteredEventKindDefinition, signer, {
    idempotencyKey,
    request: requestToSign,
  });
}

// The events a test writes, the setup's anchor and accreditation aside.
async function findSubjectEvents() {
  return (await findEvents(pool)).filter((event) => event.kind.startsWith('subject.'));
}

test('appends one event carrying the kind, the request, the outcome kept from the rows the work returned, the signer and a single createdAt', async () => {
  const { platform } = await setUpTestPlatform();
  const idempotencyKey = generateUUIDv7();
  const signature = sign(platform, idempotencyKey);
  let rows: RegisterSubjectResult | undefined;
  let workSigner: unknown;

  const appended = await withEvent(
    subjectRegisteredEventKindDefinition,
    {
      idempotencyKey,
      request,
      signature,
      authenticate: authenticatePlatform,
      work: (_db, createdAt, signer) => {
        workSigner = signer;
        rows = makeRows(signer.platformId, createdAt);
        return Promise.resolve(rows);
      },
    },
    context,
  );

  assert.ok(rows);
  assert.deepEqual(appended, rows);
  assert.deepEqual(workSigner, { keyId: platform.keyId, platformId: platform.platformId });

  const events = await findSubjectEvents();
  assert.equal(events.length, 1);
  const [event] = events;
  assert.ok(event);
  assert.equal(event.kind, 'subject.registered');
  assert.equal(event.idempotencyKey, idempotencyKey);
  assert.deepEqual(event.request, request);
  assert.deepEqual(event.outcome, subjectRegisteredEventKindDefinition.toOutcome(rows));
  assert.deepEqual(event.signature, signature);
  assert.equal(event.createdAt.getTime(), rows.subject.createdAt.getTime());
});

// ---------------------------------------------------------------------------
// The signer, authenticated before any lookup
// ---------------------------------------------------------------------------

test('the authenticator is given the signable document the protocol builds, and the work the signer it returns', async () => {
  const { platform } = await setUpTestPlatform();
  const idempotencyKey = generateUUIDv7();
  const signature = sign(platform, idempotencyKey);
  // Opaque to the protocol: whatever the authenticator returns reaches the
  // work.
  const signer = { platformId: platform.platformId };
  const calls: Array<{ document: SignableDocument; signatureValue: string }> = [];
  let workSigner: unknown;

  await withEvent(
    subjectRegisteredEventKindDefinition,
    {
      idempotencyKey,
      request,
      signature,
      authenticate: (_db, document, signatureValue) => {
        calls.push({ document, signatureValue });
        return Promise.resolve(signer);
      },
      work: (_db, createdAt, received) => {
        workSigner = received;
        return Promise.resolve(makeRows(platform.platformId, createdAt));
      },
    },
    context,
  );

  assert.deepEqual(calls, [
    {
      document: {
        operation: subjectRegisteredEventKindDefinition.operation,
        keyId: signature.keyId,
        idempotencyKey,
        request,
      },
      signatureValue: signature.value,
    },
  ]);
  assert.equal(workSigner, signer);
});

test('a signer the authenticator refuses gets neither a write nor a replay', async () => {
  const { platform } = await setUpTestPlatform();
  const idempotencyKey = generateUUIDv7();
  await withEvent(
    subjectRegisteredEventKindDefinition,
    {
      idempotencyKey,
      request,
      signature: sign(platform, idempotencyKey),
      authenticate: authenticatePlatform,
      work: (_db, createdAt, signer) => Promise.resolve(makeRows(signer.platformId, createdAt)),
    },
    context,
  );

  let workRuns = 0;
  const refusal = new AuthenticationError('The request signature could not be verified.');
  await assert.rejects(
    () =>
      withEvent(
        subjectRegisteredEventKindDefinition,
        {
          idempotencyKey,
          request,
          signature: sign(platform, idempotencyKey),
          authenticate: () => Promise.reject(refusal),
          work: () => {
            workRuns += 1;
            return Promise.resolve(makeRows(platform.platformId));
          },
        },
        context,
      ),
    (error: unknown) => error === refusal,
  );
  assert.equal(workRuns, 0);
  assert.equal((await findSubjectEvents()).length, 1);
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test('replays the stored result for the same idempotencyKey, signing key and request, without running the work again', async () => {
  const { platform } = await setUpTestPlatform();
  const idempotencyKey = generateUUIDv7();
  const first = await withEvent(
    subjectRegisteredEventKindDefinition,
    {
      idempotencyKey,
      request,
      signature: sign(platform, idempotencyKey),
      authenticate: authenticatePlatform,
      work: (_db, createdAt, signer) => Promise.resolve(makeRows(signer.platformId, createdAt)),
    },
    context,
  );

  let workRuns = 0;
  // A resend signs again: ECDSA gives another signature of the same document,
  // and the replay does not depend on its bytes.
  const second = await withEvent(
    subjectRegisteredEventKindDefinition,
    {
      idempotencyKey,
      request,
      signature: sign(platform, idempotencyKey),
      authenticate: authenticatePlatform,
      work: (_db, createdAt, signer) => {
        workRuns += 1;
        return Promise.resolve(makeRows(signer.platformId, createdAt));
      },
    },
    context,
  );

  assert.equal(workRuns, 0);
  // The replay reads the stored event back through fromEvent: the two paths
  // agree, the law each kind's test pins, here on the real kind.
  assert.deepEqual(second, first);
  assert.equal((await findSubjectEvents()).length, 1);
});

test('rejects the same idempotencyKey signed by another key, of the same platform or of another, without replaying its result', async () => {
  const { registry, platform } = await setUpTestPlatform();
  const idempotencyKey = generateUUIDv7();
  await withEvent(
    subjectRegisteredEventKindDefinition,
    {
      idempotencyKey,
      request,
      signature: sign(platform, idempotencyKey),
      authenticate: authenticatePlatform,
      work: (_db, createdAt, signer) => Promise.resolve(makeRows(signer.platformId, createdAt)),
    },
    context,
  );

  const { publicKey, privateKey } = generateTestKey();
  const secondKey = await addPlatformKey(
    signInput(platformKeyAddedEventKindDefinition, registry, {
      idempotencyKey: generateUUIDv7(),
      platform: { id: platform.platformId },
      key: { algorithm: 'ecdsa-p256-sha256', value: publicKey },
    }),
    context,
  );
  const otherSigners = [
    { keyId: secondKey.id, privateKey, platformId: platform.platformId },
    await accreditTestPlatform(registry),
  ];

  for (const otherSigner of otherSigners) {
    await assert.rejects(
      () =>
        withEvent(
          subjectRegisteredEventKindDefinition,
          {
            idempotencyKey,
            request,
            signature: sign(otherSigner, idempotencyKey),
            authenticate: authenticatePlatform,
            work: () => Promise.reject(new Error('unreachable')),
          },
          context,
        ),
      (error: unknown) => {
        assert.ok(error instanceof IdempotencyConflictError);
        assert.equal(
          error.message,
          'This idempotency key has already been used by another signer.',
        );
        return true;
      },
    );
  }
});

test('rejects the same idempotencyKey with a different request as an IdempotencyConflictError, without running the work', async () => {
  const { platform } = await setUpTestPlatform();
  const idempotencyKey = generateUUIDv7();
  await withEvent(
    subjectRegisteredEventKindDefinition,
    {
      idempotencyKey,
      request,
      signature: sign(platform, idempotencyKey),
      authenticate: authenticatePlatform,
      work: () => Promise.resolve(makeRows(platform.platformId)),
    },
    context,
  );

  const otherRequest = { ...request, ename: { namePart: 'other-name' } };
  let workRuns = 0;
  await assert.rejects(
    () =>
      withEvent(
        subjectRegisteredEventKindDefinition,
        {
          idempotencyKey,
          request: otherRequest,
          signature: sign(platform, idempotencyKey, otherRequest),
          authenticate: authenticatePlatform,
          work: () => {
            workRuns += 1;
            return Promise.resolve(makeRows(platform.platformId));
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
  assert.equal((await findSubjectEvents()).length, 1);
});

test('rejects the same idempotencyKey used by an event of another kind, before parsing its request', async () => {
  const { platform } = await setUpTestPlatform();
  const idempotencyKey = generateUUIDv7();
  // Seed a subject.ename-added row directly: its request has no subject.kind,
  // so a parse with the subject.registered schema would fail — the kind check
  // must come first.
  await insertEvent(pool, {
    idempotencyKey,
    kind: subjectEnameAddedEventKindDefinition.kind,
    request: { subject: { id: generateUUIDv7() }, ename: { namePart: 'jean-dupont' } },
    outcome: { ename: { id: generateUUIDv7(), numberPart: 2 } },
    signature: { keyId: platform.keyId, value: 'c2lnbmF0dXJl' },
    createdAt: new Date(),
  });

  await assert.rejects(
    () =>
      withEvent(
        subjectRegisteredEventKindDefinition,
        {
          idempotencyKey,
          request,
          signature: sign(platform, idempotencyKey),
          authenticate: authenticatePlatform,
          work: () => Promise.resolve(makeRows(platform.platformId)),
        },
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

test("loses the race at the events insert to a concurrent same-key commit, rolls back the projection writes and replays the winner's result", async () => {
  const { platform } = await setUpTestPlatform();
  const idempotencyKey = generateUUIDv7();
  const winnerOutcome = makeOutcome(platform.platformId);
  const winnerCreatedAt = new Date();
  const signature = sign(platform, idempotencyKey);

  const appended = await withEvent(
    subjectRegisteredEventKindDefinition,
    {
      idempotencyKey,
      request,
      signature,
      authenticate: authenticatePlatform,
      work: async (db, createdAt, signer) => {
        await insertSubject(db, {
          id: generateUUIDv7(),
          kind: 'person',
          homePlatformId: signer.platformId,
          createdAt,
        });
        // Another backend commits the same key, same request, on its own
        // connection, after our preliminary lookup and before our events
        // insert.
        await insertEvent(pool, {
          idempotencyKey,
          kind: subjectRegisteredEventKindDefinition.kind,
          request,
          outcome: winnerOutcome,
          signature,
          createdAt: winnerCreatedAt,
        });
        return makeRows(signer.platformId, createdAt);
      },
    },
    context,
  );

  assert.deepEqual(
    appended,
    subjectRegisteredEventKindDefinition.fromEvent({
      request,
      outcome: winnerOutcome,
      createdAt: winnerCreatedAt,
    }),
  );
  assert.equal((await findSubjectEvents()).length, 1);
  assert.equal((await findSubjects(pool)).length, 0);
});

test('a domain error raised by the work is reconciled against a concurrent same-key winner before it surfaces', async () => {
  const { platform } = await setUpTestPlatform();
  const idempotencyKey = generateUUIDv7();
  const winnerOutcome = makeOutcome(platform.platformId);
  const signature = sign(platform, idempotencyKey);

  const appended = await withEvent(
    subjectRegisteredEventKindDefinition,
    {
      idempotencyKey,
      request,
      signature,
      authenticate: authenticatePlatform,
      work: async () => {
        // The winner commits first; our projection write then hits a
        // current-state conflict that the winner explains.
        await insertEvent(pool, {
          idempotencyKey,
          kind: subjectRegisteredEventKindDefinition.kind,
          request,
          outcome: winnerOutcome,
          signature,
          createdAt: new Date(),
        });
        throw new ConflictError('This subject already has an ename with this namePart.');
      },
    },
    context,
  );

  assert.equal(appended.subject.id, winnerOutcome.subject.id);
  assert.equal(appended.ename.id, winnerOutcome.ename.id);
  assert.equal((await findSubjectEvents()).length, 1);
});

test('a domain error raised by the work with no winner surfaces as is, and nothing is written', async () => {
  const { platform } = await setUpTestPlatform();
  const idempotencyKey = generateUUIDv7();
  await assert.rejects(
    () =>
      withEvent(
        subjectRegisteredEventKindDefinition,
        {
          idempotencyKey,
          request,
          signature: sign(platform, idempotencyKey),
          authenticate: authenticatePlatform,
          work: async (db, createdAt, signer) => {
            await insertSubject(db, {
              id: generateUUIDv7(),
              kind: 'person',
              homePlatformId: signer.platformId,
              createdAt,
            });
            throw new ConflictError('This subject already has an ename with this namePart.');
          },
        },
        context,
      ),
    (error: unknown) => error instanceof ConflictError,
  );
  assert.deepEqual(await findSubjectEvents(), []);
  assert.equal((await findSubjects(pool)).length, 0);
});

// An unavailable database is not a current-state error: it surfaces as is,
// never reconciled against a winner, even one that committed, since the
// lookup would fail with it; the client's retry under the same key replays.
test('an UnavailableError raised by the work surfaces as is, even over a same-key winner', async () => {
  const { platform } = await setUpTestPlatform();
  const idempotencyKey = generateUUIDv7();
  const signature = sign(platform, idempotencyKey);
  const unavailable = new UnavailableError({
    cause: new Error('Connection terminated unexpectedly'),
  });

  await assert.rejects(
    () =>
      withEvent(
        subjectRegisteredEventKindDefinition,
        {
          idempotencyKey,
          request,
          signature,
          authenticate: authenticatePlatform,
          work: async () => {
            await insertEvent(pool, {
              idempotencyKey,
              kind: subjectRegisteredEventKindDefinition.kind,
              request,
              outcome: makeOutcome(platform.platformId),
              signature,
              createdAt: new Date(),
            });
            throw unavailable;
          },
        },
        context,
      ),
    (error: unknown) => error === unavailable,
  );
  assert.equal((await findSubjectEvents()).length, 1);
});

// ---------------------------------------------------------------------------
// The request and the outcome, strict at the seam that stores them
// ---------------------------------------------------------------------------

test('an invalid request fails before any write, and before its signature is checked', async () => {
  let workRuns = 0;
  await assert.rejects(
    () =>
      withEvent(
        subjectRegisteredEventKindDefinition,
        {
          idempotencyKey: generateUUIDv7(),
          // Cast: deliberately malformed to exercise the Service-side parse.
          request: {
            subject: { kind: 'robot' },
            ename: { namePart: 'x' },
          } as unknown as typeof request,
          signature: { keyId: generateUUIDv7(), value: 'c2lnbmF0dXJl' },
          authenticate: authenticatePlatform,
          work: () => {
            workRuns += 1;
            return Promise.reject(new Error('unreachable'));
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
  assert.deepEqual(await findEvents(pool), []);
});

test('a request carrying a field the kind does not declare fails before any write, never stripped', async () => {
  let workRuns = 0;
  await assert.rejects(
    () =>
      withEvent(
        subjectRegisteredEventKindDefinition,
        {
          idempotencyKey: generateUUIDv7(),
          // Cast: a field the kind does not know, nested in an entity object —
          // what a wire schema ahead of the kind definition would let through.
          request: {
            subject: { kind: 'person', publicKey: 'not-yet-a-field' },
            ename: { namePart: 'jean-dupont' },
          } as unknown as typeof request,
          signature: { keyId: generateUUIDv7(), value: 'c2lnbmF0dXJl' },
          authenticate: authenticatePlatform,
          work: () => {
            workRuns += 1;
            return Promise.reject(new Error('unreachable'));
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
  assert.deepEqual(await findEvents(pool), []);
});

test('a signature of the wrong form fails as a ValidationError before its signer is authenticated', async () => {
  let authentications = 0;
  await assert.rejects(
    () =>
      withEvent(
        subjectRegisteredEventKindDefinition,
        {
          idempotencyKey: generateUUIDv7(),
          request,
          signature: { keyId: 'not-a-uuid', value: 'c2lnbmF0dXJl' },
          authenticate: () => {
            authentications += 1;
            return Promise.reject(new Error('unreachable'));
          },
          work: () => Promise.reject(new Error('unreachable')),
        },
        context,
      ),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.deepEqual(
        error.errors.map((issue) => issue.path),
        [['signature', 'keyId']],
      );
      return true;
    },
  );
  assert.equal(authentications, 0);
  assert.deepEqual(await findEvents(pool), []);
});

test('an idempotency key of the wrong form fails as a ValidationError before its signer is authenticated', async () => {
  let authentications = 0;
  await assert.rejects(
    () =>
      withEvent(
        subjectRegisteredEventKindDefinition,
        {
          idempotencyKey: 'not-a-uuid',
          request,
          signature: { keyId: generateUUIDv7(), value: 'c2lnbmF0dXJl' },
          authenticate: () => {
            authentications += 1;
            return Promise.reject(new Error('unreachable'));
          },
          work: () => Promise.reject(new Error('unreachable')),
        },
        context,
      ),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.deepEqual(
        error.errors.map((issue) => issue.path),
        [['idempotencyKey']],
      );
      return true;
    },
  );
  assert.equal(authentications, 0);
  assert.deepEqual(await findEvents(pool), []);
});

// The real kind with a toOutcome that keeps a field the kind does not declare:
// what a kind whose outcome schema lags behind its toOutcome would do. A fault
// of the kind, not of the caller, so it surfaces as the raw ZodError, never as
// a ValidationError.
const leakyDefinition = defineEventKind({
  ...subjectRegisteredEventKindDefinition,
  toOutcome: (result: RegisterSubjectResult) => ({
    ...subjectRegisteredEventKindDefinition.toOutcome(result),
    platform: { id: generateUUIDv7() },
  }),
});

test('an outcome carrying a field the kind does not declare rolls the event back, projection writes included', async () => {
  const { platform } = await setUpTestPlatform();
  const idempotencyKey = generateUUIDv7();
  await assert.rejects(
    () =>
      withEvent(
        leakyDefinition,
        {
          idempotencyKey,
          request,
          signature: sign(platform, idempotencyKey),
          authenticate: authenticatePlatform,
          work: async (db, createdAt, signer) => {
            await insertSubject(db, {
              id: generateUUIDv7(),
              kind: 'person',
              homePlatformId: signer.platformId,
              createdAt,
            });
            return makeRows(signer.platformId, createdAt);
          },
        },
        context,
      ),
    (error: unknown) => error instanceof ZodError,
  );
  assert.deepEqual(await findSubjectEvents(), []);
  assert.equal((await findSubjects(pool)).length, 0);
});

// ---------------------------------------------------------------------------
// What a request must be to be signed
// ---------------------------------------------------------------------------

test('a request no signature can cover fails as a ValidationError before its signature is checked, never as a library error', async () => {
  let workRuns = 0;
  await assert.rejects(
    () =>
      withEvent(
        platformAccreditedEventKindDefinition,
        {
          idempotencyKey: generateUUIDv7(),
          // A lone surrogate, which a JSON body can carry and JCS cannot
          // canonicalize: verifying the signature would throw.
          request: {
            platform: { ...makePlatformInput(), legalName: 'ACME \ud800' },
            key: { algorithm: 'ecdsa-p256-sha256', value: generateTestKey().publicKey },
          },
          signature: { keyId: generateUUIDv7(), value: 'c2lnbmF0dXJl' },
          authenticate: authenticateRegistry,
          work: () => {
            workRuns += 1;
            return Promise.reject(new Error('unreachable'));
          },
        },
        context,
      ),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.deepEqual(error.errors, [
        { path: ['platform', 'legalName'], message: 'must be well-formed Unicode text' },
      ]);
      return true;
    },
  );
  assert.equal(workRuns, 0);
  assert.deepEqual(await findEvents(pool), []);
});
