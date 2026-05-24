import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { health } from './application.ts';

test('health() returns true', () => {
  assert.equal(health(), true);
});
