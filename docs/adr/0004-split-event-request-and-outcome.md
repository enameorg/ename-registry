---
status: accepted
date: 2026-10-14
---

# Split an event into a `request` and an `outcome` column

Recorded retroactively; the decision dates from commit `6b01d89` (the split) and commit `d10a5e7` (strict request bodies).

## Context

The cryptographic layer is not built yet, but it fixes two distinct scopes: what the submitting actor will sign (layer 1), and what the registry commits to in its signed tree heads (layer 2). A single `payload` column mixed the actor's input with the server's allocations (ids, sequenced counters), so a future signature over it would either cover values the signer never saw or require the server to strip them.

## Decision

An event carries two JSONB columns. `request` is exactly what the actor submitted, nested by entity block; `outcome` is what the server allocated. Both exclude the idempotency key and the timestamp, which have their own columns. So that the stored `request` is exactly what the client submitted and nothing else, HTTP input objects are strict at every nesting level: an unknown field is rejected, never dropped.

## Considered options

- **One `payload` column.** Rejected: the signature scope would be ambiguous and the server would have to reconstruct the signed subset at verification time.
- **Signing a canonical re-serialization regardless of storage.** Rejected for now: it needs canonicalization machinery whose choice belongs to the open cryptographic design (`[Q-CRYPTO-IMPL]`), and the storage split costs nothing today.

## Consequences

- Request and response bodies are nested by entity block, mirroring the event: one mental model from wire to log.
- An unknown field in a request body is a 422 naming the key.
- Idempotency reconciliation compares the submitted request with the stored `request` by structural equality (ADR-0005).
