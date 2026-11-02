import type { Logger } from 'pino';

// Context passed to every Service layer function. Carries the per-request infrastructure services
// need (the logger today; later a traceId) without coupling them to HTTP: the API handler builds it
// and passes it explicitly, and services never reach into Hono.
export type ServiceContext = {
  logger: Logger;
};
