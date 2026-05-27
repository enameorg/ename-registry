# Ename Registry — Backend

Backend service for the [Ename](https://ename.ngo) registry, a public registry of verified human identifiers operated by a non-profit association.

This codebase is the **Node phase** of the implementation. A future Rust port (axum + sqlx) is planned once a dedicated team is recruited; see [`docs/ename-internals.md`](../docs/ename-internals.md) for the rationale and the long-term architecture invariants.

## Requirements

- **Node.js ≥ 26**: relies on native TypeScript execution (no build step) and stable `node:test`.
- **npm ≥ 11.10**: configured via `.npmrc` for supply-chain hardening (3-day release cooldown, lifecycle scripts disabled by default).
- **Docker** (Desktop, OrbStack, or compatible): runs the local PostgreSQL via `docker-compose.yml` at the repo root.

## Setup

```bash
# Install dependencies (lifecycle scripts are blocked by default).
npm install

# If a dependency legitimately needs to run its install scripts, allowlist it
# explicitly (no allowlisted package at this point):
# npm run rebuild:trusted

# Copy the local environment file and adjust if needed.
cp .env.example .env

# Start PostgreSQL (Docker), wait for the healthcheck, then apply all migrations
# to both ename_dev and ename_test. Idempotent — safe to run on every clone.
npm run db:up

# Generate the canonical OpenAPI spec (writes openapi.json).
npm run openapi:generate
```

The local database is a single PostgreSQL 16 cluster (matching Scaleway Serverless SQL) hosting two logical databases: `ename_dev` (used by the app) and `ename_test` (used by the test runner). The `docker-compose.yml` lives at the repo root because the same cluster will serve the Rust phase later — it is not a backend-only concern.

## Common commands

| Command                    | What it does                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| `npm run dev`              | Run the server with file watching (`node --watch`).                                          |
| `npm start`                | Run the server without watching (production mode).                                           |
| `npm test`                 | Run the test suite via `node:test`.                                                          |
| `npm run test:coverage`    | Run tests with built-in coverage reporting.                                                  |
| `npm run typecheck`        | Type-check the entire codebase (`tsc --noEmit`).                                             |
| `npm run lint`             | Lint the codebase via ESLint.                                                                |
| `npm run lint:fix`         | Lint and auto-fix where possible.                                                            |
| `npm run format`           | Check formatting via Prettier.                                                               |
| `npm run format:fix`       | Reformat the codebase via Prettier.                                                          |
| `npm run openapi:generate` | Regenerate `openapi.json` from the live route definitions.                                   |
| `npm run db:up`            | Start PostgreSQL (Docker), wait for healthcheck, run migrations on both databases.           |
| `npm run db:down`          | Stop the PostgreSQL container (data preserved in the named volume).                          |
| `npm run db:nuke`          | Stop the container **and delete the data volume**. Destructive.                              |
| `npm run db:migrate`       | Apply pending migrations to `ename_dev`.                                                     |
| `npm run db:migrate:test`  | Apply pending migrations to `ename_test`.                                                    |
| `npm run db:new -- <name>` | Create a new pair of `<unix_ts>_<name>.up.sql` / `.down.sql` in `database/migrations/`.      |
| `npm run db:reset`         | Drop and recreate `ename_dev`, then re-run migrations. Fast reset without nuking the volume. |
| `npm run db:reset:test`    | Same for `ename_test`.                                                                       |
| `npm run db:dump`          | Dump `ename_dev`'s schema to `database/schema.sql` (versioned).                              |
| `npm run db:status`        | List migrations applied to `ename_dev`.                                                      |
| `npm run check`            | Run typecheck + lint + format + tests in sequence.                                           |

## Endpoints

| Method | Path                   | Description                                                                              |
| ------ | ---------------------- | ---------------------------------------------------------------------------------------- |
| `GET`  | `/api/v1/health`       | Service health check. Returns 200 + `{"status":"ok"}` or 503 + `{"status":"unhealthy"}`. |
| `GET`  | `/api/v1/openapi.json` | OpenAPI 3.1 specification of the v1 contract.                                            |
| `GET`  | `/api/v1/docs`         | Interactive API reference and client (Scalar UI), reading the live spec.                 |

After `npm run dev`, open <http://localhost:3000/api/v1/docs> in a browser to browse the endpoints, send requests, and store variables and environments locally. The page fetches `openapi.json` live at each load, so it always reflects the running code — no import or duplication step.

## Project structure

This directory is the backend package of the Ename monorepo. The repository root holds project-wide documentation (`docs/`) and may host other packages later (CLI, dashboards, etc.).

```
backend/
├── src/
│   ├── api/                       # API Layer (HTTP surface)
│   │   ├── application.ts         # /health route, handler, and its Zod schema (inline)
│   │   ├── application.test.ts    # HTTP-level test
│   │   ├── index.ts               # v1 sub-app assembly
│   │   └── openapi-metadata.ts    # OpenAPI info object
│   ├── database/                  # Service Layer — DB access
│   │   ├── pool.ts                # Singleton pg.Pool (resolves dev vs test URL via NODE_ENV)
│   │   ├── query.ts               # queryRows() + withTransaction() helpers, camelize at boundary
│   │   └── reset-for-tests.ts     # TRUNCATE all public tables; refuses to run outside NODE_ENV=test
│   ├── services/                  # Service Layer (business logic, no HTTP)
│   │   ├── application.ts         # health()
│   │   └── application.test.ts
│   ├── config.ts                  # Environment-driven configuration (Zod-validated)
│   ├── index.ts                   # Top-level app assembly (mounts /api/v1)
│   ├── logger.ts                  # Pino root logger
│   └── server.ts                  # Node runtime entry: serve + graceful shutdown
├── scripts/
│   ├── generate-openapi.ts        # Regenerates the canonical OpenAPI spec
│   ├── migrate.ts                 # Custom migration runner (advisory lock + content hash)
│   └── new-migration.ts           # Scaffolds a new up/down migration pair
├── openapi.json                   # Canonical OpenAPI spec (versioned source of truth)
├── eslint.config.js
├── tsconfig.json
├── package.json
└── README.md
```

Repo-root files used by the backend:

```
docker-compose.yml                 # Local PostgreSQL (shared between Node phase and future Rust phase)
database/
├── init/
│   └── 01-create-databases.sql    # Runs once at first container boot — creates ename_test
├── migrations/                    # <unix_ts>_<name>.up.sql + .down.sql (sqlx-cli compatible)
└── schema.sql                     # Canonical schema dump, regenerated by `npm run db:dump`
```

The two-layer architecture (API / Services), the dependency propagation rules, and the rationale for each tooling choice are documented in [`../docs/ename-internals.md`](../docs/ename-internals.md).

## License

To be determined.
