---
name: review-diff
description: Review the uncommitted changes against the repo's written rules, and hunt the docs and comments the diff makes false, in two parallel sub-agents. Use before every commit, or when the user asks to review the current changes.
---

Review the working tree against `HEAD` along two axes, each in its own sub-agent, so neither reviewer is the agent that wrote the code:

- **Standards**: does the diff follow the rules `docs/ename-internals.md` writes down?
- **Coherence**: does any document or comment now say something false?

The reviewers report; the triage below decides. A finding is a claim until checked.

## 1. Capture the diff

Run `git status --short`. Tracked changes are `git diff HEAD`; untracked files are `git ls-files --others --exclude-standard`, read whole. `.scratch/` is out of scope.

Done when you hold the list of every touched file. An empty list ends the skill: say there is nothing to review.

## 2. Run both reviewers

Spawn both sub-agents in one message, read-only, and wait for both reports. Paste each brief below whole, after the list of touched files and the two diff commands.

**Standards brief:**

> Review this uncommitted diff of the Ename registry against every rule `docs/ename-internals.md` writes down (already in your context) and, when the diff touches an ADR, `docs/agents/domain.md`. Read every touched file whole, not only its hunks, and compare new code with its neighbours: the internals ask for symmetry across the codebase, so an asymmetry between parallel units is a finding. Skip what tooling enforces (types, lint, format, import boundaries). Edit nothing.
>
> For each finding give `file:line`, the exact quote, the rule or code it breaks (with its location), a proposed fix, and a mark: **certain** (a rule plainly broken, a fix with no design choice) or **judgement** (a design question, a contract change, a rule that may itself need revising). Under 400 words; say so when there is no finding.

**Coherence brief:**

> Hunt every statement this uncommitted diff of the Ename registry makes false, in both directions: a changed document must be true of the code, and changed code must leave no stale sentence elsewhere. Look in `docs/ename-internals.md`, `docs/adr/`, `docs/ename-signature.md`, `GLOSSARY.md`, the READMEs, and the comments of every touched file and of the files that describe the touched code. Also flag a term the glossary lists under _Avoid_, and documentation written as a change from a prior state instead of in the present. Read every touched file whole. Edit nothing.
>
> For each finding give `file:line`, the exact quote, what the code or the other document actually says (with its location), a proposed correction, and a mark: **certain** or **judgement**. Under 400 words; say so when there is no finding.

Done when both reports are in.

## 3. Triage

Check every finding against the code and the documents before acting on it.

- **False**: drop it, with the one-line reason.
- **Certain and local** (a stale or false comment, a doc sentence the diff made false, a wrap, a proscribed term, a form asymmetry with the code beside it): fix it. Then reread each touched file whole and run `npm run check`.
- **Judgement**: leave the code as is and put the finding to the user.

Done when every finding is dropped, fixed with `npm run check` green, or put to the user.

## 4. Report, then commit

Tell the user what the review found, what you fixed, what you dropped and why, and what waits on them. When the user had asked for a commit, commit only once no judgement finding is open; otherwise the commit waits on their answer.
