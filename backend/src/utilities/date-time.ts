import { z } from 'zod';

// A timestamp on the wire is an RFC 3339 date-time in UTC (`Z` suffix, the form
// `Date#toISOString()` emits): the single definition every layer parses one
// through. An offset or a zone-less form is rejected; whether an input field
// accepts an offset and normalizes it is decided with the first input field.
// No `.openapi()` here: the API wraps it in place with each field's example
// (cf. ename-internals.md).
export const DateTimeSchema = z.iso.datetime({ message: 'must be an RFC 3339 date-time in UTC' });
