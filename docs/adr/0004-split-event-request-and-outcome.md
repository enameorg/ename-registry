---
status: accepted
date: 2026-10-14
---

# Split an event into a `request` and an `outcome` column

Recorded retroactively; the decision dates from commit `6b01d89` (the split) and commit `d10a5e7` (strict request bodies).

## Context

The registry's cryptography has two distinct scopes: what the signer signs (layer 1), and what the registry commits to in its signed tree heads (layer 2). Neither layer existed when the split was decided; layer 1, the signer's signature over its request, is built (ADR-0011), layer 2 is not. A single `payload` column mixed the signer's input with the server's allocations (ids, sequenced counters), so a signature over it would either cover values the signer never saw or require the server to strip them.

## Decision

An event carries two JSONB columns. `request` is exactly what the signer submitted, nested by entity; `outcome` is what the server allocated. Both exclude the idempotency key and the timestamp, which have their own columns. So that the stored `request` is exactly what the client submitted and nothing else, HTTP input objects are strict at every nesting level: an unknown field is rejected, never dropped.

## Considered options

- **One `payload` column.** Rejected: the signature scope would be ambiguous and the server would have to reconstruct the signed subset at verification time.
- **Signing a canonical re-serialization regardless of storage.** Rejected: it needed canonicalization machinery whose choice was still open, and the storage split costs nothing. The signature design keeps both: layer 1 signs the canonical form of the stored `request` (ADR-0011), canonicalization fixing the bytes and the split the scope.

## Consequences

- Request and response bodies are nested by entity, mirroring the event: one mental model from wire to log.
- An unknown field in a request body is a 422 naming the key.
- The exactness of `request` is enforced at the seam that stores it, not only at the HTTP seam: the strict schemas of what a client submits are declared once, in the Service, composed by the event kinds and wrapped by the API, so no field can pass the wire and be stripped on its way into the log.
- Idempotency reconciliation compares the submitted request with the stored `request` by structural equality (ADR-0005).
