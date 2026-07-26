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

The Backlog panel reads item status from the file's frontmatter, so keeping it current is part of the work, not optional bookkeeping. Whenever the real state of your work changes, set the item's `status` in its frontmatter and save in the same step:

- **Starting**: set `in_progress` before implementation work begins.
- **Blocked on the user**: set `needs_input` the moment you stop to wait for a decision, missing information, or help only a human can provide — and state the specific question in your reply. A `needs_input` status with no stated question is incomplete.
- **Resuming**: set `in_progress` again once unblocked.
- **Finished**: set `completed` only when the work is genuinely complete and verified with real evidence. Never for partial work, and never on mocks, fixtures, or disconnected UI state.
- **Stopping incomplete**: leave the item `in_progress` and report the remaining work — never let it silently look finished or abandoned.

Edit only the frontmatter line you mean to change and leave the document body and every other key untouched. All file paths you write anywhere — notes, replies, evidence — must be project-root-relative (for example `backlog/example.md`), never absolute or machine-specific.

</what-to-do>

<supporting-info>

## Invocation

The exact CLI invocation is adapter-specific. For example, slash-capable CLIs
may expose `/backlog`, while Codex uses explicit skill mention such as
`$backlog`. Once this skill is active, follow the modes below.

**With an item argument** (for example `backlog/<file>.md`, a dragged file path, or a named item):

1. Confirm the path is under `backlog/`. If it is not, refuse and say why — this skill only works Backlog items.
2. Read the item. It is the intake brief: the what, why, user impact, reproduction notes, references, and (optionally) an implementation plan or checklist. If the item carries implementation notes that conflict with the current codebase, the stated behaviour and the current codebase win.
3. Set the item `in_progress` in its frontmatter (see Updating An Item below) **before** starting implementation work.
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
   - Status change (`completed`, `idea`, etc.) — edit the item's frontmatter (see Updating An Item below).
   - Delete — remove the item file at `backlog/<file>`; its sidecar record in `.multi-code/backlog/items.json` (if any) is app-owned churn and is pruned automatically once the file is gone.
   - Archive (the reversible alternative to delete) — move the file under `backlog/archived/`; its status then derives from that path.
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

The item's markdown file is the source of truth for lifecycle and triage. To change `status`, `type`, `difficulty`, `criticality`, `risk`, or `epic`:

1. Open the item file under `backlog/` and edit the matching `key: value` line in its frontmatter (add the line if the key is absent; remove the line to clear a field). Use the documented vocabulary values above.
2. Leave the document body and every other frontmatter key — including unknown keys and their order — untouched. Do not reformat the block.
3. Optionally set `updated:` to the current ISO-8601 UTC timestamp to float the item in the recently-updated sort.

There is no `items.json` surgery and no id/hash computation for a status or triage change — those fields no longer live in the object store.

## Creating An Item

Write a new file `backlog/YYYY-MM-DD-slug.md` (date = today, slug = a short kebab-case title) with a frontmatter block followed by the body:

```markdown
---
type: feature        # epic | feature | bug | mockup | spike
status: idea         # idea | ready | in_progress | needs_input | completed | archived
difficulty: m        # optional: xs | s | m | l | xl
criticality: normal  # optional: low | normal | high | critical
risk: normal         # optional: low | normal | high
---

# Short title

What and why, user impact, reproduction notes for bugs, and any reference needed to understand the request.
```

Set only the axes you can estimate from the current context; leave the rest out rather than guessing.

## Epics

An **epic** groups related items. It is itself a file at `backlog/epics/<slug>.md` with `type: epic`; the `<slug>` is the filename stem (e.g. `backlog/epics/auth-revamp.md` → slug `auth-revamp`) and its title is the first `# Heading`. Membership is **stored up, derived down** — the only stored relationship is each child's `epic:` field, so the grouping can never desync:

