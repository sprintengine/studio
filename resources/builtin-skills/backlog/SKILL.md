---
name: backlog
description: Work, create, or triage Studio Backlog items and epics. Use when the user invokes this skill, drags a backlog/ file into an agent terminal, or asks to pick up, add, or triage backlog work.
---

# Backlog

Items are markdown files filed under the epic they belong to —
`backlog/<epic-slug>/<item>.md` — or `backlog/unfiled/` when they have no epic.
Epic definitions stay at `backlog/epics/<epic-slug>.md`. Each
file's frontmatter is the source of truth for its lifecycle; the app-owned
workspace directory (`.sprintengine/`) is
never edited by hand. Field names and their valid values come from the
`backlog.*` MCP tool schemas — read them there rather than from this skill, and
use those tools for mutations so timestamps and links stay app-owned. Without
them, edit frontmatter directly and drop the `updated:` line. Three actions:

**Work.** The item is your brief — read it whole, and read any mockup it
attaches. Before implementing, check it against the current code: items drift,
and a stale one describes a design that no longer fits. Where it has drifted, fix
the item first and add a `LOG` line saying what you changed, so the record stays
true. Set it `in_progress` when you start, `needs_input` with the actual question
as an `OPEN:` line if you get blocked, and `completed` only when every `ACCEPT`
line is proved — if you stop early, leave it `in_progress` and put where you
stopped in `LOG`. After each chunk, re-read what you wrote for contracts you did
not honour, gaps you left, and tests you owed.

**Work an epic.** Read the epic file first: its `CONTEXT:` and `DECISIONS:` are
what every child assumes. Then the same for every child, in the order their
`dependsOn` implies, each one aware of the others: they share files, and two
correct changes can still collide — never run two children that share a hot file
at once. Skip children that are `completed`, `archived`, or `idea`. Never write a
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

**Plan an epic's order.** Planning happens here, in the backlog. When authoring
or finishing an epic: add `dependsOn:` edges between children wherever order
matters (comma-separated sibling slugs), and when the ordering is deliberate and
complete — including "no edges, these run in parallel" — set
`dependenciesPlanned: true` on the epic's frontmatter as the last act, by hand or
with `backlog.update {path, dependenciesPlanned: true}`. That flag is what lets
work start from the epic with no further ordering pass; without it, whoever picks the
epic up has to plan it again first. List the parallel lanes and the hot files in
the epic file while you are there: the edges say what must wait, and those two
say what may run together. Nothing recomputes it, so changing which
items belong to the epic is your cue to re-check the order and the flag.

**Create.** Write the file yourself — no tool needed. Put it in its epic's
folder, or `backlog/unfiled/` if it has none. Choose a slug unused anywhere in
`backlog/` — `dependsOn:` and `epic:` point at an item by filename alone, so two
items sharing one collide even in different folders. Then
start with frontmatter carrying only fields you can honestly fill, then a
`# Title` and the body in the keys under "Item body" below — `GOAL`, `STATE` and
`ACCEPT` at the least. Omit `id:` and `updated:`; the app assigns them.

**Triage.** Judge every non-archived item against the current codebase: still
worth doing, already built, overtaken, or simply mis-statused. Report them
grouped with a one-line reason and a proposed action each, change nothing yet,
and apply only what the user approves. If you cannot tell whether an item still
matters, say so rather than guessing it away.

Invoked with no argument, survey instead: list what is open, rank it, and ask
which to take — never pick silently.

## Item body

The body is a brief for the agent that does the work, so it is statements under
fixed keys rather than prose: about half the tokens of the same item written as
paragraphs, and nothing to infer.

```
# Imperative title, a single H1

GOAL:   one line. The observable end state.
WHY:    one line. Optional.
STATE:  what the code does today and what is missing. path:line on every claim.
SPEC:   S1, S2… numbered behaviour statements, each one testable.
DO:     numbered deliverables. Not a tutorial.
TOUCH:  files expected to change or be created.
REUSE:  existing code to call rather than rebuild.
AVOID:  non-goals and forbidden moves.
GATES:  the specific checks that will bite this change.
ACCEPT: [ ] one line per check, each runnable or observable.
OPEN:   exact questions for the owner.
REFS:   decision ids, sibling stems, related items.
LOG:    append-only. YYYY-MM-DD agent: fact.
```

Keys are uppercase with a colon, in that order; omit the empty ones.

- One statement per line. No narrative, no history, no hedging, no restating the
  epic.
- A claim about code carries a `path:line` or a `path`. One you did not check
  starts `VERIFY:`, and whoever works the item checks it first.
- An unknown is an `OPEN:` line holding the exact question. One that blocks the
  work sets the item `needs_input`.
- Each `S` line maps to at least one test. Each `ACCEPT` line is proved by a
  command or a named observable — never "works well".
- Anchors drift. Re-verify every `path:line` before editing, correct the item in
  place, and record the correction in `LOG`.
- `LOG` also takes where you stopped and any ruling you overturned. Lines are
  added, never rewritten.
- `TRAP:` marks a known failure mode and `NEW-DEP:` a dependency to add; both may
  sit inside any section.
- Size: xs and s up to 2 KB, m up to 3 KB, l and xl up to 4 KB. An item over its
  budget is two items.

An epic file hoists what its children share, so no child repeats it: `CONTEXT:`
(repositories, house rules, gates, a code map with anchors, vocabulary) and
`DECISIONS:` (`D1`, `D2`… each marked ACCEPTED or PROPOSED). A child cites `D4`
and never re-argues it; an ACCEPTED ruling that proves wrong is an `OPEN:` line,
while a PROPOSED one may be overturned with evidence and a `LOG` line. After
those, the epic lists its children one line each with their `dependsOn` edges,
the lanes that can run in parallel, and the hot files — files more than one
child touches, which are worked one child at a time. A worker reads the epic
file and its one item, and nothing else until a line sends it there.

An item written as prose before this format is still valid. Convert one when you
are rewriting it anyway, not in bulk.
