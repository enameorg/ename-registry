import { z } from 'zod';

import { UUIDv7Schema } from '../../utilities/uuid.ts';
import { NamePartSchema, NumberPartSchema } from '../ename/index.ts';

// ---------------------------------------------------------------------------
// Event kind definitions — the log's vocabulary
// ---------------------------------------------------------------------------

// An event kind is the kind literal plus the pair of schemas that parse its two
// JSONB columns: `request` is what the actor submitted, `outcome` what the
// server allocated (ADR-0004). appendEvent takes a definition to write and
// reconcile one event; a reader narrows a row by kind and parses each column
// with the same pair. The list below mirrors the events.kind CHECK.
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

export const SubjectRegisteredEventKindDefinition = {
  kind: 'subject.registered',
  requestSchema: z.object({
    subject: z.object({
      kind: z.literal('person'),
    }),
    ename: z.object({
      // The grammar holds for every caller of the use case, not only the HTTP
      // body; and, like numberPart below, a namePart re-parsed from the log
      // can't pass what the original request would have failed.
      namePart: NamePartSchema,
    }),
  }),
  outcomeSchema: z.object({
    subject: z.object({
      id: UUIDv7Schema,
    }),
    ename: z.object({
      id: UUIDv7Schema,
      // Same chain as the projection schema, so a numberPart re-parsed from the
      // event log can't pass what the original INSERT would have rejected.
      numberPart: NumberPartSchema,
    }),
  }),
} as const satisfies EventKindDefinition;

export const SubjectEnameAddedEventKindDefinition = {
  kind: 'subject.ename-added',
  requestSchema: z.object({
    subject: z.object({
      id: UUIDv7Schema,
    }),
    ename: z.object({
      namePart: NamePartSchema,
    }),
  }),
  outcomeSchema: z.object({
    ename: z.object({
      id: UUIDv7Schema,
      numberPart: NumberPartSchema,
    }),
  }),
} as const satisfies EventKindDefinition;

export const eventKindDefinitions = [
  SubjectRegisteredEventKindDefinition,
  SubjectEnameAddedEventKindDefinition,
] as const;

export type EventKind = (typeof eventKindDefinitions)[number]['kind'];
