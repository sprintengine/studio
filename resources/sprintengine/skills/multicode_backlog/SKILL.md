# Multicode Backlog

<!-- Keep the lifecycle rules in this skill in sync with
     resources/skills/backlog/SKILL.md (the installable Backlog built-in
     skill that carries the same contract for manual agent terminals). -->

<what-to-do>

Backlog items are durable work records: markdown files under `backlog/` (epics
under `backlog/epics/`), each file's frontmatter the source of truth for its
lifecycle. Field names and their valid values come from the `backlog.*` MCP tool
schemas — read them there, not from this skill. Use those tools for mutations so
timestamps and links stay app-owned; without them, edit frontmatter directly and
drop the `updated:` line rather than inventing a timestamp.
`.multi-code/backlog/items.json` is app-owned: never edit it, never compute ids.

The Backlog panel reads status from the item file, so keeping it current is
part of the work, not optional bookkeeping. Set `in_progress` before
role-specific work begins;
`needs_input` the moment you stop for a decision only a human can make, stating
the question in your reply; `in_progress` again on resume; `completed` only on
verified work. Stopping early for any other reason leaves it `in_progress` with
the remaining work reported.

Creating an item needs no tool: write the file yourself with only frontmatter
fields you can honestly fill, omitting `id:` and `updated:` — the app allocates
them on its next scan.

</what-to-do>

<supporting-info>

## Item Content

Err toward a rich item rather than a thin one. Beyond the core — what, why, user
impact, reproduction notes for bugs — how much implementation detail to carry
depends on who executes it:

- **Planned intake** (an architect plans it at sprint start): behaviour-focused
  content is ideal. Implementation notes are advisory hints the architect may
  override.
- **Direct pickup** (handed straight to one agent): include the intended
  approach, affected areas, and verification expectations, so it can be executed
  without a separate planning pass.

Never strip detail to keep an item "behaviour only". Where implementation notes
conflict with the codebase at execution time, the stated behaviour and the
current codebase win.

Set an estimate axis only where the context supports a grounded one; leave it
unset rather than guess. Difficulty is normally architect-owned. Criticality
follows user or product intent — if you infer it, be conservative and let the
user override.

## Epics

An epic groups related items: a file at `backlog/epics/<slug>.md` with
`type: epic`, its title the first `# Heading`. Membership is **stored up,
derived down** — the only stored relationship is each child's `epic:` field.
Assign or remove members by updating the child. Enumerate children with
`grep -l "^epic: <slug>$" backlog/*.md`. An epic is complete only when every
child is, and that status is derived — never write one onto the epic file.

Size children for one agent in one session and, where practical, within one
discipline (frontend / backend / main-process / engine). Work genuinely spanning
disciplines either splits into sibling children linked in prose, or states its
seam — the contract between the halves. Keep acceptance self-contained per child:
a criterion only verifiable by another child's work belongs on that other child.

Every item that changes UI carries a mockup under `backlog/mockups/` (owner rule,
2026-07-26): author it against the design-system tokens and reference it from the
item as "build to it". A UI item with a dangling or missing mockup is not ready.
UI must be self-evident (owner rule, same day): no captions or helper copy
explaining what a control is or why it exists. If a control needs a sentence,
redesign the control.

## Working An Item Directly

When a user drags a `backlog/...` file into a terminal or hands you one, treat it
as the intake brief: confirm the path is under `backlog/`, read it whole with any
mockup it attaches, and derive the project-root-relative path. Check it against
the current code before implementing — items drift, and a stale one describes a
design that no longer fits. Where it has drifted, fix the item first and say what
you changed. Then run the lifecycle above.

For a typed pickup not already linked by drag/drop or `backlog.work`, record
attribution with `backlog.assign`, passing the real `MULTICODE_AGENT_ID` and
using `MULTICODE_AGENT_NAME` as its label when present. Never invent identity —
skip attribution when no agent id is exposed.

</supporting-info>
