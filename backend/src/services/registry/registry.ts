import type { Logger } from 'pino';

import type { Database } from '../../database/query.ts';
import type { SignableDocument } from '../common/index.ts';
import { AuthorizationError } from '../errors.ts';
import { authenticateKey, isRegistryKey } from '../key/index.ts';

// The registry as the signer of its own events: accreditations, keys, and later the mechanics of
// the log. Its keys are the keys with no platform (cf. key.ts); the anchor records the first of
// them (anchor-registry.ts).

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

// The signer of a request the registry submits: a recorded key that signed the document
// (cf. authenticateKey), held by the registry, or an AuthorizationError (→ 403) for a verified key
// of a platform.
export async function authenticateRegistry(
  db: Database,
  document: SignableDocument,
  signatureValue: string,
  logger: Logger,
): Promise<{ keyId: string }> {
  const key = await authenticateKey(db, document, signatureValue, logger);
  if (!isRegistryKey(key)) {
    logger.info(
      { keyId: key.id, operation: document.operation },
      'request signed by a key that is not a registry key',
    );
    throw new AuthorizationError('The signing key is not allowed to submit this request.');
  }
  return { keyId: key.id };
}
