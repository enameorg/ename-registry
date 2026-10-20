# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                                                                         |
| -------------------------- | -------------------- | ----------------------------------------------------------------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue                                                         |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information                                                        |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified; runs in a background or cloud session with no question left for the maintainer |
| `ready-for-human`          | `ready-for-human`    | Fully specified; runs in a session with the maintainer present to arbitrate what remains open   |
| `wontfix`                  | `wontfix`            | Will not be actioned                                                                            |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the "Label in our tracker" column to match whatever vocabulary you actually use.

The two `ready-*` roles are read against this repo's practice, where the maintainer works in sessions with an agent rather than handing tickets to unattended agents: the split is whether the ticket can run without the maintainer in the loop, not whether a human writes the code. Neither is an end state: a ticket is closed by the terminal statuses `done` and `wontfix` defined in `issue-tracker.md`, which replace the triage label.
