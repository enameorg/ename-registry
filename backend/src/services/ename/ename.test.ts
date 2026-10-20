import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { pino } from 'pino';

import { pool } from '../../database/pool.ts';
import { useTestDb } from '../../database/testing.ts';
import { generateUUIDv7 } from '../../utilities/uuid.ts';
import { ConflictError, NotFoundError, ValidationError } from '../errors.ts';
import { insertSubject } from '../subject/index.ts';

import {
  findEnames,
  getEnameByNamePartAndNumberPart,
  insertEnameWithNextNumber,
  NamePartSchema,
} from './ename.ts';

// Direct tests of the ename data-access primitives (see ename-internals.md).
// insertEnameWithNextNumber requires an existing subject (enames.subject_id FK),
// so each insert test seeds one through the subject primitive.
const logger = pino({ level: 'silent' });

useTestDb();

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
}): Promise<number> {
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

  const numberPart = await allocate({ enameId, subjectId, namePart: 'jean-dupont', createdAt });
  assert.equal(numberPart, 1);

  const found = await getEnameByNamePartAndNumberPart(pool, {
    namePart: 'jean-dupont',
    numberPart: 1,
  });
  assert.ok(found);
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

  assert.equal(first, 1);
  assert.equal(second, 2);
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
