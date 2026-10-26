import type { z } from 'zod';

// ---------------------------------------------------------------------------
// Event kind definition — the shape every kind takes
// ---------------------------------------------------------------------------

// An event kind is the kind literal, the pair of schemas that parse its two
// JSONB columns — `request` is what the actor submitted, `outcome` what the
// server allocated (ADR-0004) — and the pair of pure functions that map
// between the rows a use case writes (its result, in the concept's own types:
// a `Subject`, an `Ename`) and the event that records them: `toOutcome` keeps
// of the result what the server allocated, `fromEvent` reads a whole event
// back into the result. The two must agree — fromEvent({ request,
// toOutcome(result), createdAt }) is result — and each kind's test pins it.
// Both schemas are strict at every level: what enters the log is exactly what
// was submitted or allocated, never a stripped copy, so a field the wire
// accepts but the kind does not know fails loudly instead of being lost. A
// kind is declared by the use case that emits it
// (`services/subject/register-subject.ts`), so this concept imports no
// aggregate; the events.kind CHECK is the authoritative list of kinds.
// withEvent takes a definition to write and reconcile one event; a reader
// narrows a row by kind and parses each column with the same pair.
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
};

// Identity at runtime; its generics give `toOutcome` and `fromEvent` the types
// of the two schemas beside them, which `as const satisfies
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

// What a use case's work returns and what withEvent returns: the rows written.
export type EventResult<Definition extends EventKindDefinition> = ReturnType<
  Definition['fromEvent']
>;