- **Assign** an item to an epic: set `epic: <slug>` in the child item's frontmatter.
- **Remove** an item from its epic: delete its `epic:` line.
- **Create** an epic: write `backlog/epics/<slug>.md` with `type: epic` and a `# Title`, then set `epic: <slug>` on each member.
- **Enumerate** an epic's children: `grep -l "^epic: <slug>$" backlog/*.md`.
- **Completion**: an epic is `completed` only when every one of its children is `completed`; never mark an epic `completed` while any child is still open.

When authoring an epic's children, prefer items sized for one agent in one session and, where practical, within one discipline (frontend / backend / main-process / engine), so a sprint architect can route each child to one task without re-slicing. Work that genuinely spans disciplines is either split into sibling children linked in prose, or states its seam — the contract between the halves — so an architect splitting it has the contract handed to them. Keep acceptance criteria self-contained per child: a criterion only verifiable by another child's work belongs on that other child. Every item that changes UI carries a mockup under `backlog/mockups/` (owner rule, 2026-07-26): author it against the design-system tokens, reference it from the item as "build to it", and never leave the reference dangling — a UI item without its mockup is not `ready`.

## Recording The Working Agent

When you pick up an item by **typing** its path (rather than dragging it onto your terminal), the app cannot observe the handoff, so record it yourself — this is what links the item to you in the Backlog panel and shows the Backlog glyph on your terminal. The drag-drop and "Send to agent" paths already do this automatically; this step is only for typed pickup.

Do this **only** when your terminal exposes the agent-identity environment variables Multicode sets when it launches an agent terminal:

- `MULTICODE_WORKSPACE_ID` and `MULTICODE_AGENT_ID` — required; the durable identity.
- `MULTICODE_AGENT_NAME` — optional; the display name for the link label.

If `MULTICODE_AGENT_ID` is empty or unset, skip this (you are not a Multicode-launched agent terminal). Never invent the values, and skip it for worktree-isolated work (a worktree edits its own copy of the object store and would fork the link).

The working-agent link is the one piece of state that does live in the object store — links are app-owned, not frontmatter. When you set the item `in_progress`, also upsert one link into the item record's `links` array in `.multi-code/backlog/items.json`, keyed by its fixed `id` (replace the existing entry if present; leave every other link and field untouched):

```json
{
  "id": "agent-runtime:working-agent",
  "moduleId": "agent-runtime",
  "type": "agent",
  "label": "Agent: <MULTICODE_AGENT_NAME, or MULTICODE_AGENT_ID if the name is unset>",
  "target": { "kind": "agent.terminal", "id": "<MULTICODE_WORKSPACE_ID>/<MULTICODE_AGENT_ID>" },
  "updatedAt": "<real current ISO-8601 timestamp>"
}
```

If the store or the item's record is missing, create the minimal schema-v1 shape — `{ "schemaVersion": 1, "items": [...] }` with a record carrying `id`, `source: { "type": "file", "relativePath": "backlog/<file>" }`, `metadata: {}`, `links: []`, `createdAt`, and `updatedAt`. The record `id` is `stableBacklogObjectId(relativePath)`, the FNV-1a hash used by `src/renderer/src/utils/backlog.ts`. Run this command and use its output verbatim:

```bash
node -e "const p=process.argv[1].replace(/\\\\/g,'/').toLowerCase();let h=2166136261;for(const c of p){h^=c.charCodeAt(0);h=Math.imul(h,16777619)}console.log(JSON.stringify({id:'backlog_'+(h>>>0).toString(36),now:new Date().toISOString()}))" "backlog/<file>"
```

If `node` is unavailable, apply the same algorithm with any runtime (normalize slashes, lowercase, FNV-1a 32-bit from `2166136261` with multiplier `16777619`, formatted `backlog_${(hash >>> 0).toString(36)}`) — execute it, do not estimate. Do **not** write `status` or any triage field into this record; lifecycle lives in the file's frontmatter.

The fixed `id` keeps this idempotent and most-recent-agent-wins per item. The `agent` link type is lifecycle-neutral — it records who is working the item and never changes item status, so the `status` you set in frontmatter stays authoritative.

</supporting-info>
