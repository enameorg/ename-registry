import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { pino } from 'pino';

import { pool } from '../../database/pool.ts';
import {
  readCheckConstraintValues,
  truncateProjections,
  useTestDatabase,
} from '../../database/testing.ts';
import { generateUUIDv7 } from '../../utilities/uuid.ts';
import { findEnames } from '../ename/index.ts';
import { findEvents } from '../event/index.ts';
import { findKeys } from '../key/index.ts';
import {
  addPlatformKey,
  findPlatforms,
  platformKeyAddedEventKindDefinition,
} from '../platform/index.ts';
import {
  addEnameToSubject,
  findSubjects,
  registerSubject,
  subjectEnameAddedEventKindDefinition,
  subjectRegisteredEventKindDefinition,
} from '../subject/index.ts';
import {
  accreditTestPlatform,
  generateTestKey,
  setUpTestPlatform,
  signInput,
  type TestPlatformSigner,
  type TestSigner,
} from '../testing.ts';

import { eventKindDefinitions, rebuildProjections } from './rebuild-projections.ts';

// The walk over the whole log: the definition of each event found by its kind, the batches, the
// stop. Each kind's own rebuild is tested beside its use case; this file proves what only the walk
// does. Test doctrine: ename-internals.md.
const context = { logger: pino({ level: 'silent' }) };

useTestDatabase();

// A kind a migration admits before its definition is listed, and a listed definition with no
// migration, both fail here by name; a definition neither listed nor migrated fails in its own
// use-case tests.
test('the event kinds the rebuild knows are exactly the kinds the events_kind_allowed CHECK admits', async () => {
  const admitted = await readCheckConstraintValues('events_kind_allowed');
  const declared = eventKindDefinitions.map((definition) => definition.kind);

  assert.deepEqual(
    admitted.toSorted(),
    declared.toSorted(),
    'events.kind: the CHECK and the definitions in code disagree',
  );
});

// Events of every kind, interleaved, homonyms included: the anchor, two accreditations, a key added
// to the first platform, then registrations and additions by both platforms. Each batch size ends
// the walk differently: on full batches then an empty read (1, 10), on an incomplete batch (3), in
// a single incomplete batch (the default).
test('rebuildProjections writes back exactly the projections the use cases wrote, whatever the batch size', async () => {
  const { registry, platform } = await setUpTestPlatform();
  const other = await accreditTestPlatform(registry);
  await addKey(registry, platform);
  const jean = await register(platform, 'jean-dupont');
  await register(other, 'jean-dupont');
  const marie = await register(platform, 'marie-curie');
  await addEname(platform, jean.subject.id, 'marie-curie');
  await addEname(platform, marie.subject.id, 'jean-dupont');

  const platforms = await findPlatforms(pool);
  const keys = await findKeys(pool);
  const subjects = await findSubjects(pool);
  const enames = await findEnames(pool);
  const events = await findEvents(pool);
  assert.deepEqual(
    events.map((event) => event.kind),
    [
      'registry.anchored',
      'platform.accredited',
      'platform.accredited',
      'platform.key-added',
      'subject.registered',
      'subject.registered',
      'subject.registered',
      'subject.ename-added',
      'subject.ename-added',
    ],
  );

  for (const batchSize of [1, 3, 10, undefined]) {
    await truncateProjections();
    assert.deepEqual(await findKeys(pool), []);

    await rebuildProjections(context, batchSize === undefined ? {} : { batchSize });

    assert.deepEqual(await findPlatforms(pool), platforms, `batch size ${batchSize}`);
    assert.deepEqual(await findKeys(pool), keys, `batch size ${batchSize}`);
    assert.deepEqual(await findSubjects(pool), subjects, `batch size ${batchSize}`);
    assert.deepEqual(await findEnames(pool), enames, `batch size ${batchSize}`);
    assert.deepEqual(await findEvents(pool), events, `batch size ${batchSize}`);
  }
});

test('rebuildProjections over an empty log writes nothing', async () => {
  await rebuildProjections(context);

  assert.deepEqual(await findPlatforms(pool), []);
  assert.deepEqual(await findKeys(pool), []);
  assert.deepEqual(await findSubjects(pool), []);
  assert.deepEqual(await findEnames(pool), []);
});

async function addKey(registry: TestSigner, platform: TestPlatformSigner) {
  return await addPlatformKey(
    signInput(platformKeyAddedEventKindDefinition, registry, {
      idempotencyKey: generateUUIDv7(),
      platform: { id: platform.platformId },
      key: { algorithm: 'ecdsa-p256-sha256', value: generateTestKey().publicKey },
    }),
    context,
  );
}

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

async function addEname(platform: TestPlatformSigner, subjectId: string, namePart: string) {
  return await addEnameToSubject(
    signInput(subjectEnameAddedEventKindDefinition, platform, {
      idempotencyKey: generateUUIDv7(),
      subject: { id: subjectId },
      ename: { namePart },
    }),
    context,
  );
}
