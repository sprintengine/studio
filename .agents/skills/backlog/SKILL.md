---
name: backlog
description: Take, work, survey, or triage Multicode Backlog items with truthful lifecycle status. Use when the user explicitly invokes the backlog skill, drags a backlog/ file into an agent terminal, asks the agent to pick up/survey/work a Backlog item, or asks to triage/prune/review the backlog, and keep the item's frontmatter status current while working.
---

# Backlog

<!-- Keep the lifecycle rules in this skill in sync with
     resources/sprintengine/skills/multicode_backlog/SKILL.md (the Sprint
     Engine composed-Soul copy of the same contract). -->

<what-to-do>

Work a Multicode Backlog item as the intake brief for direct agent pickup, keeping the item's lifecycle status truthful in the Backlog panel the whole time. Items live as files under `backlog/` in the project root; each item's lifecycle and triage metadata live in that file's own **frontmatter** — `status`, `type`, `difficulty`, `criticality`, `risk`, and the up-pointing `epic:` slug — and that frontmatter is the source of truth. The object store `.multi-code/backlog/items.json` holds only app-owned churn (links, the star/highlight, module metadata, timestamps); you never touch it to change an item's status or triage.

The Backlog panel reads item status from the file's frontmatter, so keeping it current is part of the work, not optional bookkeeping. Whenever the real state of your work changes, call `backlog.update` for its `status` in the same step:

- **Starting**: set `in_progress` before implementation work begins.
- **Blocked on the user**: set `needs_input` the moment you stop to wait for a decision, missing information, or help only a human can provide — and state the specific question in your reply. A `needs_input` status with no stated question is incomplete.
- **Resuming**: set `in_progress` again once unblocked.
- **Finished**: set `completed` only when the work is genuinely complete and verified with real evidence. Never for partial work, and never on mocks, fixtures, or disconnected UI state.
- **Stopping incomplete**: leave the item `in_progress` and report the remaining work — never let it silently look finished or abandoned.

Use the SprintEngine Studio MCP for every Backlog mutation: `backlog.create`, `backlog.update`, `backlog.assign`, or `backlog.work`. These tools validate schema, preserve omitted fields, write links through the app-owned store, and stamp `updated:` programmatically; never supply or calculate a timestamp. Do not edit Backlog Markdown or `.multi-code/backlog/items.json` directly. If the Studio MCP is missing or unavailable, do not start or fake the mutation: report that the required gateway is unavailable and ask the user to restart/update SprintEngine Studio. All paths passed to tools or written in replies must be project-root-relative.

</what-to-do>

<supporting-info>

## Invocation

The exact CLI invocation is adapter-specific. For example, slash-capable CLIs
may expose `/backlog`, while Codex uses explicit skill mention such as
`$backlog`. Once this skill is active, follow the modes below.

**With an item argument** (for example `backlog/<file>.md`, a dragged file path, or a named item):

1. Confirm the path is under `backlog/`. If it is not, refuse and say why — this skill only works Backlog items.
2. Read the item. It is the intake brief: the what, why, user impact, reproduction notes, references, and (optionally) an implementation plan or checklist. If the item carries implementation notes that conflict with the current codebase, the stated behaviour and the current codebase win.
3. Set the item `in_progress` through `backlog.update` (see Updating An Item below) **before** starting implementation work.
4. Do the work, honouring whatever role or Soul you are already operating under. Follow the item's checklist if it has one, updating it as you go.

**Without an argument**: survey, then ask — never pick work silently.

1. List the item files under `backlog/` and read each one's frontmatter.
2. Exclude epics (`type: epic` — they are grouping containers, not pickable work) and items whose status is `completed`, `archived`, or `in_progress`.
3. Rank the remainder: `ready` before `idea`, then higher `criticality` first, then lower `risk` first, then smaller `difficulty` first; items missing an axis rank after estimated ones at the same level.
4. Present a short ranked list (title, one-line intent, type/size/priority/risk when known) and ask the user which item to take. Once they choose, continue as if that item had been the argument.

**Triage the backlog** (`triage`, or "triage/prune/review the backlog"): assess every item against the current codebase, report, then ask before changing anything. Triage never deletes, completes, or re-statuses an item silently.

