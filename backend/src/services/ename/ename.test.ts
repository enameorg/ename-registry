import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';

import { pino } from 'pino';

import { pool } from '../../database/pool.ts';
import { withTransaction } from '../../database/query.ts';
import { useTestDb, waitForLockedStatement } from '../../database/testing.ts';
import { generateUUIDv7 } from '../../utilities/uuid.ts';
import { ConflictError, DomainError, NotFoundError, ValidationError } from '../errors.ts';
import { insertSubject } from '../subject/index.ts';

import {
  type Ename,
  findEnames,
  getEnameByNamePartAndNumberPart,
  insertEname,
  insertEnameWithNextNumber,
  NamePartSchema,
} from './ename.ts';

// Direct tests of the ename data-access primitives (see ename-internals.md).
// Both inserts require an existing subject (enames.subject_id FK), so each
// insert test seeds one through the subject primitive.
//
// What the primitive writes to the logger it receives is part of its observable
// surface: the logger captures every warning as a parsed line, and a test
// asserts on the lines it expects (cf. ename-internals.md).
type LogLine = { msg: string } & Record<string, unknown>;
const logLines: LogLine[] = [];
const logger = pino(
  { level: 'warn' },
  {
    write(line: string) {
      logLines.push(JSON.parse(line) as LogLine);
    },
  },
);

useTestDb();

beforeEach(() => {
  logLines.length = 0;
});

async function seedSubject(): Promise<string> {
  const subjectId = generateUUIDv7();
  await insertSubject(pool, { id: subjectId, kind: 'person', createdAt: new Date() });
  return subjectId;
}

// Every allocation is one INSERT: called with the pool, each runs in its own
// transaction, so no test opens one.
async function allocate(params: {
  enameId?: string;
  subjectId: string;
  namePart: string;
  createdAt?: Date;
}): Promise<Ename> {
  return await insertEnameWithNextNumber(
    pool,
    {
      enameId: params.enameId ?? generateUUIDv7(),
      subjectId: params.subjectId,
      namePart: params.namePart,
      createdAt: params.createdAt ?? new Date(),
    },
    logger,
  );
}

test('insertEnameWithNextNumber allocates numberPart 1 and round-trips via getEnameByNamePartAndNumberPart/findEnames', async () => {
  const subjectId = await seedSubject();
  const enameId = generateUUIDv7();
  const createdAt = new Date();

  const inserted = await allocate({ enameId, subjectId, namePart: 'jean-dupont', createdAt });
  assert.equal(inserted.numberPart, 1);

  const found = await getEnameByNamePartAndNumberPart(pool, {
    namePart: 'jean-dupont',
    numberPart: 1,
  });
  assert.ok(found);
  assert.deepEqual(inserted, found);
  assert.equal(found.id, enameId);
  assert.equal(found.subjectId, subjectId);
  assert.equal(found.namePart, 'jean-dupont');
  assert.equal(found.numberPart, 1);
  assert.equal(found.createdAt.getTime(), createdAt.getTime());

  assert.equal((await findEnames(pool)).length, 1);
});

test('insertEnameWithNextNumber allocates consecutive numberParts per namePart', async () => {
  const firstSubjectId = await seedSubject();
  const secondSubjectId = await seedSubject();
  const namePart = 'marie-curie';

  const first = await allocate({ subjectId: firstSubjectId, namePart });
  const second = await allocate({ subjectId: secondSubjectId, namePart });

  assert.equal(first.numberPart, 1);
  assert.equal(second.numberPart, 2);
});

// Two allocations for one namePart read the same MAX(number_part) and collide
// on the UNIQUE constraint; the loser must retry and take the next number. The
// collision is forced, not hoped for: a holder keeps (martin, 1) uncommitted
// while the loser allocates on the pool — it reads MAX over committed rows
// only, picks 1 too, and its INSERT waits on the holder's index entry. The
// holder commits once the catalog shows the loser waiting, so the loser gets
// the unique violation, retries, and reads 1 → 2. Without the retry the loser
// would reject instead of returning 2.
test('insertEnameWithNextNumber retries a number_part collision: the loser takes the next number and logs the collision', async () => {
  const holderSubjectId = await seedSubject();
  const loserSubjectId = await seedSubject();
  const namePart = 'martin';

  let loser: Promise<Ename> | undefined;
  await withTransaction(
    pool,
    async (db) => {
      const holderNumberPart = await insertEnameWithNextNumber(
        db,
        { enameId: generateUUIDv7(), subjectId: holderSubjectId, namePart, createdAt: new Date() },
        logger,
      );
      assert.equal(holderNumberPart.numberPart, 1);

      loser = allocate({ subjectId: loserSubjectId, namePart });
      await waitForLockedStatement();
      // Returning commits the holder.
    },
    logger,
  );

  assert.ok(loser);
  assert.equal((await loser).numberPart, 2);
  assert.deepEqual((await findEnames(pool)).map((ename) => ename.numberPart).sort(), [1, 2]);

  const collisions = logLines.filter(
    (line) => line.msg === 'number_part collision on enames insert, retrying',
  );
  assert.deepEqual(
    collisions.map((line) => ({ namePart: line['namePart'], attempt: line['attempt'] })),
    [{ namePart: 'martin', attempt: 1 }],
  );
});

