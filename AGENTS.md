# AGENTS.md

## Context

Ename is a public registry of verified human identifiers (format `<name>#<number>`) designed to last for centuries, operated by a non-profit association. To learn more about Ename, you can consult the document [Ename project synthesis](./docs/ename-synthesis.md). For the registry's internal architecture, conventions and code guidelines — from the event-sourced data model and the two-layer backend to the API contract, code conventions, tooling and infrastructure — see [Ename registry internals](./docs/ename-internals.md).

1Place is the first operator of the Ename ecosystem, run by 1Place SASU, a company I manage alone, without partners or employees. To learn more about 1Place, you can consult the document [1Place project synthesis](./docs/1place-synthesis.md).

## Documentation discipline

The code and its comments are the source of truth for the spec; `docs/ename-internals.md` sits one level above, recording only what the code cannot state about itself and never duplicating it. Any change to architecture, conventions, or the public contract under `backend/` or `database/` updates `docs/ename-internals.md` in the same change. Operational setup and commands live in each package's `README.md`, not in `ename-internals.md`.

## Imports (loaded into context every session)

Local instruction overrides:

@AGENTS.local.md

Reference docs:

@README.md
@backend/README.md
@database/README.md
@docs/ename-internals.md
