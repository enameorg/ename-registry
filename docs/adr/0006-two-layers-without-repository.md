---
status: accepted
date: 2026-10-14
---

# Two layers, API and Service, with no Repository layer

Recorded retroactively; the decision dates from the internals' first version (commit `4297fdd`) and the per-concept reorganization (commit `2133e73`).

## Context

The backend is small, built by one person, tested against a real PostgreSQL, and destined for a Rust port (ADR-0002) whose idiom (axum + sqlx) is direct, typed queries. A classic layering would add a Repository tier between business logic and SQL.

## Decision

Two layers. The API layer is the HTTP surface and holds no business logic. The Service layer holds all business logic and accesses the database directly through raw parameterized SQL. Within it, each concept's data-access primitives are the sole holder of schema knowledge — table and column names, SQL, constraint names, expected error codes — and translate expected database errors into domain errors. This is information hiding, not an abstraction layer: the SQL is owned and visible, merely confined.

## Considered options

- **A Repository layer with interfaces.** Rejected: indirection with no second implementation. Tests run on a real database (no mocks), so substitutability buys nothing, and the Rust target does not layer that way.
- **Business logic in the handlers.** Rejected: the HTTP surface would own SQL and domain rules, untestable without a request and unportable as a contract.

## Consequences

- Nothing above a primitive branches on a SQLSTATE or a constraint name.
- Transactions are owned by the Service layer (the write protocol that runs every use case's writes); generic driver mechanics live in `src/database/`; the API layer never imports it.
- Prefer write-plus-constraint-translation over read-before-write; a pre-check is justified only when it enforces a rule the database cannot express, avoids expensive work before a known failure, or improves semantics without replacing the database constraint.
