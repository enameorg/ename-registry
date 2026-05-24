# Ename

Ename is a public registry of verified human identifiers (format `name#number`) designed to last for centuries, operated by a non-profit association.

The registry is the trust anchor of the Ename ecosystem: it binds each ename to a public cryptographic key, records key rotations in an append-only verifiable log, and exposes a stable, language-agnostic public API consumed by ecosystem operators.

For a complete project synthesis, see [`docs/ename-synthesis.md`](./docs/ename-synthesis.md). For internal technical decisions of the registry implementation, see [`docs/ename-tech.md`](./docs/ename-tech.md).

## Repository layout

This repository is a monorepo. Each top-level package is built and versioned independently.

- **[`backend/`](./backend/)** — Registry backend service. Phase 1 is Node.js + TypeScript; a Rust port (axum + sqlx) is planned for phase 2 once a dedicated team is recruited. See [`backend/README.md`](./backend/README.md) for setup and usage.
- **`frontend/`** — Planned. Web UI for end users (registration, key rotation, lookup). Not yet started.

## Documentation

Project-wide documentation lives in [`docs/`](./docs/). Package-specific documentation lives inside each package directory.

## License

To be determined.
