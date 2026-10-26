---
status: accepted
date: 2026-10-14
---

# Make an append-only event log the single source of truth

Recorded retroactively; the decision dates from the events table (commits `8a7f915`, `a59b695`).

## Context

The registry is a public commons meant to survive centuries without resting on institutional trust alone. Every mutation — registration and ename addition today, key rotation, revocation, recovery and deactivation later — must stay auditable, and the future cryptographic layer must be able to prove that an event is in the history and that the history has not been rewritten.

## Decision

Every mutation is recorded as an immutable event in an append-only `events` table, the single source of truth. The entity tables (`subjects`, `enames`) are projections, which can be fully rebuilt from the log. The log is public and downloadable.

## Considered options

- **CRUD tables with an audit log on the side** (triggers or application-level history). Rejected: the audit log is a by-product that can diverge from the state, an UPDATE rewrites the past, and there is nothing canonical to anchor cryptographically.
- **A dedicated event store or message broker as the log.** Rejected: one more stateful system to operate; the hosting target offers a single managed PostgreSQL and the log fits in one table.

## Consequences

- A rebuild must be deterministic, so no projection row carries a value the log does not: the internals state the schema discipline that follows (no database-generated timestamp or id, no update in place).
- The registry stores only what binding and verification require; profile data stays on the platforms, which keeps the auditable, non-erasable surface minimal.
