import { randomUUIDv7 } from 'node:crypto';

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

// Node's generator (26.1+) fills the sub-millisecond bits randomly, so two ids
// produced within the same millisecond carry no order relative to each other.
// Nothing may rely on id order: event order is `sequence`, and `id` only
// breaks ties after `created_at` in listings.
export function generateUUIDv7(): string {
  return randomUUIDv7();
}
