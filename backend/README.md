# Ename Registry — Backend

Backend service for the [Ename](https://ename.ngo) registry, a public registry of verified human identifiers operated by a nonprofit organization.

This codebase is the **Node phase** of the implementation. A future Rust port (axum + sqlx) is planned once a dedicated team is recruited; see [`docs/ename-internals.md`](../docs/ename-internals.md) for the rationale and the long-term architecture invariants.

## Requirements

- **Node.js ≥ 26.1**: relies on native TypeScript execution (no build step), stable `node:test`, and native UUIDv7 generation (`crypto.randomUUIDv7`).
- **npm ≥ 12**: configured via `.npmrc` for supply-chain hardening (3-day release cooldown, dependency install scripts blocked unless allowlisted in `package.json`).
- A running local PostgreSQL: provisioned and migrated by the sibling [`database/`](../database/) package.

Both versions are pinned in `mise.toml` for [mise](https://mise.jdx.dev) users.

## Setup

```bash
# Install dependencies. A dependency whose install scripts are not yet covered
# by "allowScripts" in package.json fails the install: review it, then run
# `npm install-scripts approve <pkg>` or `npm install-scripts deny <pkg>`.
npm install

# Copy the local environment file and adjust if needed.
cp .env.example .env

# Start PostgreSQL and run migrations (see ../database/README.md for details).
( cd ../database && npm install && npm run db:up )

# Generate the canonical OpenAPI spec (writes openapi.json).
npm run openapi:generate
```

The local database is managed by the [`database/`](../database/) package: a single PostgreSQL 18 cluster (matching Scaleway Serverless SQL) hosting two logical databases — `ename_dev` (used by the app) and `ename_test` (used by the test runner).

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

| Method | Path                          | Description                                                                                                                                |
| ------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST` | `/api/v1/subjects`            | Register a new subject together with its first ename atomically. Idempotent via `idempotencyKey`. Produces one `subject.registered` event. |
| `POST` | `/api/v1/subjects/:id/enames` | Add one ename to an existing subject. Idempotent via `idempotencyKey`. Produces one `subject.ename_added` event.                           |
| `GET`  | `/api/v1/health`              | Liveness check: the process answers, nothing else is checked. Returns 200 + `{"status":"ok"}` or 503 + `{"status":"unhealthy"}`.           |
| `GET`  | `/api/v1/health/deep`         | Deep check: the database must answer a trivial query within 1 s. Same body shape, 200 or 503. For monitoring, never the container probe.   |
| `GET`  | `/api/v1/openapi.json`        | OpenAPI 3.1 specification of the v1 contract.                                                                                              |
| `GET`  | `/api/v1/docs`                | Interactive API reference and client (Scalar UI), reading the live spec.                                                                   |

After `npm run dev`, open <http://localhost:3000/api/v1/docs> in a browser to browse the endpoints, send requests, and store variables and environments locally. The page fetches `openapi.json` live at each load, so it always reflects the running code — no import or duplication step.

## Project structure

This directory is the backend package of the Ename monorepo. The repository root holds project-wide documentation (`docs/`) and may host other packages later (CLI, dashboards, etc.).

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
│   │   ├── errors.test.ts            # The 500 fallback and the unmapped HTTPException, through a throwaway sub-app
│   │   ├── index.ts                  # v1 mount table: middleware order, routes, fallbacks, OpenAPI document
│   │   ├── index.test.ts             # Contract of the v1 gates, fallbacks and OpenAPI components
│   │   ├── middleware.ts             # requestId (UUIDv7) + Pino child logger + entrance/exit logs; the body-size cap
│   │   └── openapi-metadata.ts       # OpenAPI info object
│   ├── database/                     # Low-level DB plumbing (singletons + helpers consumed by services)
│   │   ├── errors.ts                 # pg driver error narrowing (isUniqueViolation)
│   │   ├── pool.ts                   # Singleton pg.Pool (resolves dev vs test URL via NODE_ENV)
│   │   ├── pool.test.ts              # Idle-client connection loss is logged, never fatal
│   │   ├── query.ts                  # queryRows() + withTransaction() helpers, camelize at boundary
│   │   └── testing.ts                # Test DB reset + pool shutdown; refuses reset outside NODE_ENV=test
│   ├── services/                     # Service layer (business logic, no HTTP) — one folder per concept
│   │   ├── subject/
│   │   │   ├── index.ts              # barrel: the concept's public surface
│   │   │   ├── subject.ts            # Subject type/schema + data-access primitives (get/find/insert)
│   │   │   ├── subject.test.ts       # primitive round-trip tests
│   │   │   ├── register-subject.ts   # registerSubject() use case (emits subject.registered)
│   │   │   ├── add-ename-to-subject.ts # addEnameToSubject() use case (emits subject.ename_added)
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
│   │   └── errors.ts                 # Domain error classes (DomainError, ValidationError, IdempotencyConflictError, ContentionError)
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
├── openapi.json                      # Canonical OpenAPI spec (versioned source of truth)
├── eslint.config.js
├── tsconfig.json
├── package.json
└── README.md
```

`services/` is organized as one folder per concept (`subject`, `ename`, `event`, `application`), each exposing its public surface through an `index.ts` barrel. A concept's `<concept>.ts` holds its domain type/schema and its **data-access primitives** (single-table reads and writes); use cases live in their own operation-named files (`register-subject.ts`) and run their writes through `appendEvent`, the write protocol of the `event` concept, which owns the transaction and idempotency. The primitives are the sole holder of schema knowledge — table and column names, SQL, constraint names (see `docs/ename-internals.md`).

The split between `src/database/` and `src/services/` is intentional: `database/` holds **stateless, table-agnostic DB plumbing** (the pool singleton, the `queryRows`/`withTransaction` helpers, the test-only reset utility); `services/` holds the **business logic** — primitives and use cases — that uses it. Both belong conceptually to the Service layer (cf. `docs/ename-internals.md`). The API layer imports only the Service layer's public surface (the concept barrels), never `src/database/` directly.

Note: the in-repo `src/database/` directory above is **runtime DB plumbing** consumed by the backend service; do not confuse it with the sibling [`database/`](../database/) **package**, which owns the schema, migrations, the migration runner, and the local PostgreSQL cluster.

The two-layer architecture (API / Services), the dependency propagation rules, and the rationale for each tooling choice are documented in [`../docs/ename-internals.md`](../docs/ename-internals.md).

## License

To be determined.
