# Architecture reviews and retrospectives

How a review of this codebase (`/improve-codebase-architecture`) and a retrospective (`/retro`) report their findings here. This format takes precedence over the skills' default report: the report is a Markdown file, written for a reader who thinks in prose.

## Where

- A review report is `.scratch/reviews/<date>-<slug>.md` (`2026-10-21-architecture.md`); a retrospective is `.scratch/reviews/<date>-retro.md`. `.scratch/` is git-ignored, so the file survives the session without landing in history, and a later session reaches it by path.
- A candidate the user picks becomes a ticket under `.scratch/issues/` (see `issue-tracker.md`); the ticket restates the candidate in full, so it stands without the report.

## The report

One section per candidate, in order of strength, then a closing section naming the candidate to take first and why. Each candidate section carries, as prose, in this order:

1. **Le constat** — what the code does today, with the files and lines that show it, and the measure when there is one (how many times a shape is restated, how many commits touched a file). Enough that the reader can see the situation without opening the files.
2. **Pourquoi c'est un problème** — the friction in the review's own vocabulary (locality, leverage, seam, depth), the deletion test and its verdict, and what the next feature would cost. State what fails or drifts, not that something is "shallow".
3. **Ce que le candidat propose** — the change in plain words, what moves where, what disappears, what the tests become. No interface design: that is the grill's work.
4. **Ce qui se décide au grill** — the design points the proposal leaves open, each in one sentence, so the user knows what the next conversation will be about.
5. **Force** — Strong, Worth exploring or Speculative, with the sentence that justifies it; an ADR the candidate contradicts is named here, with why it is worth reopening.

A mechanism is explained in words; the report carries no diagram. Four paragraphs for a candidate is the right length; a reader who has to ask for the problem to be explained again is the sign the constat was too short.
