import type { Logger } from 'pino';
import { z } from 'zod';

import { isForeignKeyViolation, isUniqueViolation } from '../../database/errors.ts';
import { type Database, queryRows } from '../../database/query.ts';
import {
  Base64URLSchema,
  isValidPublicKey,
  KeyAlgorithmSchema,
} from '../../utilities/signature.ts';
import { UUIDv7Schema } from '../../utilities/uuid.ts';
import { isSignatureValid, type SignableDocument } from '../common/index.ts';
import { AuthenticationError, ConflictError, NotFoundError } from '../errors.ts';

// The public keys that sign events, whoever holds them: a key with a platform is that platform's, a
// key with none is a registry key. One concept for every owner, so a keyId resolves through one
// lookup and one verification whatever the signer. This concept establishes that a recorded key
// signed a document; which keys an operation admits is the business of the concept that owns them,
// and which owner may add a key the business of the use cases that emit their events. It imports no
// other concept.

// ---------------------------------------------------------------------------
// Key input
// ---------------------------------------------------------------------------

// What a client submits for a key, declared once and strict, composed by the event kinds into their
// request and wrapped in place by the API (cf. ename-internals.md). The value must be a key of the
// declared algorithm, so a key that could never verify a signature is refused before it enters the
// log. The keys_algorithm_allowed CHECK holds the list of algorithms KeyAlgorithmSchema declares,
// so a new algorithm lands with a migration too; key.test.ts pins that the two agree.
export const KeyInputSchema = z
  .strictObject({
    algorithm: KeyAlgorithmSchema,
    value: Base64URLSchema,
  })
  .refine(isValidPublicKey, {
    path: ['value'],
    message: 'must be an SPKI public key of the declared algorithm',
  });

// ---------------------------------------------------------------------------
// Key domain type and lookups
// ---------------------------------------------------------------------------

// Domain-shaped Key, mirroring the keys projection.
export const KeySchema = z.object({
  id: UUIDv7Schema,
  platformId: UUIDv7Schema.nullable(),
  algorithm: KeyAlgorithmSchema,
  value: Base64URLSchema,
  createdAt: z.date(),
});

export type Key = z.infer<typeof KeySchema>;

// Who owns a key, by the rule this concept states: a key with no platform is the registry's. A type
// names each owner's keys, and the guards let a caller read the platform id of a platform key
// without a check of its own.
export type PlatformKey = Key & { platformId: string };
export type RegistryKey = Key & { platformId: null };

export function isPlatformKey(key: Key): key is PlatformKey {
  return key.platformId !== null;
}

export function isRegistryKey(key: Key): key is RegistryKey {
  return key.platformId === null;
}

const SELECT_KEY_COLUMNS = 'id, platform_id, algorithm, value, created_at';

const KEYS_PRIMARY_KEY_CONSTRAINT = 'keys_pkey';
const KEYS_PLATFORM_ID_CONSTRAINT = 'keys_platform_id_fkey';

export async function getKey(db: Database, id: string): Promise<Key | undefined> {
  const rows = await queryRows(
    db,
    `SELECT ${SELECT_KEY_COLUMNS} FROM keys WHERE id = $1`,
    [id],
    KeySchema,
  );
  return rows[0];
}

// Ordered by (created_at, id): deterministic; id (UUIDv7) breaks ties on equal created_at.
export async function findKeys(db: Database): Promise<Key[]> {
  return await queryRows(
    db,
    `SELECT ${SELECT_KEY_COLUMNS} FROM keys ORDER BY created_at, id`,
    [],
    KeySchema,
  );
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

// The recorded key that signed the document, under the keyId the document names, or an
// AuthenticationError (→ 401). An unknown keyId and a signature its key rejects are one error, so a
// caller learns nothing of which keys exist; which case it was goes to the log, correlatable by
// requestId. The building block of every signer's authentication: the concept that owns a key adds
// whether it admits it.
export async function authenticateKey(
  db: Database,
  document: SignableDocument,
  signatureValue: string,
  logger: Logger,
): Promise<Key> {
  const key = await getKey(db, document.keyId);
  if (key === undefined || !isSignatureValid(key, document, signatureValue)) {
    logger.info(
      { keyId: document.keyId, operation: document.operation, keyFound: key !== undefined },
      'request signature not verified',
    );
    throw new AuthenticationError('The request signature could not be verified.');
  }
  return key;
}

// ---------------------------------------------------------------------------
// Insertion helper
// ---------------------------------------------------------------------------

// INSERT the key exactly as given: nothing is allocated, so the use cases and a rebuild write
// through the same primitive. Returns the row as the database wrote it. A key added to a platform
// that does not exist (→ 404), or under an id already recorded (→ 409), is the caller's fault; at a
// rebuild either would mean a corrupted log.
export async function insertKey(db: Database, key: Key): Promise<Key> {
  try {
    const rows = await queryRows(
      db,
      `INSERT INTO keys (id, platform_id, algorithm, value, created_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${SELECT_KEY_COLUMNS}`,
      [key.id, key.platformId, key.algorithm, key.value, key.createdAt],
      KeySchema,
    );
    const row = rows[0];
    if (!row) {
      // Unreachable in practice (a successful INSERT ... RETURNING returns a row); defensive
      // against a future refactor.
      throw new Error('insert keys returned no row');
    }
    return row;
  } catch (error) {
    if (isForeignKeyViolation(error, KEYS_PLATFORM_ID_CONSTRAINT)) {
      throw new NotFoundError('Platform not found.');
    }
    if (isUniqueViolation(error, KEYS_PRIMARY_KEY_CONSTRAINT)) {
      throw new ConflictError('A key is already recorded under this id.');
    }
    throw error;
  }
}
