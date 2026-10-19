// Public surface of the API's `application` folder: its routes, their handlers
// and the wire schema another API folder may reuse.
export { healthDeepHandler, healthDeepRoute } from './health-deep.ts';
export { healthHandler, HealthResponseSchema, healthRoute } from './health.ts';
