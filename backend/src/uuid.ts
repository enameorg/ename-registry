import { v7 as uuidv7 } from 'uuid';

export function generateUUIDv7(): string {
  return uuidv7();
}

// Strict UUIDv7 pattern: 8-4-4-4-12 hex, version nibble 7, RFC 4122 variant
// bits 10. Case-sensitive lowercase — RFC 9562 §4 prescribes lowercase as the
// canonical output form, and we generate lowercase (`uuid` package v7()) and
// echo lowercase in response headers and bodies. Accepting uppercase on input
// would create asymmetric strictness between what we accept and what we emit;
// rejecting it surfaces the discrepancy explicitly to the caller.
//
// Source string (no flags) so callers can attach it as-is to OpenAPI `pattern`
// fields via Zod's `.regex(UUIDV7_REGEX).openapi(...)` without leaking flag
// delimiters into the spec (a previous flagged version produced `"...$/i"`
// in the generated JSON Schema, which is malformed).
//
// Shared between layers: validates request inputs (API), validates persisted
// event `request`/`outcome` JSONB contents (services), and documents response
// field formats (OpenAPI).
export const UUIDV7_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
