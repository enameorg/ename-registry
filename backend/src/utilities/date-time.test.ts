import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { DateTimeSchema } from './date-time.ts';

// DateTimeSchema is the pure rule for a timestamp on the wire: the UTC form the
// registry emits, and nothing else until an input field decides otherwise
// (cf. ename-internals.md).
test('DateTimeSchema accepts the UTC form the registry emits and rejects other forms with its message', () => {
  assert.equal(DateTimeSchema.safeParse(new Date().toISOString()).success, true);
  assert.equal(DateTimeSchema.safeParse('2026-05-27T14:32:11Z').success, true);

  for (const value of [
    '2026-05-27T14:32:11+02:00', // an offset, not UTC
    '2026-05-27T14:32:11', // no zone
    '2026-05-27', // a date, not a date-time
    'not-a-date-time',
  ]) {
    const result = DateTimeSchema.safeParse(value);
    assert.equal(result.success, false, value);
    assert.equal(result.error?.issues[0]?.message, 'must be an RFC 3339 date-time in UTC');
  }
});
