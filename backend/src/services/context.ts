import type { Logger } from 'pino';

// Shared context type passed to every Service Layer function. Carries
// per-request infrastructure that services need (logger today; future:
// traceId, authenticated actor, etc.) without coupling services to the
// HTTP layer. The API layer builds the context in its handler and passes
// it explicitly — services never reach back into Hono.
export type ServiceContext = {
  logger: Logger;
};
