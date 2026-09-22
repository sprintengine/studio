---
name: studio-backlog
description: Read, triage, update and hand out SprintEngine Studio Backlog items and epics through the backlog_* tools. Use when asked to survey or triage the backlog, to pick up or work a backlog item, to set an item's status or triage axes, to record which agent is working an item, to repair a broken item file, or when a prompt names a path under backlog/.
---

# Backlog

Items are markdown files filed under the epic they belong to —
`backlog/<epic-slug>/<item>.md` — or `backlog/unfiled/` when they have no epic.
Epic definitions stay at `backlog/epics/<epic-slug>.md`. Each
file's frontmatter is the source of truth for its lifecycle. The app-owned
workspace directory, `.sprintengine/`, is never edited by hand.

Prefer the `backlog_*` tools over editing files: they keep timestamps and
working-agent links app-owned, and the Backlog panel's watcher sees their
writes. Without the tools, edit frontmatter directly and drop the `updated:`
line so nothing claims a timestamp it did not earn.

## The file

Frontmatter is a flat block of `key: value` scalars — no nested YAML, no lists,
no quotes needed. Unknown keys are preserved, so nothing added by hand is lost.

```yaml
---
type: feature        # epic | feature | bug | mockup | spike
status: idea         # idea | ready | in_progress | needs_input | completed | archived
difficulty: m        # xs | s | m | l | xl              effort to build
criticality: high    # low | normal | high | critical   impact if it is missing
risk: normal         # low | normal | high              likelihood it breaks something
epic: auth-revamp    # optional; the epic file's name stem
dependsOn: token-rotation, session-expiry   # optional; comma-separated sibling slugs
mockups: backlog/mockups/2026-07-06-x.html  # optional; comma-separated project-relative paths
---

# Title as a single H1

GOAL: the observable end state, then the rest of the keys under "Item body".
```

`type` is the only field OKF requires; fill the rest only where you can do so
honestly — an unsized, untriaged capture is a calm state, not a defect, and a
guessed `criticality` is worse than none. `risk` is a separate axis from
`difficulty`: how likely the change is to break something, not how big it is.

Three groups are the app's to write, never yours. **`id:`** is a workspace-global
integer allocated once and never changed — omit it and the scan assigns one; the
`KEY-<id>` shown in the panel is composed from it at render time. **`updated:`**
is a precise UTC instant stamped on every real mutation. And `pr`, `starred`
and `highlight` are written when a pull request opens or somebody stars the
row.

On an epic file, `dependenciesPlanned: true` is the one extra field.

Creating one by hand: put it in its epic's folder, or `backlog/unfiled/` if it
has none, named `<YYYY-MM-DD>-<slug>.md`. Pick a slug unused anywhere in
`backlog/` — `dependsOn:` and `epic:` address an item by filename stem alone, so
two items sharing one collide on every pointer aimed at either.

Paths are project-relative and must be under `backlog/`. An item that is
`completed` or lives under `backlog/archived/` is refused as unworkable, and a
missing path is refused as not found; both are answers, not errors to retry.

Which project those relative paths are relative to comes from the connection
when it has a workspace to default from. When it does not, every `backlog_*`
tool refuses with `project_root_required` — pass `projectRoot`, the absolute
path to the project folder, and repeat the call. `workspace_list` resolving a
workspace does not mean this connection is bound to one, so do not treat that
as evidence the default will work.

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

## Survey

`backlog_list` returns every item and epic with title, display id, status, type,
the triage axes and epic membership. It reads frontmatter only and never writes;
archived items are omitted. This is the default action when you were invoked
with no argument — survey and report, do not start working something you were
not handed.

`backlog_read` takes one `path` and returns parsed frontmatter plus the markdown
body. Read the whole body. An item is a brief: `SPEC` is what to build and
`ACCEPT` is what done means.

## Work

The item is your brief. Read it whole, and read any mockup it attaches. Before
implementing, check it against the current code: items drift, and a stale one
describes a design that no longer fits. Where it has drifted, fix the item first
and add a `LOG` line saying what you changed, so the record stays true.

Set it `in_progress` with `backlog_update` when you start. Set it `needs_input`
if you get blocked, with the actual question as an `OPEN:` line. Set it
`completed` only when every `ACCEPT` line is proved — if you stop early, leave it
`in_progress` and put where you stopped in `LOG`.
After each chunk, re-read what you wrote for contracts you did not honour, gaps
you left, and tests you owed.

`backlog_update` changes lifecycle and triage frontmatter: `status`, `type`,
`difficulty`, `criticality`, `risk`, `epic` membership, and on an epic the
`dependenciesPlanned` ordering mark. Pass null to clear a field; `status` cannot
be cleared. Only supplied fields change and the body is never touched. Fields
apply in a fixed order — status, type, triage, epic, dependenciesPlanned — and
the first invalid field stops the write, leaving the earlier ones applied. If a
call is refused partway, read the item back before retrying.

## Work an epic

Same for every child, in the order their `dependsOn` implies, each one aware of
the others: they share files, and two correct changes can still contradict each
other. An epic's own frontmatter says whether that order has been planned
(`dependenciesPlanned`); if it has not, plan it before dispatching children.
Read the epic file first: its `CONTEXT:` and `DECISIONS:` are what every child
assumes, and its hot files say which children must not run at the same time.

## Hand work out

`backlog_assign` with `{path, agentId}` records which agent is working an item —
the working-agent link the Backlog panel shows. It is idempotent, replaces any
previous link, and never changes status. The panel watches item files, so a bare
assignment appears on its next refresh rather than instantly.

`backlog_work` does the whole handoff in one call: it launches a configured
agent whose first input is the target CLI's backlog invocation, then records the
link. It never changes status — the item's lifecycle belongs to whoever works
it, exactly as if a person had dragged the item onto a terminal. It takes the
same launch fields as `agent_launch` minus the connector, and
`bypass` is refused here as everywhere on this surface. Use it when you are
dispatching, not when you are the one doing the work.

## Triage

Triage is reading and classifying, not implementing. Set the axes that are
genuinely knowable from the item and the code — `type`, `difficulty`,
`criticality`, `risk` — and leave the rest alone rather than guessing. An item
you cannot classify without doing the work is an item to say that about.

## Repair

`backlog_repair` with `{path, issue}` is deliberately narrow: it replaces
embedded NUL bytes with the visible `\0` escape, or reallocates one side of a
proven duplicate numeric id to the next free id. It refuses a file that does not
currently carry the named defect, so it cannot be used as a general editor. Any
other damage is a file to read and fix deliberately, saying what you changed.
