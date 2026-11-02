// Public surface of the `platform` concept
export {
  authenticatePlatform,
  findPlatforms,
  getPlatform,
  insertPlatform,
  JurisdictionSchema,
  LegalNameSchema,
  PlatformInputSchema,
  PlatformReferenceSchema,
  PlatformSchema,
  RegistrationAuthorityCodeSchema,
  RegistrationIdentifierSchema,
} from './platform.ts';
export type { Platform } from './platform.ts';
export { accreditPlatform, platformAccreditedEventKindDefinition } from './accredit-platform.ts';
export type { AccreditPlatformInput, AccreditPlatformResult } from './accredit-platform.ts';
export { addPlatformKey, platformKeyAddedEventKindDefinition } from './add-platform-key.ts';
export type { AddPlatformKeyInput, AddPlatformKeyResult } from './add-platform-key.ts';
