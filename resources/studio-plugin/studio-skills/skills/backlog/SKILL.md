---
name: backlog
description: Work, create, or triage Multicode Backlog items and epics. Use when the user invokes this skill, drags a backlog/ file into an agent terminal, or asks to pick up, add, or triage backlog work.
---

# Backlog

Items are markdown files under `backlog/` (epics under `backlog/epics/`). Each
file's frontmatter is the source of truth for its lifecycle; `.multi-code/` is
app-owned, never edited by hand. Field names and their valid values come from the
`backlog.*` MCP tool schemas — read them there rather than from this skill, and
use those tools for mutations so timestamps and links stay app-owned. Without
them, edit frontmatter directly and drop the `updated:` line. Three actions:

**Work.** The item is your brief — read it whole, and read any mockup it
attaches. Before implementing, check it against the current code: items drift,
and a stale one describes a design that no longer fits. Where it has drifted, fix
the item first and say what you changed, so the record stays true. Set it
`in_progress` when you start, `needs_input` with the actual question if you get
blocked, and `completed` only on verified work — if you stop early, leave it
`in_progress` and say where you stopped. After each chunk, re-read what you wrote
for contracts you did not honour, gaps you left, and tests you owed.

**Work an epic.** Same for every child, in the order their `dependsOn` implies,
each one aware of the others: they share files, and two correct changes can still
collide. Skip children that are `completed`, `archived`, or `idea`. Never write a
status onto the epic file — it derives from its children. Review each child as
you finish it, before starting the next: a subagent over that child's diff for
implementation gaps against its acceptance and bugs introduced. Fix what stands.
At the end, review the whole run again — the per-child passes cannot see across
children. Spawn subagents, concurrently, one lens each: implementation gaps
against every child's acceptance; bugs introduced; seams, where the contracts
between children must hold as written; and ripple, what each change affects
elsewhere in the epic. Seam and ripple reviewers get the whole diff, never a
slice. Brief each to assume the work is broken and prove otherwise. Dismiss no
finding without evidence that refutes it; fix or record every one that stands.
Without a subagent mechanism, review from a fresh session. Judge the result
against what the epic said it was for.

**Plan an epic's order.** Planning happens here, not in the sprint engine — the
engine executes tasks in the dependency order the epic declares. When authoring
or finishing an epic: add `dependsOn:` edges between children wherever order
matters (comma-separated sibling slugs), and when the ordering is deliberate and
complete — including "no edges, these run in parallel" — set
`dependenciesPlanned: true` on the epic's frontmatter as the last act, by hand or
with `backlog.update {path, dependenciesPlanned: true}`. That flag is what lets a
sprint start from the epic with no planning agent; without it, a sprint plans the
epic again before any work starts. Nothing recomputes it, so changing which items
belong to the epic is your cue to re-check the order and the flag.

**Create.** Write the file yourself — no tool needed. Choose an unused slug,
start with frontmatter carrying only fields you can honestly fill, then a
`# Title` and the body: what, why, user impact, and anything needed to
understand the request. Omit `id:` and `updated:`; the app assigns them.

**Triage.** Judge every non-archived item against the current codebase: still
worth doing, already built, overtaken, or simply mis-statused. Report them
grouped with a one-line reason and a proposed action each, change nothing yet,
and apply only what the user approves. If you cannot tell whether an item still
matters, say so rather than guessing it away.

Invoked with no argument, survey instead: list what is open, rank it, and ask
which to take — never pick silently.
