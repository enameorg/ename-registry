---
status: accepted
date: 2026-10-30
---

# Record accreditations and keys in the event log, submitted by the registry through its signed API

## Context

Verifying a signature (ADR-0011) needs the signer's public key, and deciding whether a platform may register needs the list of accredited platforms. Both change over time, and a third party verifying the log must be able to tell which key was valid, and who was accredited, when each event was signed. The registry also signs what it commits to, which raises where its own key comes from.

## Decision

Accrediting a platform, adding a platform key and adding a registry key are events of the log, like a registration. Platforms and keys are projections rebuilt from it. The registry submits these events through the same signed API as the platforms, signed by a registry key held outside the server: the server only verifies, and never holds a registry private key. The first event of the log, the anchor, adds the first registry key and is signed by that key itself; it is an event of its own kind, which the log admits once, and an initialization command with direct access to the database writes it. Its fingerprint is published outside the log.

## Considered options

- **Platforms and keys in the server's configuration.** Rejected: invisible to a verifier of the log, and a second source of truth beside it.
- **A table outside the log**, written by an administration tool. Rejected for the same reason: the projections must be rebuildable from the log alone.
- **An administration command calling the Service with the registry key in its configuration.** Rejected: it puts the registry's private key where the server runs, and gives the registry's events a path that skips the verification every other event goes through.

## Consequences

- One write protocol serves every event, the anchor included. Every event after the anchor is verified against a key the log recorded, each owner admitting its own keys; the anchor alone is verified against the key its own request adds. Accreditation is visible in the public contract.
- How the registry key is held (HSM, KMS, multi-signature) changes the signing client only, never the server; adding a registry key after the anchor waits on that decision, `[Q-REGKEY-MGMT]`, since one registry key able to add another would make a single compromise permanent.
- A stored event names its key without a foreign key to the keys projection: the log references no projection, which a rebuild must be able to empty.
