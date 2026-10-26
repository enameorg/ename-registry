import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { pool } from '../../database/pool.ts';
import { readCheckConstraintValues, useTestDb } from '../../database/testing.ts';
import { generateUUIDv7, UUIDV7_REGEX } from '../../utilities/uuid.ts';

import { findSubjects, getSubject, insertSubject, SubjectKindSchema } from './subject.ts';

// Direct tests of the subject data-access primitives (insert + read
// round-trip), then the kind vocabulary against its CHECK. The primitives are
// tested in isolation so use-case tests can read state back through them and
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

// The subject kind vocabulary is declared once in code (SubjectKindSchema) and
// once in the database (the subjects_kind_allowed CHECK); this pins that the
// two agree, in both directions, so a kind added on one side only fails by name.
test('the subject kinds SubjectKindSchema declares are exactly the kinds the subjects_kind_allowed CHECK admits', async () => {
  const admitted = await readCheckConstraintValues('subjects_kind_allowed');

  assert.deepEqual(
    admitted.toSorted(),
    [...SubjectKindSchema.options].toSorted(),
    'subjects.kind: the CHECK and SubjectKindSchema disagree',
  );
});
