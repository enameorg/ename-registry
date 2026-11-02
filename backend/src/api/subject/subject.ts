import { z } from '@hono/zod-openapi';

import * as subjectService from '../../services/subject/index.ts';
import { UUIDv7Schema } from '../../utilities/uuid.ts';

// Wire schemas of the subject concept, shared by every route under /subjects,
// so the contract holds one component per shape whatever route produces it
// (cf. ename-internals.md): `SubjectInput` is what a platform submits to
// register a subject, `Subject` the subject as the registry returns it,
// `SubjectReference` an existing subject named by its id alone.

// The input schema is the Service's, strict, wrapped in place with its example
// (a clone; the Service schema stays untouched): the contract cannot drift
// from what the event kinds store (cf. ename-internals.md).
export const SubjectInputSchema = subjectService.SubjectInputSchema.openapi('SubjectInput', {
  example: { kind: 'person' },
});

// The `subject` object of an operation that acts on an existing subject without
// creating it: what the event request carries, nothing more.
export const SubjectReferenceSchema = subjectService.SubjectReferenceSchema.openapi(
  'SubjectReference',
  { example: { id: '01927e8f-9b2a-7c3d-8e4f-5a6b7c8d9e1a' } },
);

export const SubjectSchema = z
  .object({
    id: UUIDv7Schema.openapi({ example: '01927e8f-9b2a-7c3d-8e4f-5a6b7c8d9e1a' }),
    kind: subjectService.SubjectKindSchema.openapi({ example: 'person' }),
  })
  .openapi('Subject');
