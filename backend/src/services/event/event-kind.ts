import type { z } from 'zod';

import type { Database } from '../../database/query.ts';

import type { Event } from './event.ts';

// ---------------------------------------------------------------------------
// Event kind definition — the shape every kind takes
// ---------------------------------------------------------------------------

// An event kind is the kind literal, the pair of schemas that parse its two
// JSONB columns — `request` is what the actor submitted, `outcome` what the
// server allocated (ADR-0004) — and the three functions that relate the event
// to the rows its use case writes (the use case's result, in the concept's own
// types: a `Subject`, an `Ename`). `toOutcome` keeps of the result what the
// server allocated; `fromEvent` reads a whole event back into the result, and
// each kind's test pins that the two agree: fromEvent({ request,
// toOutcome(result), createdAt }) is result. `rebuild` writes that result as
// is, allocating nothing: the second way the kind's rows get written, beside
// the use case's work, and each kind's rebuild test pins that both write the
// same rows. Both schemas are strict at every level: what enters the log is
// exactly what was submitted or allocated, never a stripped copy, so a field
// the wire accepts but the kind does not know fails loudly instead of being
// lost. A kind is declared by the use case that emits it
// (`services/subject/register-subject.ts`), so this concept imports no
// aggregate; the events.kind CHECK is the authoritative list of kinds, and
// event.test.ts pins that the definitions agree with it. withEvent takes a
// definition to write one event, rebuildEvent to write an event's rows again,
// and both read a stored event through parseEvent (withEvent on a replay).
export type EventKindDefinition<
  RequestSchema extends z.ZodType = z.ZodType,
  OutcomeSchema extends z.ZodType = z.ZodType,
  Result = unknown,
> = {
  readonly kind: string;
  readonly requestSchema: RequestSchema;
  readonly outcomeSchema: OutcomeSchema;
  // A method signature on purpose: it is checked bivariantly, so a kind whose
  // toOutcome takes its own Result still satisfies the bare constraint
  // `extends EventKindDefinition` (a function-typed property would demand
  // `(result: unknown)`). fromEvent returns Result and needs no such care.
  toOutcome(result: Result): z.infer<OutcomeSchema>;
  readonly fromEvent: (event: {
    request: z.infer<RequestSchema>;
    outcome: z.infer<OutcomeSchema>;
    createdAt: Date;
  }) => Result;
  // A method signature, like toOutcome and for the same reason.
  rebuild(db: Database, result: Result): Promise<void>;
};

// Identity at runtime; its generics give `toOutcome`, `fromEvent` and `rebuild`
// the types of the two schemas beside them, which `as const satisfies
// EventKindDefinition` cannot (the event's columns would be `unknown` there).
// Result is inferred from fromEvent's annotated return, so toOutcome's
// parameter must be annotated too.
export function defineEventKind<
  RequestSchema extends z.ZodType,
  OutcomeSchema extends z.ZodType,
  Result,
>(
  definition: EventKindDefinition<RequestSchema, OutcomeSchema, Result>,
): EventKindDefinition<RequestSchema, OutcomeSchema, Result> {
  return definition;
}

export type EventRequest<Definition extends EventKindDefinition> = z.infer<
  Definition['requestSchema']
>;

export type EventOutcome<Definition extends EventKindDefinition> = z.infer<
  Definition['outcomeSchema']
>;

// An event as its kind parses it: the three columns the kind owns, what
// `fromEvent` reads.
export type ParsedEvent<Definition extends EventKindDefinition> = {
  request: EventRequest<Definition>;
  outcome: EventOutcome<Definition>;
  createdAt: Date;
};

// Parse a stored event's two columns with the definition's schemas. The kind
// is not checked: the caller chose the definition by it. A failure is a bug
// or a corrupted event, never the client's fault, so the ZodError stays raw.
export function parseEvent<Definition extends EventKindDefinition>(
  definition: Definition,
  event: Event,
): ParsedEvent<Definition> {
  // Casts: the definition's schemas are generic, so TypeScript cannot relate
  // the parsed data to EventRequest and EventOutcome; the schemas define them.
  return {
    request: definition.requestSchema.parse(event.request) as EventRequest<Definition>,
    outcome: definition.outcomeSchema.parse(event.outcome) as EventOutcome<Definition>,
    createdAt: event.createdAt,
  };
}

// What a use case's work returns and what withEvent returns: the rows written,
// which the kind's rebuild writes again.
export type EventResult<Definition extends EventKindDefinition> = ReturnType<
  Definition['fromEvent']
>;
