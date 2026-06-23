# AGENTS.md

## Context

Ename is a public registry of verified human identifiers (format `<name>#<number>`) designed to last for centuries, operated by a nonprofit organization. To learn more about Ename, you can consult the document [Ename — Reference Synthesis](./docs/ename-synthesis.md). For the registry's internal architecture, conventions and code guidelines — from the event-sourced data model and the two-layer backend to the API contract, code conventions, tooling and infrastructure — see [Ename — Registry Internals](./docs/ename-internals.md).

## Documentation discipline

The code and its comments are the source of truth for the spec; `docs/ename-internals.md` sits one level above, recording only what the code cannot state about itself and never duplicating it. Any change to architecture, conventions, or the public contract under `backend/` or `database/` updates `docs/ename-internals.md` in the same change. Operational setup and commands live in each package's `README.md`, not in `ename-internals.md`.

Three writing constraints for all project documentation: keep it short and plain; write in the present, stating things as they stand rather than as a change from a prior state ("X is forbidden", not "X remains forbidden"); and justify a decision by what it does in the current codebase, not by how it maps to the eventual Rust port — that Node→Rust rationale is stated once, at the architecture level, never re-argued per decision.

## Imports (loaded into context every session)

Local instruction overrides:

@AGENTS.local.md

Reference docs:

@README.md
@backend/README.md
@database/README.md
@docs/ename-synthesis.md
@docs/ename-internals.md
