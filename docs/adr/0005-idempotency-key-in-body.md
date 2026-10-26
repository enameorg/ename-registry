---
status: accepted
date: 2026-10-14
---

# Carry the idempotency key in the request body, not a header

Recorded retroactively; the decision dates from the first write endpoint (commits `49bb259`, `a59b695`).

## Context

Every write endpoint is idempotent through a client-provided UUIDv7 key, and the future layer-1 signature will cover what the actor submitted (ADR-0004). The HTTP convention is an `Idempotency-Key` header.

## Decision

The key is a mandatory `idempotencyKey` field in the JSON body. It is stored in its own `events.idempotency_key` column, outside the `request` JSONB. Covering the key is a requirement on the signature scheme, settled with `[Q-CRYPTO-IMPL]`; placing it in the body keeps that possible without a header-canonicalization scheme.

## Considered options

- **`Idempotency-Key` header**, the usual convention. Rejected: headers sit outside the signed payload; signing them needs a canonicalization scheme, one more moving part for a multi-century format.
- **Server-derived key** (hash of the body). Rejected: two legitimate, identical registrations would collide, and the client loses control over retry semantics.

## Consequences

- Generated SDKs expose the key as a body field, not a transport option.
- The same key and body sent again get a replay of the prior result; the same key with a different body or path is a 409.
- Key uniqueness is global in v1 and becomes per platform once platforms are authenticated, for isolation between them, not only collision avoidance.
