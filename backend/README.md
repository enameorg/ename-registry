# Ename Registry — Backend

Backend service for the [Ename](https://ename.ngo) registry, a public registry of verified human identifiers operated by a non-profit association.

This codebase is the **Node phase** of the implementation. A future Rust port (axum + sqlx) is planned once a dedicated team is recruited; see [`docs/ename-tech.md`](../docs/ename-tech.md) for the rationale and the long-term architecture invariants.

## Requirements

- **Node.js ≥ 26**: relies on native TypeScript execution (no build step) and stable `node:test`.
- **npm ≥ 11.10**: configured via `.npmrc` for supply-chain hardening (3-day release cooldown, lifecycle scripts disabled by default).

## Setup

```bash
# Install dependencies (lifecycle scripts are blocked by default).
npm install

# If a dependency legitimately needs to run its install scripts, allowlist it
# explicitly (no allowlisted package at this point):
# npm run rebuild:trusted

# Copy the local environment file and adjust if needed.
cp .env.example .env

# Generate the canonical OpenAPI spec (writes openapi.json).
npm run openapi:generate
```

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
│   ├── services/                  # Service Layer (business logic, no HTTP)
│   │   ├── application.ts         # health()
│   │   └── application.test.ts
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

The two-layer architecture (API / Services), the dependency propagation rules, and the rationale for each tooling choice are documented in [`../docs/ename-tech.md`](../docs/ename-tech.md).

## License

To be determined.
