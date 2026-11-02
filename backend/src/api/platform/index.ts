// Public surface of the API's `platform` folder, through which api/index.ts
// mounts it: its routes, their handlers, and the wire schemas of the platform
// concept.
export { PlatformInputSchema, PlatformReferenceSchema, PlatformSchema } from './platform.ts';
export { accreditPlatformHandler, accreditPlatformRoute } from './accredit-platform.ts';
export { addPlatformKeyHandler, addPlatformKeyRoute } from './add-platform-key.ts';
