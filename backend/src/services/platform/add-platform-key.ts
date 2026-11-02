import { z } from 'zod';

import { generateUUIDv7, UUIDv7Schema } from '../../utilities/uuid.ts';
import type { Signature } from '../common/index.ts';
import type { ServiceContext } from '../context.ts';
import { defineEventKind, type EventRequest, withEvent } from '../event/index.ts';
import { insertKey, isPlatformKey, KeyInputSchema, type PlatformKey } from '../key/index.ts';
import { authenticateRegistry } from '../registry/index.ts';

import { PlatformReferenceSchema } from './platform.ts';

// ---------------------------------------------------------------------------
// addPlatformKey — public types
// ---------------------------------------------------------------------------

export type AddPlatformKeyInput = {
  idempotencyKey: string;
  signature: Signature;
} & EventRequest<typeof platformKeyAddedEventKindDefinition>;

// What the use case writes and returns: the key row, a key of the platform.
export type AddPlatformKeyResult = PlatformKey;

// ---------------------------------------------------------------------------
// addPlatformKey — public use case
// ---------------------------------------------------------------------------

// Add a key to an accredited platform, beside the keys it already has, emitting one
// platform.key-added event, and return the row it wrote. Revoking a platform key is not built yet
// (cf. ename-internals.md).
export async function addPlatformKey(
  input: AddPlatformKeyInput,
  context: ServiceContext,
): Promise<AddPlatformKeyResult> {
  return await withEvent(
    platformKeyAddedEventKindDefinition,
    {
      idempotencyKey: input.idempotencyKey,
      request: { platform: input.platform, key: input.key },
      signature: input.signature,
      authenticate: authenticateRegistry,
      work: async (db, createdAt) => {
        const key = await insertKey(db, {
          id: generateUUIDv7(),
          platformId: input.platform.id,
          algorithm: input.key.algorithm,
          value: input.key.value,
          createdAt,
        });
        if (!isPlatformKey(key)) {
          // Unreachable in practice: the row keeps the platform it was given. The check narrows its
          // type to a platform key.
          throw new Error('insert keys returned a key with no platform');
        }
        return key;
      },
    },
    context,
  );
}

// ---------------------------------------------------------------------------
// platform.key-added — the event kind addPlatformKey emits
// ---------------------------------------------------------------------------

// What the write records (cf. ename-internals.md, event-kind.ts).
export const platformKeyAddedEventKindDefinition = defineEventKind({
  kind: 'platform.key-added',
  operation: 'platform.add-key',
  requestSchema: z.strictObject({
    platform: PlatformReferenceSchema,
    key: KeyInputSchema,
  }),
  outcomeSchema: z.strictObject({
    key: z.strictObject({
      id: UUIDv7Schema,
    }),
  }),
  toOutcome: (key: AddPlatformKeyResult) => ({ key: { id: key.id } }),
  fromEvent: ({ request, outcome, createdAt }): AddPlatformKeyResult => ({
    id: outcome.key.id,
    platformId: request.platform.id,
    algorithm: request.key.algorithm,
    value: request.key.value,
    createdAt,
  }),
  rebuild: async (db, key) => {
    await insertKey(db, key);
  },
});
