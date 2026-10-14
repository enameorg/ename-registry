---
status: accepted
date: 2026-10-14
---

# Record architecture decisions in ADRs, state in the internals

## Context

`docs/ename-internals.md` describes the registry's architecture and conventions in the present tense, as they stand, and is loaded into every agent session. Written that way, it had no room for the trade-off behind a rule — the alternatives rejected, the consequences accepted — without growing into a document too large to load, and it lost the reason for a change each time a rule was replaced. A code comment could not point to a specific justification either: section headings churn, so the only stable target was the document as a whole.

## Decision

Technical documentation has two tiers above the code. The internals state the current rule, with at most one clause of justification where the rule is counter-intuitive, and link to an ADR. The ADR records the trade-off: context, decision, rejected options, consequences. ADRs cover the decisions the technical team can revise on its own; institutional decisions (mission, governance, public standards) keep the regime of `docs/ename-synthesis.md`.

## Considered options

- **Internals alone.** The present-tense document grows with the product surface and would carry every justification into every session; a rejected alternative has no home and gets re-proposed; a superseded rule leaves no trace but a commit message.
- **ADRs alone.** The current truth is scattered across a chain of superseded files that nothing loads by default; an agent must know to look, and reconstructs the state from history.

## Consequences

- A change of decision is three gestures in one change: a new ADR naming the one it replaces, the old ADR's status set to `superseded`, the internals pointing to the new one.
- The internals are the index of the ADRs; the folder carries no list of its own.
- A code comment may cite an ADR by id, a stable anchor the internals never offered.
