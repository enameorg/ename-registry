import type { Logger } from 'pino';
import { z } from 'zod';

import type { Database } from '../../database/query.ts';
import type { PublicKey } from '../../utilities/signature.ts';
import { UUIDv7Schema } from '../../utilities/uuid.ts';
import { isSignatureValid, type SignableDocument, type Signature } from '../common/index.ts';
import type { ServiceContext } from '../context.ts';
import { AuthenticationError } from '../errors.ts';
import { defineEventKind, type EventRequest, withEvent } from '../event/index.ts';
import { insertKey, type Key, KeyInputSchema } from '../key/index.ts';

// ---------------------------------------------------------------------------
// anchorRegistry — public types
// ---------------------------------------------------------------------------

export type AnchorRegistryInput = {
  idempotencyKey: string;
  signature: Signature;
} & EventRequest<typeof registryAnchoredEventKindDefinition>;

// What the use case writes and returns: the registry key row.
export type AnchorRegistryResult = Key;

// ---------------------------------------------------------------------------
// anchorRegistry — public use case
// ---------------------------------------------------------------------------

// Anchor the registry: record its first key, emitting one registry.anchored
// event, the first of the log, and return the row it wrote. The key signs its
// own anchor, under the id its holder chose (cf. authenticateAnchor). Run
// once, by the registry's initialization command, which holds the private
// key; the server never does. The log admits one anchor: a second is a
// ConflictError. Adding a later registry key waits on [Q-REGKEY-MGMT].
export async function anchorRegistry(
  input: AnchorRegistryInput,
  context: ServiceContext,
): Promise<AnchorRegistryResult> {
  return await withEvent(
    registryAnchoredEventKindDefinition,
    {
      idempotencyKey: input.idempotencyKey,
      request: { key: input.key },
      signature: input.signature,
      authenticate: authenticateAnchor(input.key),
      work: (db, createdAt, signer) =>
        insertKey(db, {
          id: signer.keyId,
          platformId: null,
          algorithm: input.key.algorithm,
          value: input.key.value,
          createdAt,
        }),
    },
    context,
  );
}

// The anchor's signer: no key is recorded before it, so its signature is
// verified against the key its request adds, under the keyId its holder chose.
// What makes that key trusted lies outside the log: Ename publishes its
// fingerprint (cf. docs/ename-signature.md). The check awaits nothing, so the
// authenticator settles its promise itself instead of being async.
function authenticateAnchor(
  key: PublicKey,
): (
  db: Database,
  document: SignableDocument,
  signatureValue: string,
  logger: Logger,
) => Promise<{ keyId: string }> {
  return (_db, document, signatureValue, logger) => {
    if (!isSignatureValid(key, document, signatureValue)) {
      logger.info({ keyId: document.keyId }, 'anchor signature not verified');
      return Promise.reject(
        new AuthenticationError('The request signature could not be verified.'),
      );
    }
    return Promise.resolve({ keyId: document.keyId });
  };
}

// ---------------------------------------------------------------------------
// registry.anchored — the event kind anchorRegistry emits
// ---------------------------------------------------------------------------

// What the write records (cf. ename-internals.md, event-kind.ts). The key's id
// is in the outcome, as every id the log records, though for the anchor it is
// the keyId its signature names.
export const registryAnchoredEventKindDefinition = defineEventKind({
  kind: 'registry.anchored',
  operation: 'registry.anchor',
  requestSchema: z.strictObject({
    key: KeyInputSchema,
  }),
  outcomeSchema: z.strictObject({
    key: z.strictObject({
      id: UUIDv7Schema,
    }),
  }),
  toOutcome: (key: AnchorRegistryResult) => ({ key: { id: key.id } }),
  fromEvent: ({ request, outcome, createdAt }): AnchorRegistryResult => ({
    id: outcome.key.id,
    platformId: null,
    algorithm: request.key.algorithm,
    value: request.key.value,
    createdAt,
  }),
  rebuild: async (db, key) => {
    await insertKey(db, key);
  },
});
