# AGENTS.md

## Context

Ename is a public registry of verified human identifiers (format `<name>#<number>`) designed to last for centuries, operated by a nonprofit organization. To learn more about Ename, you can consult the document [Ename — Reference Synthesis](./docs/ename-synthesis.md). For the registry's internal architecture, conventions and code guidelines — from the event-sourced data model and the two-layer backend to the API contract, code conventions, tooling and infrastructure — see [Ename — Registry Internals](./docs/ename-internals.md).

## Documentation discipline

Technical documentation has three tiers, each recording what the tier below cannot state about itself and never duplicating it. The code and its comments are the source of truth for the spec. `docs/ename-internals.md` sits one level above: the current architecture, conventions and cross-cutting invariants, stated in the present tense. The ADRs under `docs/adr/` hold the trade-off behind a decision — context, rejected alternatives, consequences — and the internals link to them (conventions in `docs/agents/domain.md`). Any change to architecture, conventions, or the public contract under `backend/` or `database/` updates the internals, and the ADRs it touches, in the same change. Operational setup and commands live in each package's `README.md`, not in `ename-internals.md`.

Three writing constraints for all project documentation: keep it short and plain; write in the present, stating things as they stand rather than as a change from a prior state ("X is forbidden", not "X remains forbidden"); and justify a decision by what it does in the current codebase, not by how it maps to the eventual Rust port — that Node→Rust rationale is stated once, at the architecture level, never re-argued per decision.

## Agent skills

### Issue tracker

Issues and specs live as local markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels, unchanged: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` at the repo root, ADRs under `docs/adr/`. See `docs/agents/domain.md`; its ADR conventions (frontmatter, length, boundary with the internals) take precedence over the skills' default ADR format.

## Imports (loaded into context every session)

Local instruction overrides:

@AGENTS.local.md

Reference docs:

@README.md
@backend/README.md
@database/README.md
@docs/ename-synthesis.md
@docs/ename-internals.md
