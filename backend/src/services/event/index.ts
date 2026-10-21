// Public surface of the `event` concept
export { appendEvent } from './append-event.ts';
export type { AppendEventResult } from './append-event.ts';
// insertEvent stays inside the concept: appendEvent is the log's only write path
// (cf. ename-internals.md).
export { EventSchema, findEvents, getEventByIdempotencyKey } from './event.ts';
export type { Event } from './event.ts';
export type { EventKindDefinition, EventOutcome, EventRequest } from './event-kind.ts';
