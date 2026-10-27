import type { Database } from '../../database/query.ts';

import { type EventKindDefinition, parseEvent } from './event-kind.ts';
import type { Event } from './event.ts';

// ---------------------------------------------------------------------------
// rebuildEvent — writing an event's rows again
// ---------------------------------------------------------------------------

// Write again the rows a stored event records, through the definition of its
// kind: the event read back by its `fromEvent`, then written as is by its
// `rebuild`. Every value comes from the event — ids, allocated counters,
// createdAt — so nothing is allocated, and no event is written: the log is
// read, never appended to. The caller chose the definition by the event's
// kind, and owns the transaction: an event that writes several rows is atomic
// only on a transaction's client. A rebuild walks the log in sequence order
// and calls this once per event (cf. ename-internals.md).
export async function rebuildEvent<Definition extends EventKindDefinition>(
  db: Database,
  definition: Definition,
  event: Event,
): Promise<void> {
  await definition.rebuild(db, definition.fromEvent(parseEvent(definition, event)));
}
