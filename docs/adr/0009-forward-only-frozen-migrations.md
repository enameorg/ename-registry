---
status: accepted
date: 2026-10-14
---

# Forward-only migrations, frozen once applied, run by an in-house runner

Recorded retroactively; the runner dates from commit `f73d9b1`, the transaction-level lock from commit `d940760`, the byte-for-byte freeze from commit `3487e02`.

## Context

The schema is shared by the Node backend, the future Rust backend and any operational tooling, so the migration corpus must be plain SQL and the runner's behaviour must be reimplementable. The hosting target forbids session-level advisory locks and multiplexes connections, and a production schema that has diverged from its migration files is the failure mode to rule out.

## Decision

Migrations are pure SQL files, `<unix_ts>_<name>.sql`, forward-only: there are no down files; a local rollback is a database reset, a production rollback is a new forward migration. A migration is frozen byte for byte from its first application to production, enforced by a SHA-256 of the file's raw bytes recorded in `schema_migrations`, with line endings pinned to LF. The runner is in-house: one transaction per migration holding a transaction-level advisory lock; the `schema_migrations` table and the hash are the contract the Rust phase reimplements.

## Considered options

- **Up/down pairs.** Rejected: down migrations are rarely tested and give a false sense of safety; on an append-only registry, undoing a migration is a forward change anyway.
- **`sqlx-cli`.** Rejected: it ties the layout and the tracking table to a tool from the other phase, and the Node phase would depend on a Rust binary; the runner is about two hundred lines.
- **A JavaScript migration framework** (migrations as code). Rejected: migrations defined in one language are not portable to the other phase.

## Consequences

- An applied migration is frozen in content and presence: a file edited, deleted or renamed after its application is detected, and the run refuses to apply anything until the corpus is restored or a local database is reset. A comment inside a migration states only the local why of its change, as it stands.
- The runner is a library behind a thin CLI, and its invariants have an executable specification, the runner's own test suite, the reference a reimplementation is checked against.
- A `no-transaction` migration (`CREATE INDEX CONCURRENTLY`) has neither the lock nor the rollback: it must be idempotent, and the runner is launched by a single job at a time.
- Overlapping runners serialize and converge; the primary key on `schema_migrations.version` is the hard guarantee.
