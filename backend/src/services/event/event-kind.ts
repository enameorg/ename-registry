import type { z } from 'zod';

// ---------------------------------------------------------------------------
// Event kind definition — the shape every kind takes
// ---------------------------------------------------------------------------

// An event kind is the kind literal plus the pair of schemas that parse its two
// JSONB columns: `request` is what the actor submitted, `outcome` what the
// server allocated (ADR-0004). Both schemas are strict at every level: what
// enters the log is exactly what was submitted or allocated, never a stripped
// copy, so a field the wire accepts but the kind does not know fails loudly
// instead of being lost. A kind is declared by the use case that emits it
// (`services/subject/register-subject.ts`), so this concept imports no
// aggregate; the events.kind CHECK is the authoritative list of kinds.
// appendEvent takes a definition to write and reconcile one event; a reader
// narrows a row by kind and parses each column with the same pair.
export type EventKindDefinition<
  RequestSchema extends z.ZodType = z.ZodType,
  OutcomeSchema extends z.ZodType = z.ZodType,
> = {
  readonly kind: string;
  readonly requestSchema: RequestSchema;
  readonly outcomeSchema: OutcomeSchema;
};

export type EventRequest<Definition extends EventKindDefinition> = z.infer<
  Definition['requestSchema']
>;

export type EventOutcome<Definition extends EventKindDefinition> = z.infer<
  Definition['outcomeSchema']
>;
