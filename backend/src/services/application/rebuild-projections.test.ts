import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { pino } from 'pino';

// The walk over the whole log: the definition of each event found by its
// kind, the batches, the stop. Each kind's own rebuild is tested beside its
// use case; this file proves what only the walk does. Test doctrine:
// ename-internals.md.
import { pool } from '../../database/pool.ts';
import {
  readCheckConstraintValues,
  truncateProjections,
  useTestDatabase,
} from '../../database/testing.ts';
import { generateUUIDv7 } from '../../utilities/uuid.ts';
import { findEnames } from '../ename/index.ts';
import { findEvents } from '../event/index.ts';
import { addEnameToSubject, findSubjects, registerSubject } from '../subject/index.ts';

import { eventKindDefinitions, rebuildProjections } from './rebuild-projections.ts';

const context = { logger: pino({ level: 'silent' }) };

useTestDatabase();

// A kind a migration admits before its definition is listed, and a listed
// definition with no migration, both fail here by name; a definition neither
// listed nor migrated fails in its own use-case tests.
test('the event kinds the rebuild knows are exactly the kinds the events_kind_allowed CHECK admits', async () => {
  const admitted = await readCheckConstraintValues('events_kind_allowed');
  const declared = eventKindDefinitions.map((definition) => definition.kind);

  assert.deepEqual(
    admitted.toSorted(),
    declared.toSorted(),
    'events.kind: the CHECK and the definitions in code disagree',
  );
});

// Five events of both kinds, interleaved, homonyms included. Each batch size
// ends the walk differently: on full batches then an empty read (1, 5), on an
// incomplete batch (2), in a single incomplete batch (the default).
test('rebuildProjections writes back exactly the projections the use cases wrote, whatever the batch size', async () => {
  const jean = await register('jean-dupont');
  await register('jean-dupont');
  const marie = await register('marie-curie');
  await addEname(jean.subject.id, 'marie-curie');
  await addEname(marie.subject.id, 'jean-dupont');

  const subjects = await findSubjects(pool);
  const enames = await findEnames(pool);
  const events = await findEvents(pool);
  assert.deepEqual(
    events.map((event) => event.kind),
    [
      'subject.registered',
      'subject.registered',
      'subject.registered',
      'subject.ename-added',
      'subject.ename-added',
    ],
  );

  for (const batchSize of [1, 2, 5, undefined]) {
    await truncateProjections();
    assert.deepEqual(await findEnames(pool), []);

    await rebuildProjections(context, batchSize === undefined ? {} : { batchSize });

    assert.deepEqual(await findSubjects(pool), subjects, `batch size ${batchSize}`);
    assert.deepEqual(await findEnames(pool), enames, `batch size ${batchSize}`);
    assert.deepEqual(await findEvents(pool), events, `batch size ${batchSize}`);
  }
});

test('rebuildProjections over an empty log writes nothing', async () => {
  await rebuildProjections(context);

  assert.deepEqual(await findSubjects(pool), []);
  assert.deepEqual(await findEnames(pool), []);
});

async function register(namePart: string) {
  return await registerSubject(
    { idempotencyKey: generateUUIDv7(), subject: { kind: 'person' }, ename: { namePart } },
    context,
  );
}

async function addEname(subjectId: string, namePart: string) {
  return await addEnameToSubject(
    { idempotencyKey: generateUUIDv7(), subject: { id: subjectId }, ename: { namePart } },
    context,
  );
}
