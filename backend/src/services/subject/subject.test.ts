import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { pino } from 'pino';

import { pool } from '../../database/pool.ts';
import { withTransaction } from '../../database/query.ts';
import { useTestDb } from '../../database/testing.ts';
import { generateUUIDv7, UUIDV7_REGEX } from '../../uuid.ts';

import { findSubjects, getSubject, insertSubject } from './subject.ts';

// Direct tests of the subject data-access primitives (insert + read round-trip).
// Tested in isolation so use-case tests can read state back through them and
// trust the result — see ename-internals.md.
const logger = pino({ level: 'silent' });

useTestDb();

test('insertSubject then read back by id and via findSubjects', async () => {
  const id = generateUUIDv7();
  const createdAt = new Date();

  await withTransaction(
    pool,
    (client) => insertSubject(client, { id, kind: 'person', createdAt }),
    logger,
  );

  const found = await getSubject(id);
  assert.ok(found);
  assert.equal(found.id, id);
  assert.equal(found.kind, 'person');
  assert.match(found.id, UUIDV7_REGEX);
  assert.equal(found.createdAt.getTime(), createdAt.getTime());

  const all = await findSubjects();
  assert.equal(all.length, 1);
  assert.equal(all[0]?.id, id);
});

test('getSubject returns undefined for an unknown id', async () => {
  assert.equal(await getSubject(generateUUIDv7()), undefined);
});

test('findSubjects returns every inserted subject', async () => {
  const ids = [generateUUIDv7(), generateUUIDv7(), generateUUIDv7()];
  await withTransaction(
    pool,
    async (client) => {
      for (const id of ids) {
        await insertSubject(client, { id, kind: 'person', createdAt: new Date() });
      }
    },
    logger,
  );

  const all = await findSubjects();
  assert.equal(all.length, ids.length);
  assert.deepEqual(new Set(all.map((subject) => subject.id)), new Set(ids));
});