test('insertEnameWithNextNumber rejects a duplicate namePart for the same subject', async () => {
  const subjectId = await seedSubject();
  const namePart = 'marie-curie';

  await allocate({ subjectId, namePart });

  await assert.rejects(
    () => allocate({ subjectId, namePart }),
    (error: unknown) =>
      error instanceof ConflictError &&
      error.message === 'This subject already has an ename with this namePart.',
  );
});

test('insertEnameWithNextNumber rejects an unknown subjectId', async () => {
  await assert.rejects(
    () => allocate({ subjectId: generateUUIDv7(), namePart: 'jean-dupont' }),
    (error: unknown) => error instanceof NotFoundError && error.message === 'Subject not found.',
  );
});

test('insertEnameWithNextNumber rejects an allocation whose full ename would exceed 52 characters, pointing at ename.namePart', async () => {
  // 50 + "#" + 1 digit = 52 for numberParts 1..9; the tenth would be 53.
  const namePart = 'a'.repeat(50);
  for (let index = 0; index < 9; index += 1) {
    await allocate({ subjectId: await seedSubject(), namePart });
  }

  const tenthSubjectId = await seedSubject();
  await assert.rejects(
    () => allocate({ subjectId: tenthSubjectId, namePart }),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.match(error.message, /52/);
      assert.ok(
        error.errors.some((issue) => issue.path[0] === 'ename' && issue.path[1] === 'namePart'),
      );
      return true;
    },
  );
  assert.equal((await findEnames(pool)).length, 9);
});

// The rebuild's insert: the numberPart is the one given, not the next free one.
test('insertEname writes the ename exactly as given, numberPart included, and round-trips', async () => {
  const ename: Ename = {
    id: generateUUIDv7(),
    subjectId: await seedSubject(),
    namePart: 'jean-dupont',
    numberPart: 7,
    createdAt: new Date('2026-05-27T14:32:11.123Z'),
  };

  const inserted = await insertEname(pool, ename);

  assert.deepEqual(inserted, ename);
  assert.deepEqual(await findEnames(pool), [ename]);
});

// Nothing is translated: at a rebuild a violation is a corrupted log or
// projections that were not empty, never a fault of the client.
test('insertEname lets a constraint violation surface raw, never as a domain error', async () => {
  const subjectId = await seedSubject();
  const first = await allocate({ subjectId, namePart: 'jean-dupont' });

  await assert.rejects(
    () => insertEname(pool, { ...first, id: generateUUIDv7() }),
    (error: unknown) =>
      !(error instanceof DomainError) &&
      error instanceof Error &&
      'code' in error &&
      error.code === '23505',
  );
});

test('getEnameByNamePartAndNumberPart returns undefined for an unknown ename', async () => {
  assert.equal(
    await getEnameByNamePartAndNumberPart(pool, { namePart: 'nobody', numberPart: 1 }),
    undefined,
  );
});

// NamePartSchema is the pure namePart grammar (docs/ename-format.md): the single
// definition every layer parses a namePart through, so one expected-value list
// here covers the HTTP body, the event request and the projection row alike.
test('NamePartSchema accepts the namePart grammar and rejects everything else with the grammar message', () => {
  for (const namePart of ['a', 'jean', 'jean-dupont', 'a'.repeat(50)]) {
    assert.equal(NamePartSchema.safeParse(namePart).success, true, namePart);
  }
  for (const namePart of ['Jean', 'jean42', '-jean', 'jean-', 'jean--dupont', 'jean dupont', 'é']) {
    const result = NamePartSchema.safeParse(namePart);
    assert.equal(result.success, false, namePart);
    assert.equal(
      result.error?.issues[0]?.message,
      'must be lowercase letters separated by single hyphens (no leading, trailing or consecutive hyphens)',
    );
  }
  assert.equal(NamePartSchema.safeParse('a'.repeat(51)).success, false);
});
