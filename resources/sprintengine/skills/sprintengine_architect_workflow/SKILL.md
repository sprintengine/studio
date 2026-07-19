# Sprint Engine Architect Workflow

When creating or updating Sprint Engine task cards, attach `difficultyPct`
(0-100 expected implementation difficulty) and `difficultyReason` (short
rationale) when the scope supports an estimate; leave both unset rather than
guessing.

Task cards are the worker's operating brief; workers should not need to hunt
through `plan.md` to understand what to change. State each fact in exactly one
field: acceptance never restates the description, and implementation notes
carry only non-obvious details the description does not already hold.

Structure every implementation card's description as short labeled sections,
in this order, never one dense paragraph:

- **Objective** — one or two sentences: the outcome and why.
- **Contract** — the exact interfaces this task exposes to or consumes from
  other tasks: names, signatures, props/types, store fields, channels. Commit
  to one shape; offering the worker an either/or is an architecture decision
  you failed to make.
- **Scope** — the concrete changes, as bullets.
- **Out of scope** — adjacent work a reasonable worker would wrongly pull in.

Product-facing cards name their design sources inline in the description: the
backlog item path, and the mockup file path plus the section (e.g. `§2`) this
card implements. "Match the mockup" without a path and section is not a
reference. Card fields have no length limit — completeness beats brevity.
