import { z } from '@hono/zod-openapi';

import * as keyService from '../../services/key/index.ts';
import { Base64URLSchema, KeyAlgorithmSchema } from '../../utilities/signature.ts';
import { UUIDv7Schema } from '../../utilities/uuid.ts';

// Wire schemas of the key concept, which no URL root owns: a key is held by a
// platform or by the registry (cf. ename-internals.md). `KeyInput` is what the
// registry submits to record a key, `Key` the key as the registry returns it.

const KEY_EXAMPLE = {
  algorithm: 'ecdsa-p256-sha256' as const,
  value:
    'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEHrnigtJMJ_tcAdRsy4ZMy4p5R_-SVhFWZymWEFBCuFSznCy-sPtD8JD5pToqEI6AZUc0PLhuJTarVCAh0M5-yg',
};

// The input schema is the Service's, strict, wrapped in place with its example
// (a clone; the Service schema stays untouched): the contract cannot drift
// from what the event kinds store (cf. ename-internals.md).
export const KeyInputSchema = keyService.KeyInputSchema.openapi('KeyInput', {
  example: KEY_EXAMPLE,
});

export const KeySchema = z
  .object({
    id: UUIDv7Schema.openapi({ example: '01927e8f-9b2a-7c3d-8e4f-5a6b7c8d9e4c' }),
    algorithm: KeyAlgorithmSchema.openapi({ example: KEY_EXAMPLE.algorithm }),
    value: Base64URLSchema.openapi({ example: KEY_EXAMPLE.value }),
  })
  .openapi('Key');
