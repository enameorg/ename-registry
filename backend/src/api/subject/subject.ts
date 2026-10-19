import { z } from '@hono/zod-openapi';

import { UUIDv7Schema } from '../../utilities/uuid.ts';

// Wire schemas of the subject concept, shared by every route under /subjects, so
// the contract holds one component per shape whatever route produces it (cf.
// ename-internals.md). A request-side block carries the `Input` suffix;
// `Subject` is the full subject as the registry returns it; `SubjectReference`
// names an existing subject by id alone.

const SubjectKindSchema = z.literal('person').openapi({ example: 'person' });

// Strict: an unknown field is a 422 naming the key, never silently dropped (cf.
// ename-internals.md).
export const SubjectInputSchema = z
  .strictObject({
    kind: SubjectKindSchema,
  })
  .openapi('SubjectInput');

export const SubjectSchema = z
  .object({
    id: UUIDv7Schema.openapi({ example: '01927e8f-9b2a-7c3d-8e4f-5a6b7c8d9e1a' }),
    kind: SubjectKindSchema,
  })
  .openapi('Subject');

// The subject block of an operation that acts on an existing subject without
// creating it: what the event request carries, nothing more.
export const SubjectReferenceSchema = z
  .object({
    id: UUIDv7Schema.openapi({ example: '01927e8f-9b2a-7c3d-8e4f-5a6b7c8d9e1a' }),
  })
  .openapi('SubjectReference');
