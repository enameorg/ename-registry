import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { generateUUIDv7, UUIDv7Schema } from './uuid.ts';

// UUIDv7Schema is the pure UUIDv7 rule every layer parses an id or a key
// through, so this one test covers the HTTP fields, the event columns and the
// projection rows alike (cf. ename-internals.md).
test('UUIDv7Schema accepts a generated UUIDv7 and rejects other values with its message', () => {
  assert.equal(UUIDv7Schema.safeParse(generateUUIDv7()).success, true);

  for (const value of [
    '550e8400-e29b-41d4-a716-446655440000', // UUIDv4
    '01927E8F-9B2A-7C3D-8E4F-5A6B7C8D9E0F', // uppercase: not the canonical form we emit
    'not-a-uuid',
  ]) {
    const result = UUIDv7Schema.safeParse(value);
    assert.equal(result.success, false, value);
    assert.equal(result.error?.issues[0]?.message, 'must be a UUIDv7');
  }
});
