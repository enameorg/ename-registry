import { v7 as uuidv7 } from 'uuid';

// Strict UUIDv7 pattern: 8-4-4-4-12 hex, version nibble 7, variant bits 10.
// Case-sensitive lowercase (RFC 9562 §4 canonical form, which we emit) — so
// input and output strictness match.
//
// No regex flags, so callers can attach it to OpenAPI `pattern` fields without
// leaking flag delimiters into the spec (a flagged version produced a malformed
// "...$/i" in the JSON Schema).
//
// Shared across layers: API input validation, persisted request/outcome JSONB
// validation, and OpenAPI field formats.
export const UUIDV7_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function generateUUIDv7(): string {
  return uuidv7();
}
