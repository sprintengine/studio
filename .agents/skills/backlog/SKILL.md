---
name: backlog
description: Take, work, survey, or triage Multicode Backlog items with truthful lifecycle status. Use when the user invokes /backlog, drags a backlog/ file into the terminal, asks the agent to pick up/survey/work a Backlog item, or asks to triage/prune/review the backlog, and keep .multi-code/backlog/items.json status current while working.
---

# Backlog

<!-- Keep the lifecycle rules in this skill in sync with
     resources/sprintengine/skills/multicode_backlog/SKILL.md (the Sprint
     Engine composed-Soul copy of the same contract). -->

<what-to-do>

Work a Multicode Backlog item as the intake brief for direct agent pickup, keeping the item's lifecycle status truthful in the Backlog panel the whole time. Items live as files under `backlog/` in the project root; their lifecycle and triage metadata live in the object store `.multi-code/backlog/items.json`.

The Backlog panel reads item status from the object store, so keeping it current is part of the work, not optional bookkeeping. Whenever the real state of your work changes, update the item's `status` and `updatedAt` in the same step:

- **Starting**: set `in_progress` before implementation work begins.
- **Blocked on the user**: set `needs_input` the moment you stop to wait for a decision, missing information, or help only a human can provide — and state the specific question in your reply. A `needs_input` status with no stated question is incomplete.
- **Resuming**: set `in_progress` again once unblocked.
- **Finished**: set `completed` only when the work is genuinely complete and verified with real evidence. Never for partial work, and never on mocks, fixtures, or disconnected UI state.
- **Stopping incomplete**: leave the item `in_progress` and report the remaining work — never let it silently look finished or abandoned.

Follow the object-store procedure in the supporting info exactly; never compute ids or timestamps in your head. All file paths you write anywhere — status records, notes, replies, evidence — must be project-root-relative (for example `backlog/example.md`), never absolute or machine-specific.

</what-to-do>

<supporting-info>

## Invocation

**With an item argument** (`/backlog backlog/<file>.md`, a dragged file path, or a named item):

1. Confirm the path is under `backlog/`. If it is not, refuse and say why — this skill only works Backlog items.
2. Read the item. It is the intake brief: the what, why, user impact, reproduction notes, references, and (optionally) an implementation plan or checklist. If the item carries implementation notes that conflict with the current codebase, the stated behaviour and the current codebase win.
3. Set the item `in_progress` in the object store (see below) **before** starting implementation work.
4. Do the work, honouring whatever role or Soul you are already operating under. Follow the item's checklist if it has one, updating it as you go.

**Without an argument** (`/backlog` alone): survey, then ask — never pick work silently.

1. Read `.multi-code/backlog/items.json` (if present) and list the item files under `backlog/`.
2. Exclude items whose status is `completed`, `archived`, or `in_progress`.
3. Rank the remainder: `ready` before `idea`, then higher `criticality` first, then smaller `difficulty` first; items missing an axis rank after estimated ones at the same level.
4. Present a short ranked list (title, one-line intent, type/size/priority when known) and ask the user which item to take. Once they choose, continue as if that item had been the argument.

**Triage the backlog** (`/backlog triage`, or "triage/prune/review the backlog"): assess every item against the current codebase, report, then ask before changing anything. Triage never deletes, completes, or re-statuses an item silently.

1. Read `.multi-code/backlog/items.json` (if present) and every non-archived item file under `backlog/`.
2. Read each item and judge it against the **current codebase** (and recent git history when useful). Sort each into:
   - **Worth doing now** — still relevant open work. Note a one-line reason it matters and roughly how it ranks.
   - **Already done** — the described behaviour already exists in the code. Recommend status `completed`.
   - **Outdated / no longer relevant** — the premise is gone, the code moved on, or another item/run supersedes it. Recommend deleting or archiving.
   - **Status drift** — the recorded `status` does not match reality (e.g. `in_progress`/`needs_input` with no live run or agent session backing it, or a linked run that has already finished). Recommend the truthful status.
   Base every judgement on what you actually find in the repo. If you cannot tell whether an item is still relevant, leave it under "worth doing now / needs a human look" — never recommend deletion on a guess.
3. Present one report grouped by those buckets. Each line: title, project-relative path (e.g. `backlog/example.md`), a one-line reason, and the proposed action. Do **not** mutate or delete anything yet.
4. Ask the user to confirm which recommendations to apply. Then apply **only** what they approve, leaving everything else untouched:
   - Status change (`completed`, `idea`, etc.) — use the Object Store Updates procedure below.
   - Delete — remove the item file at `backlog/<file>` and delete its matching record (by `source.relativePath`) from the `items` array in `.multi-code/backlog/items.json`.
   - Archive (the reversible alternative to delete) — move the file under `backlog/archived/`; its status then derives from that path.
   Report exactly what changed, in project-relative paths.

## Item Vocabulary

Triage metadata is lightweight and optional; leave an axis unset rather than guessing:

- `type`: `feature`, `bug`, or `mockup`.
- `difficulty`: t-shirt size `xs`, `s`, `m`, `l`, or `xl`.
- `criticality`: `low`, `normal`, `high`, or `critical`.
- `status`: `idea`, `ready`, `in_progress`, `needs_input`, `completed`, or `archived`.

Markdown frontmatter may have seeded metadata, but the object store is the source of truth once it has a value. Do not edit an item's frontmatter just to change status.

## Object Store Updates

To update an item's record in `.multi-code/backlog/items.json`:

1. Match records by `source.relativePath`, case-insensitively, after normalizing backslashes to forward slashes.
2. Change only `status` and `updatedAt` (current ISO-8601 UTC timestamp). Preserve every other field: `type`, `difficulty`, `criticality`, `metadata`, `links`, `createdAt`, and anything else present.
3. If the store or the item's record is missing, create the minimal schema-v1 shape: `{ "schemaVersion": 1, "items": [...] }`, and a record with `id`, `source: { "type": "file", "relativePath": "backlog/<file>" }`, `status`, `metadata: {}`, `links: []`, `createdAt`, and `updatedAt`.
4. `id` is `stableBacklogObjectId(relativePath)` — the FNV-1a hash used by `src/renderer/src/utils/backlog.ts`. Run this command and use its output verbatim:

   ```bash
   node -e "const p=process.argv[1].replace(/\\\\/g,'/').toLowerCase();let h=2166136261;for(const c of p){h^=c.charCodeAt(0);h=Math.imul(h,16777619)}console.log(JSON.stringify({id:'backlog_'+(h>>>0).toString(36),now:new Date().toISOString()}))" "backlog/<file>"
   ```

   If `node` is unavailable, use any runtime to apply the same algorithm (normalize slashes, lowercase, FNV-1a 32-bit starting from `2166136261` with multiplier `16777619`, formatted as `backlog_${(hash >>> 0).toString(36)}`) — but execute it, do not estimate. Use the real current time for `updatedAt`/`createdAt`, never a placeholder.

</supporting-info>
