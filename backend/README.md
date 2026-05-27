# Ename Registry — Backend

Backend service for the [Ename](https://ename.ngo) registry, a public registry of verified human identifiers operated by a non-profit association.

This codebase is the **Node phase** of the implementation. A future Rust port (axum + sqlx) is planned once a dedicated team is recruited; see [`docs/ename-internals.md`](../docs/ename-internals.md) for the rationale and the long-term architecture invariants.

## Requirements

- **Node.js ≥ 26**: relies on native TypeScript execution (no build step) and stable `node:test`.
- **npm ≥ 11.10**: configured via `.npmrc` for supply-chain hardening (3-day release cooldown, lifecycle scripts disabled by default).
- A running local PostgreSQL: provisioned and migrated by the sibling [`database/`](../database/) package.

## Setup

```bash
# Install dependencies (lifecycle scripts are blocked by default).
npm install

# If a dependency legitimately needs to run its install scripts, allowlist it
# explicitly (no allowlisted package at this point):
# npm run rebuild:trusted

# Copy the local environment file and adjust if needed.
cp .env.example .env

# Start PostgreSQL and run migrations (see ../database/README.md for details).
( cd ../database && npm install && npm run db:up )

# Generate the canonical OpenAPI spec (writes openapi.json).
npm run openapi:generate
```

The local database is managed by the [`database/`](../database/) package: a single PostgreSQL 16 cluster (matching Scaleway Serverless SQL) hosting two logical databases — `ename_dev` (used by the app) and `ename_test` (used by the test runner).

## Common commands

| Command                    | What it does                                               |
| -------------------------- | ---------------------------------------------------------- |
| `npm run dev`              | Run the server with file watching (`node --watch`).        |
| `npm start`                | Run the server without watching (production mode).         |
| `npm test`                 | Run the test suite via `node:test`.                        |
| `npm run test:coverage`    | Run tests with built-in coverage reporting.                |
| `npm run typecheck`        | Type-check the entire codebase (`tsc --noEmit`).           |
| `npm run lint`             | Lint the codebase via ESLint.                              |
| `npm run lint:fix`         | Lint and auto-fix where possible.                          |
| `npm run format`           | Check formatting via Prettier.                             |
| `npm run format:fix`       | Reformat the codebase via Prettier.                        |
| `npm run openapi:generate` | Regenerate `openapi.json` from the live route definitions. |
| `npm run check`            | Run typecheck + lint + format + tests in sequence.         |

Schema, migration, and local cluster commands (`db:up`, `db:migrate`, `db:new`, `db:reset`, `db:dump`, …) live in the sibling [`database/`](../database/) package — see [`../database/README.md`](../database/README.md).

## Endpoints

| Method | Path                   | Description                                                                                                                                |
| ------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST` | `/api/v1/subjects`     | Register a new subject together with its first ename atomically. Idempotent via `idempotencyKey`. Produces one `subject.registered` event. |
| `GET`  | `/api/v1/health`       | Service health check. Returns 200 + `{"status":"ok"}` or 503 + `{"status":"unhealthy"}`.                                                   |
| `GET`  | `/api/v1/openapi.json` | OpenAPI 3.1 specification of the v1 contract.                                                                                              |
| `GET`  | `/api/v1/docs`         | Interactive API reference and client (Scalar UI), reading the live spec.                                                                   |

After `npm run dev`, open <http://localhost:3000/api/v1/docs> in a browser to browse the endpoints, send requests, and store variables and environments locally. The page fetches `openapi.json` live at each load, so it always reflects the running code — no import or duplication step.

## Project structure

This directory is the backend package of the Ename monorepo. The repository root holds project-wide documentation (`docs/`) and may host other packages later (CLI, dashboards, etc.).

```
backend/
├── src/
│   ├── api/                       # API Layer (HTTP surface)
│   │   ├── application.ts         # /health route, handler, and its Zod schema (inline)
│   │   ├── application.test.ts    # HTTP-level test
│   │   ├── index.ts               # v1 sub-app assembly: middleware, routes, defaultHook, onError
│   │   ├── middleware.ts          # requestId (UUIDv7) + Pino child logger + entrance/exit logs
│   │   ├── openapi-metadata.ts    # OpenAPI info object
│   │   ├── problem.ts             # RFC 9457 Problem Details schema + helpers (shared error shape)
│   │   ├── subject.ts             # POST /subjects route, handler, and inline Zod schemas
│   │   └── subject.test.ts        # HTTP-level integration tests
│   ├── database/                  # Low-level DB plumbing (singletons + helpers consumed by services)
│   │   ├── pool.ts                # Singleton pg.Pool (resolves dev vs test URL via NODE_ENV)
│   │   ├── query.ts               # queryRows() + withTransaction() helpers, camelize at boundary
│   │   └── reset-for-tests.ts     # TRUNCATE all public tables; refuses to run outside NODE_ENV=test
│   ├── services/                  # Service Layer (business logic, no HTTP)
│   │   ├── application.ts         # health()
│   │   ├── application.test.ts
│   │   ├── errors.ts              # Domain error classes (DomainError, ValidationError, IdempotencyConflictError)
│   │   ├── subject.ts             # registerSubject() use case
│   │   └── subject.test.ts        # Service-level tests (concurrency)
│   ├── config.ts                  # Environment-driven configuration (Zod-validated)
│   ├── index.ts                   # Top-level app assembly (mounts /api/v1)
│   ├── logger.ts                  # Pino root logger
│   └── server.ts                  # Node runtime entry: serve + graceful shutdown
├── scripts/
│   └── generate-openapi.ts        # Regenerates the canonical OpenAPI spec
├── openapi.json                   # Canonical OpenAPI spec (versioned source of truth)
├── eslint.config.js
├── tsconfig.json
├── package.json
└── README.md
```

The split between `src/database/` and `src/services/` is intentional: `database/` holds **stateless DB plumbing** (the pool singleton, generic helpers, the test-only reset utility) consumed by the Service Layer; `services/` holds the **business use cases** themselves (subject registration, future key rotation, etc.). Both belong conceptually to the Service Layer (cf. `docs/ename-internals.md` § Two-layer application architecture) — the API Layer never imports from either directly.

Note: the in-repo `src/database/` directory above is **runtime DB plumbing** consumed by the backend service; do not confuse it with the sibling [`database/`](../database/) **package**, which owns the schema, migrations, the migration runner, and the local PostgreSQL cluster.

The two-layer architecture (API / Services), the dependency propagation rules, and the rationale for each tooling choice are documented in [`../docs/ename-internals.md`](../docs/ename-internals.md).

## License

To be determined.
