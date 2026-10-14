# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root, or
- **`GLOSSARY-MAP.md`** at the repo root if it exists: it points at one `GLOSSARY.md` per context. Read each one relevant to the topic.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo (most repos):

```
/
├── GLOSSARY.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

Multi-context repo (presence of `GLOSSARY-MAP.md` at the root):

```
/
├── GLOSSARY-MAP.md
├── docs/adr/                          ← system-wide decisions
└── src/
    ├── ordering/
    │   ├── GLOSSARY.md
    │   └── docs/adr/                  ← context-specific decisions
    └── billing/
        ├── GLOSSARY.md
        └── docs/adr/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0003 (event log as source of truth), but worth reopening because…_

## Architecture decision records

Technical decisions and their rationale are recorded as ADRs under `docs/adr/`; `docs/ename-internals.md` states the current rules and links to the ADR behind each one. Institutional decisions (mission, governance, the public standards) follow the regime of `docs/ename-synthesis.md` and are not ADRs.

**When.** Write an ADR only when all three hold: the decision is hard to reverse, surprising without context, and the result of a real trade-off. A decided-but-unbuilt design (marked `(target)` in the internals) may have an ADR; an open question keeps its `[Q-XXX]` id and is not a `proposed` ADR.

**Boundary with the internals.** The internals state the rule in the present tense, with at most one subordinate clause of justification where the rule is counter-intuitive, and link to the ADR. Context, rejected alternatives and consequences live in the ADR only. A summary sentence next to a link is not a duplication. Every ADR is reachable from the internals: if no rule there states the decision yet (an ADR recording a rejected refactor, for instance), add it as a one-sentence rule with the link, so the internals stay the complete index.

**File.** `docs/adr/NNNN-slug.md`: a four-digit sequential number (scan the folder for the highest and add one) and a kebab-case slug naming the decision, not the topic (`0005-idempotency-key-in-body`, not `0005-idempotency`). Written in English. YAML frontmatter with `status` (`proposed | accepted | deprecated | superseded by ADR-NNNN`) and `date` (when the decision was recorded). Sections are all optional — Context, Decision, Considered options, Consequences; use only those that carry content, and a one-paragraph ADR is valid.

**Length.** An ADR records the trade-off the internals cannot: it is as long as that trade-off needs and no longer. Most fit on one screen; one or two sentences per rejected option. No file paths or function names, which churn: an ADR names concepts, and navigation goes from the code and the internals to the ADR, never back.

**Referencing.** From the internals, a markdown link: `[ADR-0005](./adr/0005-idempotency-key-in-body.md)`. From a code comment, the bare id: `ADR-0005`.

**Amending and superseding.** An existing ADR may be sharpened — context, options, consequences — as long as the decision itself does not change; Git holds the history. Changing the decision is a new ADR whose Context names the one it replaces; the old one's `status` becomes `superseded by ADR-NNNN`, and the internals point to the new one only. All of it lands in the same change as the code.

**Retroactive records.** An ADR written after the fact carries the date it was written and says so in its Context, naming the originating commit when identifiable.
