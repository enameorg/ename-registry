# Ename registry

Ename is a public registry of verified human identifiers (format `<name>#<number>`) designed to last for centuries, operated by a nonprofit organization.

The registry is the cryptographic anchor of the Ename ecosystem. It is designed to bind each ename to a public cryptographic key, to record every change in an append-only verifiable log, and to expose a stable, language-agnostic public API consumed by accredited platforms.

For the reference synthesis, see [Ename — Reference Synthesis](./docs/ename-synthesis.md). For the internal mechanics of the registry implementation, see [Ename — Registry Internals](./docs/ename-internals.md).

## Repository layout

This repository is a monorepo. Each top-level package is built and versioned independently.

- **[`database/`](./database/)** — Schema, migrations, local PostgreSQL cluster, and the migration runner. Consumed today by the Node backend and later by the Rust backend, which reimplements the runner. See [`database/README.md`](./database/README.md) for setup and usage.
- **[`backend/`](./backend/)** — Registry backend service. Phase 1 is Node.js + TypeScript; a Rust port (axum + sqlx) is planned for phase 2 once a dedicated team is recruited. See [`backend/README.md`](./backend/README.md) for setup and usage.
- **`frontend/`** — Planned. Web UI for end users (registration, key rotation, lookup). Not yet started.
- **[`website/`](./website/)** — Static institutional site served at [www.ename.ngo](https://www.ename.ngo), hosted on Scaleway Object Storage. See [`website/README.md`](./website/README.md) for setup and deployment.

## Documentation

Project-wide documentation lives in [`docs/`](./docs/). Package-specific documentation lives inside each package directory.

## License

To be determined.
