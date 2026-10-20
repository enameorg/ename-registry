# Issue tracker: Local Markdown

Issues and specs for this repo live as markdown files in `.scratch/`. The tracker is flat: one numbered file per ticket, whatever the effort it belongs to, the way a hosted tracker numbers issues repo-wide.

## Conventions

- One file per ticket at `.scratch/issues/<NNN>-<slug>.md`, numbered on three digits from `001`, repo-wide: a number is never reused, so `004` names exactly one ticket. Never a single combined tickets file
- A spec is `.scratch/specs/<slug>.md`; a ticket cut from a spec names it in a `Spec:` line near the top
- Triage state is recorded as a `Status:` line near the top of each ticket (see `triage-labels.md` for the role strings)
- Every header line (`Status:`, `Blocked by:`, `Spec:`, `Map:`, `Type:`) is written with its key in bold and the value after it on the same line, `**Status:** done`, the form the ticket template uses; a scan matches the line by its `**Status:**` prefix, so a key without the bold is not a header line
- Blocking is a `Blocked by: NNN, NNN` line near the top; a ticket is unblocked when every ticket it lists is closed
- Comments and conversation history append to the bottom of the file under a `## Comments` heading, one dated entry per contribution
- A ticket is closed in place, never moved or deleted: its `Status:` becomes `done` (the work landed; the closing comment names the landing commit) or `wontfix`. Both are terminal, and they replace the triage label the ticket held, which carries no information once the work is closed
- A frontier scan reads the `Status:` line and skips every terminal value (`done`, `wontfix`, `resolved`); it never relies on a file's location

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/issues/` with the next free number: the highest number present plus one, closed tickets included. A spec goes to `.scratch/specs/`.

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the number (`004`) or the path directly; a number resolves to the single file whose name starts with it.

## When a skill says "close the issue"

Append the closing comment under `## Comments` (what landed, the commit, or why it is not actioned), then set `Status: done` or `Status: wontfix`. Nothing else changes.

## When a skill queries the tracker

"What is open", "what needs attention", "what is ready for agents": list the files under `.scratch/issues/` whose `Status:` is not terminal, grouped by that line.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/maps/<effort>.md` (the Notes / Decisions-so-far / Fog body).
- **Child ticket**: `.scratch/issues/NNN-<slug>.md`, numbered like any other ticket, with the question in the body. A `Map:` line names its map, a `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`), and the `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NNN, NNN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/issues/` for the map's children that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far.
