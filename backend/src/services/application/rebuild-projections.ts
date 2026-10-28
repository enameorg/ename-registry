import { pool } from '../../database/pool.ts';
import { withTransaction } from '../../database/query.ts';
import type { ServiceContext } from '../context.ts';
import { type Event, type EventKindDefinition, findEvents, rebuildEvent } from '../event/index.ts';
import {
  subjectEnameAddedEventKindDefinition,
  subjectRegisteredEventKindDefinition,
} from '../subject/index.ts';

// Every event kind definition the use cases declare, listed here and nowhere
// else: a new kind is added here. The events.kind CHECK is the authoritative
// list of kinds, and rebuild-projections.test.ts names any kind on which the
// two disagree.
export const eventKindDefinitions: readonly EventKindDefinition[] = [
  subjectRegisteredEventKindDefinition,
  subjectEnameAddedEventKindDefinition,
];

const eventKindDefinitionsByKind = new Map(
  eventKindDefinitions.map((definition) => [definition.kind, definition]),
);

// Not measured: the right size depends on the size of the events and on the
// query cap of the hosting database, neither known yet.
const DEFAULT_BATCH_SIZE = 1_000;

// Write every projection again from the event log, in sequence order, each
// event through the definition of its kind (cf. ename-internals.md). The
// caller empties the projections first and runs no write meanwhile: this
// writes only what the log records. The log is read a batch at a time, each
// batch rebuilt in a transaction of its own, so memory and transaction length
// stay bounded; an interrupted rebuild leaves a prefix of the log written, and
// the caller empties the projections and starts again.
export async function rebuildProjections(
  context: ServiceContext,
  { batchSize = DEFAULT_BATCH_SIZE }: { batchSize?: number } = {},
): Promise<void> {
  let afterSequence = 0;
  for (;;) {
    const events = await findEvents(pool, { afterSequence, limit: batchSize });
    const last = events.at(-1);
    if (last === undefined) return;

    await withTransaction(
      pool,
      async (db) => {
        for (const event of events) {
          await rebuildEvent(db, findEventKindDefinition(event), event);
        }
      },
      context.logger,
    );

    if (events.length < batchSize) return;
    afterSequence = last.sequence;
  }
}

// A kind with no definition is a bug or a corrupted log, never the client's
// fault, so the error stays raw.
function findEventKindDefinition(event: Event): EventKindDefinition {
  const definition = eventKindDefinitionsByKind.get(event.kind);
  if (definition === undefined) {
    throw new Error(`no event kind definition for ${event.kind} (sequence ${event.sequence})`);
  }
  return definition;
}
