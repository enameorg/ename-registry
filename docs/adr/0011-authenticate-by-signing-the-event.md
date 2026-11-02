---
status: accepted
date: 2026-10-30
---

# Authenticate a signer by its signature of the event, not of the transport

## Context

Only accredited platforms may register enames, so the registry must know who submits each request. The log is public and meant to be verified by third parties for centuries: a filter that admits a request and forgets who sent it would leave the attribution of every event resting on the registry's word. The same mechanism must later serve the end users, whose keys live in secure enclaves, and the registry itself (ADR-0012).

## Decision

Every write request carries a signature of its own event: the signer signs a canonical document made of the operation, its key's id, the idempotency key and the request, and the registry stores the signature and the key id in the event. Authentication is the verification of that signature against a key the log recorded; authorization is the owner of that key, which the operation admits or not. The mechanism is the public standard `docs/ename-signature.md`: JCS, ES256 in P1363, SPKI keys.

## Considered options

- **Shared-secret API key**, bearer token checked against a stored hash. Rejected: the secret cannot enter a public log, so attribution stays the registry's word, and anyone who sees the token on its way (a TLS terminator, a log) can use it.
- **Mutual TLS.** Rejected: not offered by the serverless container hosting, and, like any transport authentication, gone once the request is processed.
- **The hosting provider's IAM tokens.** Rejected: they tie the platforms' identity to one provider, against the registry's independence from its host.
- **HTTP Message Signatures (RFC 9421)**, signing the method, path and body digest. Rejected: it signs raw transport bytes the log does not keep; re-verifying it would mean storing bytes, path and headers beside the structured request.
- **A JWS stored in the log.** Rejected: it duplicates the request as an opaque, transport-oriented envelope beside the structured data the log is read from.

## Consequences

- Every event is non-repudiably attributed to a key, verifiable by anyone holding the log.
- A request whose signature does not verify gets neither a write nor a replay; idempotency compares the signing key, so one signer never reads another's result, and a request sent again is signed by the key that signed it first.
- Every implementer — registry, platform, end-user application — implements one canonicalization and one signature, checked by published test vectors.
- The signed request must be exactly the stored request: request schemas stay strict, and no field may be normalized between the wire and the log.
