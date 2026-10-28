import type { Context } from 'hono';
import type { Logger } from 'pino';

// Request-scoped values the request-context middleware binds onto the Hono
// context (see middleware.ts):
//   - requestId: per-HTTP-request id (UUIDv7), echoed in X-Request-Id and bound
//     to the child logger. Distinct from idempotencyKey (a write-body field).
//   - logger: Pino child logger bound to { requestId }. Services receive it as
//     an explicit argument (ServiceContext), never the Hono context.
export type RequestVariables = {
  requestId: string;
  logger: Logger;
};

// Hono's context type parameter (its `Env`). Pure framework glue — no Rust
// analog; the Rust phase will pass RequestVariables through an extractor.
export type HonoEnv = { Variables: RequestVariables };

// The Hono context handlers and middleware receive — the API-layer counterpart
// of the Service layer's ServiceContext (cf. ename-internals.md).
export type APIContext = Context<HonoEnv>;
