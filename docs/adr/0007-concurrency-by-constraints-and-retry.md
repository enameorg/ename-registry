---
status: accepted
date: 2026-10-14
---

# Make concurrent writes safe with UNIQUE constraints and bounded retry

Recorded retroactively; the decision dates from the first write endpoint (commit `49bb259`) and the contention mapping (commit `42db204`).

## Context

Two writes race: two requests with the same idempotency key, and two writes allocating the next `number_part` within the same `name_part`. The hosting target (Scaleway Serverless SQL) fronts the database with PgBouncer in transaction mode: session state does not survive across statements, so session-level advisory locks are unreliable.

## Decision

Correctness rests on UNIQUE constraints. The idempotency race is settled by the UNIQUE on the key: the loser reconciles against the winner's stored request. The counter race is settled by `UNIQUE (name_part, number_part)`: the counter is allocated inside the INSERT and the collision is retried under a SAVEPOINT, a bounded number of times; exhaustion raises a retryable `ContentionError` mapped to 503 with `Retry-After`. The registry relies on neither SERIALIZABLE isolation nor advisory locks, and every new concurrent-write path takes the same shape.

## Considered options

- **SERIALIZABLE isolation.** Rejected: serialization failures must be retried anyway, with higher abort rates and less control over what is retried; the constraint already names the exact conflict.
- **Advisory locks per group.** Rejected: session-level locks are unusable on the hosting target; transaction-level locks would work but add a second coordination mechanism and serialize a hot group inside the database.
- **A dedicated counter table** (one row per `name_part`, incremented under row lock). Rejected: it serializes a group inside the database to absorb a contention that civil names do not produce. A collision needs two allocations of the same `name_part` within one transaction window, a few milliseconds. At a billion users, with a peak of about 100 registrations per second, the most frequent name in the world (of the order of 0.02 % of registrations) arrives about once every 50 seconds: a collision on that name happens about once per 5 000 of its registrations, and exhausting the retry budget, some twenty consecutive collisions, does not happen. An ename is registered once, so no platform ever re-imports a user base into the registry; the only burst on one name is a client sending homonyms in parallel, which the retry absorbs and the 503 bounds.

## Consequences

- The retry budget bounds the concurrent burst one group can absorb; beyond it, clients retry on 503. Organic traffic reaches neither: the retry and the 503 are a safety net, exercised by tests, not a path to optimize.
- A cleanup in a `catch` (`ROLLBACK TO SAVEPOINT`) must never mask the original error.
- The event `sequence` is not gap-free: an aborted transaction burns a value.
