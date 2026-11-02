---
status: accepted
date: 2026-10-14
---

# Carry the idempotency key in the request body, not a header

Recorded retroactively; the decision dates from the first write endpoint (commits `49bb259`, `a59b695`).

## Context

Every write endpoint is idempotent through a client-provided UUIDv7 key, and the signer's signature covers what the signer submitted (ADR-0004, ADR-0011). The HTTP convention is an `Idempotency-Key` header.

## Decision

The key is a mandatory `idempotencyKey` field in the JSON body. It is stored in its own `events.idempotency_key` column, outside the `request` JSONB. In the body, the key is covered by the signature with no header-canonicalization scheme: the signable document carries it beside the request (ADR-0011).

## Considered options

- **`Idempotency-Key` header**, the usual convention. Rejected: headers sit outside the signed payload; signing them needs a canonicalization scheme, one more moving part for a multi-century format.
- **Server-derived key** (hash of the body). Rejected: two legitimate, identical registrations would collide, and the client loses control over retry semantics.

## Consequences

- Generated SDKs expose the key as a body field, not a transport option.
- The same idempotency key sent again with the same body and path, signed by the same signing key, gets a replay of the prior result; the same idempotency key with a different body or path, or signed by another key, is a 409.
- Idempotency-key uniqueness is global. Isolation between signers comes from reconciliation, which compares the signing key (ADR-0011): a signer that reuses another's idempotency key gets a 409, never the other's result.
