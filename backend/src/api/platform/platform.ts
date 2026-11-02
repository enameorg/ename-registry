import { z } from '@hono/zod-openapi';

import * as platformService from '../../services/platform/index.ts';
import { UUIDv7Schema } from '../../utilities/uuid.ts';

// Wire schemas of the platform concept, shared by every route under
// /platforms, so the contract holds one component per shape whatever route
// produces it (cf. ename-internals.md): `PlatformInput` is what the registry
// submits to accredit a platform, `Platform` the platform as the registry
// returns it, `PlatformReference` an existing platform named by its id alone.

const PLATFORM_EXAMPLE = {
  legalName: '1PLACE',
  jurisdiction: 'FR',
  registrationAuthorityCode: 'RA000189',
  registrationIdentifier: '951595875',
};

// The input schema is the Service's, strict, wrapped in place with its example
// (a clone; the Service schema stays untouched): the contract cannot drift
// from what the event kinds store (cf. ename-internals.md).
export const PlatformInputSchema = platformService.PlatformInputSchema.openapi('PlatformInput', {
  example: PLATFORM_EXAMPLE,
});

// The `platform` object of an operation that acts on an existing platform
// without creating it: what the event request carries, nothing more.
export const PlatformReferenceSchema = platformService.PlatformReferenceSchema.openapi(
  'PlatformReference',
  { example: { id: '01927e8f-9b2a-7c3d-8e4f-5a6b7c8d9e3b' } },
);

export const PlatformSchema = z
  .object({
    id: UUIDv7Schema.openapi({ example: '01927e8f-9b2a-7c3d-8e4f-5a6b7c8d9e3b' }),
    legalName: platformService.LegalNameSchema.openapi({ example: PLATFORM_EXAMPLE.legalName }),
    jurisdiction: platformService.JurisdictionSchema.openapi({
      example: PLATFORM_EXAMPLE.jurisdiction,
    }),
    registrationAuthorityCode: platformService.RegistrationAuthorityCodeSchema.openapi({
      example: PLATFORM_EXAMPLE.registrationAuthorityCode,
    }),
    registrationIdentifier: platformService.RegistrationIdentifierSchema.openapi({
      example: PLATFORM_EXAMPLE.registrationIdentifier,
    }),
  })
  .openapi('Platform');
