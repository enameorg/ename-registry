import type { Logger } from 'pino';

// Context passed to every Service layer function. Carries per-request infra
// services need (logger today; later traceId, authenticated actor) without
// coupling them to HTTP — the API handler builds it and passes it explicitly;
// services never reach into Hono.
export type ServiceContext = {
  logger: Logger;
};
