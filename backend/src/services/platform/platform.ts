import type { Logger } from 'pino';
import { z } from 'zod';

import { isUniqueViolation } from '../../database/errors.ts';
import { type Database, queryRows } from '../../database/query.ts';
import { UUIDv7Schema } from '../../utilities/uuid.ts';
import type { SignableDocument } from '../common/index.ts';
import { AuthorizationError, ConflictError } from '../errors.ts';
import { authenticateKey, isPlatformKey } from '../key/index.ts';

// An accredited platform: a role with a stable id, held by the legal entity its four fields
// identify, so a reader of the log can tell who was accredited without a document outside it. The
// entity is named by the register that records it (a GLEIF Registration Authority code) and its
// identifier there; the jurisdiction keeps the log readable should the GLEIF list disappear, and
// the legal name is copied as that register records it.

// ---------------------------------------------------------------------------
// Legal identity rules
// ---------------------------------------------------------------------------

// ISO 3166-1 alpha-2, with an ISO 3166-2 subdivision where companies register below the country
// (`US-DE`). No regex flags, so the API carries it as an OpenAPI `pattern`.
const JURISDICTION_REGEX = /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/;

// A code of the GLEIF Registration Authorities List.
const REGISTRATION_AUTHORITY_CODE_REGEX = /^RA[0-9]{6}$/;

// Mirror the platforms_*_length CHECKs, absolute bounds no register reaches.
const MAX_LEGAL_NAME_LENGTH = 500;
const MAX_REGISTRATION_IDENTIFIER_LENGTH = 100;

export const JurisdictionSchema = z.string().regex(JURISDICTION_REGEX, {
  message: 'must be an ISO 3166-1 alpha-2 code, or an ISO 3166-2 subdivision code',
});

export const RegistrationAuthorityCodeSchema = z.string().regex(REGISTRATION_AUTHORITY_CODE_REGEX, {
  message: 'must be a GLEIF Registration Authority code (RA followed by six digits)',
});

export const LegalNameSchema = z.string().min(1).max(MAX_LEGAL_NAME_LENGTH);

export const RegistrationIdentifierSchema = z
  .string()
  .min(1)
  .max(MAX_REGISTRATION_IDENTIFIER_LENGTH);

// What a client submits for a platform, declared once and strict: the event kinds compose it into
// their request, the API wraps it in place (cf. ename-internals.md).
export const PlatformInputSchema = z.strictObject({
  legalName: LegalNameSchema,
  jurisdiction: JurisdictionSchema,
  registrationAuthorityCode: RegistrationAuthorityCodeSchema,
  registrationIdentifier: RegistrationIdentifierSchema,
});

// Names an existing platform by id alone.
export const PlatformReferenceSchema = z.strictObject({
  id: UUIDv7Schema,
});

// ---------------------------------------------------------------------------
// Platform domain type and lookups
// ---------------------------------------------------------------------------

// Domain-shaped Platform, mirroring the platforms projection.
export const PlatformSchema = z.object({
  id: UUIDv7Schema,
  legalName: LegalNameSchema,
  jurisdiction: JurisdictionSchema,
  registrationAuthorityCode: RegistrationAuthorityCodeSchema,
  registrationIdentifier: RegistrationIdentifierSchema,
  createdAt: z.date(),
});

export type Platform = z.infer<typeof PlatformSchema>;

const SELECT_PLATFORM_COLUMNS =
  'id, legal_name, jurisdiction, registration_authority_code, registration_identifier, created_at';

const PLATFORMS_REGISTRATION_CONSTRAINT = 'platforms_registration_key';

export async function getPlatform(db: Database, id: string): Promise<Platform | undefined> {
  const rows = await queryRows(
    db,
    `SELECT ${SELECT_PLATFORM_COLUMNS} FROM platforms WHERE id = $1`,
    [id],
    PlatformSchema,
  );
  return rows[0];
}

// Ordered by (created_at, id): deterministic; id (UUIDv7) breaks ties on equal created_at.
export async function findPlatforms(db: Database): Promise<Platform[]> {
  return await queryRows(
    db,
    `SELECT ${SELECT_PLATFORM_COLUMNS} FROM platforms ORDER BY created_at, id`,
    [],
    PlatformSchema,
  );
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

// The signer of a request a platform submits: a recorded key that signed the document
// (cf. authenticateKey), held by a platform, or an AuthorizationError (→ 403) for a verified key of
// the registry. The platform id it returns is the platform the work acts for.
export async function authenticatePlatform(
  db: Database,
  document: SignableDocument,
  signatureValue: string,
  logger: Logger,
): Promise<{ keyId: string; platformId: string }> {
  const key = await authenticateKey(db, document, signatureValue, logger);
  if (!isPlatformKey(key)) {
    logger.info(
      { keyId: key.id, operation: document.operation },
      'request signed by a key that is not a platform key',
    );
    throw new AuthorizationError('The signing key is not allowed to submit this request.');
  }
  return { keyId: key.id, platformId: key.platformId };
}

// ---------------------------------------------------------------------------
// Insertion helper
// ---------------------------------------------------------------------------

// INSERT the platform exactly as given: nothing is allocated, so the use case and a rebuild write
// through the same primitive. Returns the row as the database wrote it. One legal entity holds one
// platform at a time: a second accreditation of the same registration is a conflict (→ 409).
export async function insertPlatform(db: Database, platform: Platform): Promise<Platform> {
  try {
    const rows = await queryRows(
      db,
      `INSERT INTO platforms
         (id, legal_name, jurisdiction, registration_authority_code, registration_identifier, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${SELECT_PLATFORM_COLUMNS}`,
      [
        platform.id,
        platform.legalName,
        platform.jurisdiction,
        platform.registrationAuthorityCode,
        platform.registrationIdentifier,
        platform.createdAt,
      ],
      PlatformSchema,
    );
    const row = rows[0];
    if (!row) {
      // Unreachable in practice (a successful INSERT ... RETURNING returns a row); defensive
      // against a future refactor.
      throw new Error('insert platforms returned no row');
    }
    return row;
  } catch (error) {
    if (isUniqueViolation(error, PLATFORMS_REGISTRATION_CONSTRAINT)) {
      throw new ConflictError('A platform is already accredited for this registration.');
    }
    throw error;
  }
}
