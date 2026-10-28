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

# Copy the environment files, one per local environment, and adjust if needed:
# `npm run dev` and `npm run openapi:generate` load .env.development, `npm test`
# and `npm run test:coverage` load .env.test, and each fails if its file is
# missing.
cp backend/.env.development.example backend/.env.development
cp backend/.env.test.example backend/.env.test

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
│   ├── api/                  # API layer (HTTP surface): one folder per URL root, one file per route, the wire schemas beside them
│   │   ├── application/      # /health and /health/deep
│   │   ├── subject/          # /subjects and /subjects/:id/enames
│   │   ├── index.ts          # v1 mount table: middleware order, routes, fallbacks, OpenAPI document
│   │   ├── errors.ts         # Error policy: Problem Details, validation hook, error → response mapping
│   │   ├── middleware.ts     # requestId + child logger + entrance/exit logs; the body-size cap
│   │   └── testing.ts        # API test helpers: postJSON, readJSON, readProblem
│   ├── database/             # Low-level DB plumbing the services build on: pool, query and transaction helpers, pg error narrowing
│   │   └── testing.ts        # Test DB lifecycle: reset, lock probe, CHECK reader, projection truncation
│   ├── services/             # Service layer (business logic, no HTTP): one folder per concept, each with an index.ts barrel
│   │   ├── subject/          # Subject: schemas, primitives, the write use cases with the event kinds they emit
│   │   ├── ename/            # Ename: format rules, schemas, primitives
│   │   ├── event/            # The append-only log: the shape of an event kind, withEvent(), rebuildEvent()
│   │   ├── application/      # health(), checkDatabase(), closeDatabase()
│   │   ├── context.ts        # ServiceContext (request-scoped values passed from the API layer)
│   │   └── errors.ts         # Domain error classes and the translation of a Zod failure
│   ├── utilities/            # Pure modules both layers import directly: uuid.ts, date-time.ts
│   ├── config.ts             # Environment-driven configuration (Zod-validated)
│   ├── index.ts              # Top-level app assembly (mounts /api/v1)
│   ├── logger.ts             # Pino root logger
│   └── server.ts             # Node runtime entry: serve + graceful shutdown
├── scripts/
│   └── generate-openapi.ts   # Regenerates the canonical OpenAPI spec
├── openapi.json              # Canonical versioned copy of the generated OpenAPI spec (the audit trail)
├── tsconfig.json             # Extends the repository-root tsconfig.base.json
├── package.json
└── README.md
```

Every `*.test.ts` sits beside the file it tests; what each file holds is stated at its top.

Note: the in-repo `src/database/` directory above is **runtime DB plumbing** consumed by the backend service; do not confuse it with the sibling [`database/`](../database/) **package**, which owns the schema, migrations, the migration runner, and the local PostgreSQL cluster.

The rules behind this layout — the two layers, what a primitive owns, who opens transactions, what the API layer may import — are stated in [`../docs/ename-internals.md`](../docs/ename-internals.md); the trade-offs behind them live in [`../docs/adr/`](../docs/adr/).

## License

To be determined.
