// Public surface of the API's `application` folder, through which api/index.ts
// mounts it: its routes, their handlers and their wire schema.
export { healthDeepHandler, healthDeepRoute } from './health-deep.ts';
export { healthHandler, HealthResponseSchema, healthRoute } from './health.ts';
