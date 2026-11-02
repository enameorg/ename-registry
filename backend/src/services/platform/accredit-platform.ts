import { z } from 'zod';

import { generateUUIDv7, UUIDv7Schema } from '../../utilities/uuid.ts';
import type { Signature } from '../common/index.ts';
import type { ServiceContext } from '../context.ts';
import { defineEventKind, type EventRequest, withEvent } from '../event/index.ts';
import { insertKey, type Key, KeyInputSchema } from '../key/index.ts';
import { authenticateRegistry } from '../registry/index.ts';

import { insertPlatform, type Platform, PlatformInputSchema } from './platform.ts';

// ---------------------------------------------------------------------------
// accreditPlatform — public types
// ---------------------------------------------------------------------------

export type AccreditPlatformInput = {
  idempotencyKey: string;
  signature: Signature;
} & EventRequest<typeof platformAccreditedEventKindDefinition>;

// What the use case writes and returns: the two rows, in the concepts' types.
export type AccreditPlatformResult = { platform: Platform; key: Key };

// ---------------------------------------------------------------------------
// accreditPlatform — public use case
// ---------------------------------------------------------------------------

// Accredit a platform and record its first key atomically, emitting one
// platform.accredited event, and return the two rows it wrote. The
// accreditation itself is an institutional decision taken outside the
// registry; this records it.
export async function accreditPlatform(
  input: AccreditPlatformInput,
  context: ServiceContext,
): Promise<AccreditPlatformResult> {
  return await withEvent(
    platformAccreditedEventKindDefinition,
    {
      idempotencyKey: input.idempotencyKey,
      request: { platform: input.platform, key: input.key },
      signature: input.signature,
      authenticate: authenticateRegistry,
      work: async (db, createdAt) => {
        const platform = await insertPlatform(db, {
          id: generateUUIDv7(),
          ...input.platform,
          createdAt,
        });
        const key = await insertKey(db, {
          id: generateUUIDv7(),
          platformId: platform.id,
          algorithm: input.key.algorithm,
          value: input.key.value,
          createdAt,
        });
        return { platform, key };
      },
    },
    context,
  );
}

// ---------------------------------------------------------------------------
// platform.accredited — the event kind accreditPlatform emits
// ---------------------------------------------------------------------------

// What the write records (cf. ename-internals.md, event-kind.ts).
export const platformAccreditedEventKindDefinition = defineEventKind({
  kind: 'platform.accredited',
  operation: 'platform.accredit',
  requestSchema: z.strictObject({
    platform: PlatformInputSchema,
    key: KeyInputSchema,
  }),
  outcomeSchema: z.strictObject({
    platform: z.strictObject({
      id: UUIDv7Schema,
    }),
    key: z.strictObject({
      id: UUIDv7Schema,
    }),
  }),
  toOutcome: ({ platform, key }: AccreditPlatformResult) => ({
    platform: { id: platform.id },
    key: { id: key.id },
  }),
  fromEvent: ({ request, outcome, createdAt }): AccreditPlatformResult => ({
    platform: { id: outcome.platform.id, ...request.platform, createdAt },
    key: {
      id: outcome.key.id,
      platformId: outcome.platform.id,
      algorithm: request.key.algorithm,
      value: request.key.value,
      createdAt,
    },
  }),
  rebuild: async (db, { platform, key }) => {
    await insertPlatform(db, platform);
    await insertKey(db, key);
  },
});
