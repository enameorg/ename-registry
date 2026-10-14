---
status: accepted
date: 2026-10-14
---

# Build the backend in Node first, port it to Rust later

Recorded retroactively; the decision dates from the start of the backend (commits `bcc6ff8`, `4297fdd`).

## Context

The registry is meant to last for centuries and to serve a universal human identity, but it starts with a single developer, deep Node.js experience, and a single platform (1Place) during the bootstrap phase. Rust (axum + sqlx) is the long-term runtime target: predictable performance and memory safety for a service that will run largely unattended, and lower cold-start cost on a serverless container.

## Decision

Phase 1 is Node.js + TypeScript. Phase 2 is a port to Rust by a dedicated team recruited for it — a port, not a gradual migration. The versioned OpenAPI contract is the language-independent pivot the two phases share. The Node code is shaped so that the port is a translation rather than a redesign.

## Considered options

- **Rust from day one.** Rejected: solo productivity and time-to-market matter most while 1Place is the only platform, and the Rust expertise is still being built.
- **Node for good.** Rejected: the operational profile of a multi-century service (cold starts, memory, hiring over decades) is better served by Rust, and the cost of switching only grows.
- **Gradual migration, service by service.** Rejected: two runtimes, two deployment pipelines and two sets of conventions side by side for a long time, for a team that will be small when the port happens.

## Consequences

- Repo-wide shape chosen for the port: raw parameterized SQL (no ORM), pure functions and module singletons (no DI framework, no classes with hidden state), snake_case in SQL, and a two-layer architecture (ADR-0006).
- Schema, migrations and the migration runner live in their own package, shared by both phases (ADR-0009).
- The Node → Rust rationale is stated here once and is not re-argued per decision.
- The trigger of the port is an open question, `[Q-PORT-TRIGGER]` in the internals.