1. Read every non-archived item file under `backlog/` (including epics under `backlog/epics/`) and its frontmatter.
2. Read each item and judge it against the **current codebase** (and recent git history when useful). Sort each into:
   - **Worth doing now** — still relevant open work. Note a one-line reason it matters and roughly how it ranks.
   - **Already done** — the described behaviour already exists in the code. Recommend status `completed`.
   - **Outdated / no longer relevant** — the premise is gone, the code moved on, or another item/run supersedes it. Recommend deleting or archiving.
   - **Status drift** — the recorded `status` does not match reality (e.g. `in_progress`/`needs_input` with no live run or agent session backing it, or a linked run that has already finished). Recommend the truthful status.
   Base every judgement on what you actually find in the repo. If you cannot tell whether an item is still relevant, leave it under "worth doing now / needs a human look" — never recommend deletion on a guess.
3. Present one report grouped by those buckets. Each line: title, project-relative path (e.g. `backlog/example.md`), a one-line reason, and the proposed action. Do **not** mutate or delete anything yet.
4. Ask the user to confirm which recommendations to apply. Then apply **only** what they approve, leaving everything else untouched:
   - Status change (`completed`, `idea`, etc.) — call `backlog.update` (see Updating An Item below).
   - Archive — call `backlog.update` with `status: archived`.
   - Delete — there is no agent deletion tool; report the approved deletion for the user/UI instead of deleting the file directly.
   Report exactly what changed, in project-relative paths.

## Item Vocabulary

All lifecycle and triage fields are flat top-level frontmatter scalars; every axis is optional — leave one unset rather than guessing:

- `type`: `epic`, `feature`, `bug`, `mockup`, or `spike` (a time-boxed investigation/decision item — the deliverable is a recommendation, not shipped behaviour). `epic` marks a grouping container; see Epics below. An unknown `type:` value is preserved as written and treated as a leaf item, never coerced.
- `difficulty`: t-shirt size `xs`, `s`, `m`, `l`, or `xl` (effort to build).
- `criticality`: `low`, `normal`, `high`, or `critical` (impact if missing).
- `risk`: `low`, `normal`, or `high` (likelihood the work goes sideways — a separate axis from effort).
- `status`: `idea`, `ready`, `in_progress`, `needs_input`, `completed`, or `archived`.
- `epic`: slug of the epic this item belongs to (see Epics below).

Legacy files may carry a single nested `backlog:` block or the aliases `size` → `difficulty`, `priority` → `criticality`, `itemType`/`backlog_type` → `type`; these are still read. New and edited files use the flat top-level keys above. The star/highlight is owned only by the object store and is never written to frontmatter.

## Updating An Item

The item's Markdown frontmatter remains the source of truth, but agents mutate it only through `backlog.update`. Pass the project-relative item path and only the fields that truly change (`status`, `type`, `difficulty`, `criticality`, `risk`, or `epic`). The server validates values, preserves the body and omitted fields, and records the exact update instant. Do not pass `updated`, edit the file, touch `items.json`, or compute an id/hash.

## Creating An Item

Resolve the current `workspaceId` with `workspace.list`, then call `backlog.create` with the title, description, and only grounded optional triage fields. Set `type: epic` for an epic. The app owns collision-safe paths, schema validation, sidecar registration, and the exact timestamp. Never pass `updated`; the tool deliberately does not accept it. Leave unsupported axes unset rather than guessing.

## Epics

An **epic** groups related items. It is itself a file at `backlog/epics/<slug>.md` with `type: epic`; the `<slug>` is the filename stem (e.g. `backlog/epics/auth-revamp.md` → slug `auth-revamp`) and its title is the first `# Heading`. Membership is **stored up, derived down** — the only stored relationship is each child's `epic:` field, so the grouping can never desync:

- **Assign** an item to an epic: call `backlog.update` with `epic: <slug>` on the child.
- **Remove** an item from its epic: call `backlog.update` with `epic: null` on the child.
- **Create** an epic: call `backlog.create` with `type: epic`, then set `epic: <slug>` on each member through `backlog.update`.
- **Enumerate** an epic's children: `grep -l "^epic: <slug>$" backlog/*.md`.
- **Completion**: an epic is `completed` only when every one of its children is `completed`; never mark an epic `completed` while any child is still open.

## Recording The Working Agent

When a typed pickup was not already linked by drag/drop or `backlog.work`, call `backlog.assign` with the item path and the real `MULTICODE_AGENT_ID`; use `MULTICODE_AGENT_NAME` as the label when available. Never invent identity. If the environment has no agent id, skip attribution. The app owns the object-store id, link shape, and timestamp; never edit `.multi-code/backlog/items.json` yourself.

</supporting-info>
