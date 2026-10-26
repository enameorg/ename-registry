import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { pool } from '../../database/pool.ts';
import { useTestDb } from '../../database/testing.ts';
import { generateUUIDv7, UUIDV7_REGEX } from '../../utilities/uuid.ts';

import { findSubjects, getSubject, insertSubject } from './subject.ts';

// Direct tests of the subject data-access primitives (insert + read round-trip).
// Tested in isolation so use-case tests can read state back through them and
// trust the result — see ename-internals.md. A single-statement write needs no
// transaction, so the primitives are called with the pool directly.
useTestDb();

test('insertSubject then read back by id and via findSubjects', async () => {
  const id = generateUUIDv7();
  const createdAt = new Date();

  const inserted = await insertSubject(pool, { id, kind: 'person', createdAt });

  const found = await getSubject(pool, id);
  assert.ok(found);
  assert.deepEqual(inserted, found);
  assert.equal(found.id, id);
  assert.equal(found.kind, 'person');
  assert.match(found.id, UUIDV7_REGEX);
  assert.equal(found.createdAt.getTime(), createdAt.getTime());

  const all = await findSubjects(pool);
  assert.equal(all.length, 1);
  assert.equal(all[0]?.id, id);
});

test('getSubject returns undefined for an unknown id', async () => {
  assert.equal(await getSubject(pool, generateUUIDv7()), undefined);
});

test('findSubjects returns every inserted subject', async () => {
  const ids = [generateUUIDv7(), generateUUIDv7(), generateUUIDv7()];
  for (const id of ids) {
    await insertSubject(pool, { id, kind: 'person', createdAt: new Date() });
  }

  const all = await findSubjects(pool);
  assert.equal(all.length, ids.length);
  assert.deepEqual(new Set(all.map((subject) => subject.id)), new Set(ids));
});
