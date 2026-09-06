---
name: studio-backlog
description: Read, triage, update and hand out SprintEngine Studio Backlog items and epics through the backlog_* tools. Use when asked to survey or triage the backlog, to pick up or work a backlog item, to set an item's status or triage axes, to record which agent is working an item, to repair a broken item file, or when a prompt names a path under backlog/.
---

# Backlog

Items are markdown files under `backlog/`, epics under `backlog/epics/`. Each
file's frontmatter is the source of truth for its lifecycle. `.multi-code/` is
app-owned and never edited by hand.

Prefer the `backlog_*` tools over editing files: they keep timestamps and
working-agent links app-owned, and the Backlog panel's watcher sees their
writes. Field names and their valid values come from the tool schemas — read
them there rather than from this skill. Without the tools, edit frontmatter
directly and drop the `updated:` line so nothing claims a timestamp it did not
earn.

Paths are project-relative and must be under `backlog/`. An item that is
`completed` or lives under `backlog/archived/` is refused as unworkable, and a
missing path is refused as not found; both are answers, not errors to retry.

Which project those relative paths are relative to comes from the connection
when it has a workspace to default from. When it does not, every `backlog_*`
tool refuses with `project_root_required` — pass `projectRoot`, the absolute
path to the project folder, and repeat the call. `workspace_list` resolving a
workspace does not mean this connection is bound to one, so do not treat that
as evidence the default will work.

## Survey

`backlog_list` returns every item and epic with title, display id, status, type,
the triage axes and epic membership. It reads frontmatter only and never writes;
archived items are omitted. This is the default action when you were invoked
with no argument — survey and report, do not start working something you were
not handed.

`backlog_read` takes one `path` and returns parsed frontmatter plus the markdown
body. Read the whole body. An item is a brief, and its second half is usually
where the acceptance list lives.

## Work

The item is your brief. Read it whole, and read any mockup it attaches. Before
implementing, check it against the current code: items drift, and a stale one
describes a design that no longer fits. Where it has drifted, fix the item first
and say what you changed, so the record stays true.

Set it `in_progress` with `backlog_update` when you start. Set it `needs_input`
with the actual question if you get blocked. Set it `completed` only on verified
work — if you stop early, leave it `in_progress` and say where you stopped.
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

## Hand work out

`backlog_assign` with `{path, agentId}` records which agent is working an item —
the working-agent link the Backlog panel shows. It is idempotent, replaces any
previous link, and never changes status. The panel watches item files, so a bare
assignment appears on its next refresh rather than instantly.

`backlog_work` does the whole handoff in one call: it launches a configured
agent whose first input is the target CLI's backlog invocation, then records the
link. It never changes status — the item's lifecycle belongs to whoever works
it, exactly as if a person had dragged the item onto a terminal. It takes the
same launch fields as `agent_launch` minus specialist and connector, and
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
