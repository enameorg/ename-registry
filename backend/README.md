# Ename Registry — Backend

Backend service for the [Ename](https://ename.ngo) registry, a public registry of verified human identifiers operated by a nonprofit organization.

This codebase is the **Node phase** of the implementation. A future Rust port (axum + sqlx) is planned once a dedicated team is recruited; see [`docs/ename-internals.md`](../docs/ename-internals.md) for the rationale and the long-term architecture invariants.

## Requirements

- **Node.js ≥ 26.1**: relies on native TypeScript execution (no build step), stable `node:test`, and native UUIDv7 generation (`crypto.randomUUIDv7`).
- **npm ≥ 12**: configured via the repository-root `.npmrc` for supply-chain hardening (3-day release cooldown, dependency install scripts blocked unless allowlisted in the root `package.json`).
- A running local PostgreSQL: provisioned and migrated by the sibling [`database/`](../database/) package.

Both versions are pinned in the repository-root `mise.toml` for [mise](https://mise.jdx.dev) users.

## Setup

From the repository root:

```bash
# Install every package's dependencies. A dependency whose install scripts are
# not yet covered by "allowScripts" in the root package.json fails the install:
# review it, then run `npm install-scripts approve <pkg>` or
# `npm install-scripts deny <pkg>`.
npm install

# Copy the local environment file and adjust if needed.
cp backend/.env.example backend/.env

# Start PostgreSQL and run migrations (see ../database/README.md for details).
npm run db:up -w database

# Generate the canonical OpenAPI spec (writes backend/openapi.json).
npm run openapi:generate -w backend
```

The local database is managed by the [`database/`](../database/) package: a single PostgreSQL 18 cluster (matching Scaleway Serverless SQL) hosting two logical databases — `ename_dev` (used by the app) and `ename_test` (used by the test runner).

## Common commands

Run from this directory, or from the repository root with `-w backend` (`npm run dev -w backend`).

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

| Method | Path                          | Description                                                                                                                                |
| ------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST` | `/api/v1/subjects`            | Register a new subject together with its first ename atomically. Idempotent via `idempotencyKey`. Produces one `subject.registered` event. |
| `POST` | `/api/v1/subjects/:id/enames` | Add one ename to an existing subject. Idempotent via `idempotencyKey`. Produces one `subject.ename-added` event.                           |
| `GET`  | `/api/v1/health`              | Liveness check: the process answers, nothing else is checked. Returns 200 + `{"status":"ok"}` or 503 + `{"status":"unhealthy"}`.           |
| `GET`  | `/api/v1/health/deep`         | Deep check: the database must answer a trivial query within 1 s. Same body shape, 200 or 503. For monitoring, never the container probe.   |
| `GET`  | `/api/v1/openapi.json`        | OpenAPI 3.1 specification of the v1 contract.                                                                                              |
| `GET`  | `/api/v1/docs`                | Interactive API reference and client (Scalar UI), reading the live spec.                                                                   |

After `npm run dev`, open <http://localhost:3000/api/v1/docs> in a browser to browse the endpoints, send requests, and store variables and environments locally. The page fetches `openapi.json` live at each load, so it always reflects the running code — no import or duplication step.

## Project structure

This directory is the backend package of the Ename monorepo. The repository root is the npm workspace root (toolchain, lockfile, shared configs) and holds project-wide documentation (`docs/`) and the other packages.

```
backend/
├── src/
│   ├── api/                          # API layer (HTTP surface)
│   │   ├── application/              # service-wide endpoints
│   │   │   ├── index.ts              # barrel: the folder's routes, handlers and wire schema
│   │   │   ├── health.ts             # GET /health (liveness) route, handler, and the shared Zod schema
│   │   │   ├── health-deep.ts        # GET /health/deep (database probe) route and handler
│   │   │   └── *.test.ts             # HTTP-level tests
│   │   ├── subject/                  # endpoints rooted at /subjects (one file per route) and their wire schemas
│   │   │   ├── index.ts              # barrel: the folder's routes, handlers and wire schemas
│   │   │   ├── register-subject.ts   # POST /subjects route, handler, and request/response envelopes
│   │   │   ├── add-ename-to-subject.ts # POST /subjects/:id/enames route, handler, and envelopes
│   │   │   ├── subject.ts            # Subject, SubjectReference, SubjectInput wire schemas (OpenAPI components)
│   │   │   ├── ename.ts              # Ename, EnameInput wire schemas; NamePartSchema wraps the Service rule
│   │   │   └── *.test.ts             # HTTP-level integration tests
│   │   ├── context.ts                # API request-context types: RequestVariables, HonoEnv, ApiContext
│   │   ├── errors.ts                 # Error policy: RFC 9457 Problem Details shape, validation hook, error → response mapping, 404/405 responders, gate responses
│   │   ├── errors.test.ts            # The 500 fallback, the unmapped HTTPException and the 503 mapping, through a throwaway sub-app; their logs captured
│   │   ├── index.ts                  # v1 mount table: middleware order, routes, fallbacks, OpenAPI document
│   │   ├── index.test.ts             # Contract of the v1 gates, fallbacks and OpenAPI components
│   │   ├── middleware.ts             # requestId (UUIDv7) + Pino child logger + entrance/exit logs; the body-size cap
│   │   └── openapi-metadata.ts       # OpenAPI info object
│   ├── database/                     # Low-level DB plumbing (singletons + helpers consumed by services)
│   │   ├── errors.ts                 # pg driver error narrowing (isUniqueViolation, isForeignKeyViolation, isCheckViolation)
│   │   ├── pool.ts                   # Singleton pg.Pool; timeouts hard-coded, size from config
│   │   ├── pool.test.ts              # Idle-client connection loss is logged, never fatal
│   │   ├── query.ts                  # Database type, queryRows(), withTransaction() (nests as a savepoint), pingDatabase(), camelize at boundary
│   │   ├── query.test.ts             # withTransaction nesting: contained failure, release, outer rollback
│   │   └── testing.ts                # Test DB reset + pool shutdown (refuses reset outside NODE_ENV=test); the lock probe that forces a concurrency path
│   ├── services/                     # Service layer (business logic, no HTTP) — one folder per concept
│   │   ├── subject/
│   │   │   ├── index.ts              # barrel: the concept's public surface
│   │   │   ├── subject.ts            # Subject type/schema + data-access primitives (get/find/insert)
│   │   │   ├── subject.test.ts       # primitive round-trip tests
│   │   │   ├── register-subject.ts   # registerSubject() use case (emits subject.registered)
│   │   │   ├── add-ename-to-subject.ts # addEnameToSubject() use case (emits subject.ename-added)
│   │   │   └── *.test.ts             # use-case tests (projections, concurrency)
│   │   ├── ename/
│   │   │   ├── index.ts
│   │   │   ├── ename.ts              # Ename type/schema, NamePartSchema and format rules, primitives
│   │   │   └── ename.test.ts
│   │   ├── event/
│   │   │   ├── index.ts
│   │   │   ├── event.ts              # Event type/schema + primitives (the append-only log)
│   │   │   ├── event.test.ts
│   │   │   ├── event-kinds.ts        # Event kind definitions: kind literal + request/outcome schemas
│   │   │   ├── append-event.ts       # appendEvent(): the idempotent-write protocol every use case runs
│   │   │   └── append-event.test.ts  # protocol tests (replay, conflict, race, domain error vs winner)
│   │   ├── application/
│   │   │   ├── index.ts
│   │   │   ├── application.ts        # health(), checkDatabase(), closeDatabase()
│   │   │   └── application.test.ts
│   │   ├── context.ts                # ServiceContext (request-scoped values passed from the API layer)
│   │   └── errors.ts                 # Domain error classes (DomainError, ValidationError, NotFoundError, ConflictError, IdempotencyConflictError, ContentionError)
│   ├── utilities/                    # Pure modules both layers import (no I/O, no singleton), one file per concept
│   │   ├── uuid.ts                   # UUIDv7 generation, validation regex and the pure UUIDv7Schema
│   │   ├── date-time.ts              # DateTimeSchema: a timestamp on the wire (RFC 3339, UTC)
│   │   └── *.test.ts
│   ├── config.ts                     # Environment-driven configuration (Zod-validated)
│   ├── index.ts                      # Top-level app assembly (mounts /api/v1)
│   ├── logger.ts                     # Pino root logger
│   └── server.ts                     # Node runtime entry: serve + graceful shutdown
├── scripts/
│   └── generate-openapi.ts           # Regenerates the canonical OpenAPI spec
├── openapi.json                      # Canonical versioned copy of the generated OpenAPI spec (the audit trail)
├── tsconfig.json                     # Extends the repository-root tsconfig.base.json
├── package.json
└── README.md
```

`services/` is organized as one folder per concept (`subject`, `ename`, `event`, `application`), each exposing its public surface through an `index.ts` barrel: the concept-named file holds its type and data-access primitives, each use case has its own operation-named file, and `event` holds the write protocol every use case goes through. `src/database/` is the runtime DB plumbing (pool, query and transaction helpers, test reset) the services build on.

Note: the in-repo `src/database/` directory above is **runtime DB plumbing** consumed by the backend service; do not confuse it with the sibling [`database/`](../database/) **package**, which owns the schema, migrations, the migration runner, and the local PostgreSQL cluster.

The rules behind this layout — the two layers, what a primitive owns, who opens transactions, what the API layer may import — are stated in [`../docs/ename-internals.md`](../docs/ename-internals.md); the trade-offs behind them live in [`../docs/adr/`](../docs/adr/).

## License

To be determined.
