import { z } from '@hono/zod-openapi';

import {
  MAX_NUMBER_PART,
  NamePartSchema as NamePartRuleSchema,
} from '../../services/ename/index.ts';
import { UUIDv7Schema } from '../../utilities/uuid.ts';

// Wire schemas of the ename concept. Enames live under /subjects on the wire, so
// their wire schemas live in this folder (cf. ename-internals.md).

// The namePart on the wire: the Service's grammar, wrapped with its OpenAPI
// example. The rule and its message are never re-assembled here; `pattern`,
// `minLength` and `maxLength` derive from the wrapped schema.
export const NamePartSchema = NamePartRuleSchema.openapi({ example: 'jean-dupont' });

// Strict: an unknown field is a 422 naming the key, never silently dropped (cf.
// ename-internals.md).
export const EnameInputSchema = z
  .strictObject({
    namePart: NamePartSchema,
  })
  .openapi('EnameInput');

export const EnameSchema = z
  .object({
    id: UUIDv7Schema.openapi({ example: '01927e8f-9b2a-7c3d-8e4f-5a6b7c8d9e10' }),
    namePart: NamePartSchema,
    // Upper bound mirrors the DB CHECK (`enames_number_part_range`), surfaced so
    // SDK generators document the bound. Non-coerce on purpose: the wire is
    // JSON and we control the serializer.
    numberPart: z.number().int().min(1).max(MAX_NUMBER_PART).openapi({ example: 1 }),
  })
  .openapi('Ename');
