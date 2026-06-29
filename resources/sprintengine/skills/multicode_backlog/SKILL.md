# Multicode Backlog

<!-- Keep the lifecycle rules in this skill in sync with
     resources/skills/backlog/SKILL.md (the installable Backlog built-in
     skill that carries the same contract for manual agent terminals). -->

<what-to-do>

Backlog items are durable work records. Capture the outcome in plain language — the what and why, user impact, reproduction notes for bugs, and any reference needed to understand the request.

The Backlog panel reads item status from each item file's **frontmatter** under `backlog/`, so keeping it current is part of the work, not optional bookkeeping. Whenever the real state of your work changes, set the item's `status` in its frontmatter and save in the same step:

- **Starting**: set `in_progress` before role-specific work begins.
- **Blocked on the user**: set `needs_input` the moment you stop to wait for a decision, missing information, or help only a human can provide — and state the specific question in your reply. A `needs_input` status with no stated question is incomplete.
- **Resuming**: set `in_progress` again once unblocked.
- **Finished**: set `completed` only when the work is genuinely complete and verified. Never for partial work.
- **Stopping incomplete**: leave the item `in_progress` and report the remaining work — never let it silently look finished or abandoned.

Edit only the frontmatter line you mean to change; leave the document body and every other key untouched.

</what-to-do>

<supporting-info>

## Item Content

Include as much detail as is useful — err on the side of a rich, complete item rather than a thin one. Beyond the behaviour-and-intent core, items may carry a structured implementation plan:

- **Planned intake**: when the item will be planned by the architect at sprint start, behaviour-focused content is the ideal — the architect designs the implementation then, against the current codebase, Knowledge Graph, tests, and runtime constraints. Implementation notes are advisory hints the architect may override.
- **Direct pickup**: when the item is handed straight to a single agent, include the intended approach, affected areas, task breakdown, and verification expectations so any agent can execute without a separate planning pass.

Do not strip detail from an item to keep it "behaviour only". If implementation notes conflict with the codebase at execution time, the stated behaviour and the current codebase win.

## Metadata

The item file's frontmatter owns lifecycle and triage as flat top-level scalars; the object store `.multi-code/backlog/items.json` holds only app-owned churn (links, the star/highlight, module metadata, timestamps).

- `id`: a stable, workspace-global integer that is the item's durable identity — allocated once and **never changed** across re-type/rename/re-triage. Shown as `<KEY>-<id>` (e.g. `MC-240`), the `KEY` from `.multi-code/backlog/config.json`; cite items by that display id. The app assigns ids automatically on scan, so a new item may omit `id`; never reuse or renumber an existing one.
- `type`: `epic`, `feature`, `bug`, `mockup`, or `spike`. `epic` marks a grouping container (see Epics below). An unknown `type:` value is preserved as written and treated as a leaf item.
- `difficulty`: t-shirt size `xs`, `s`, `m`, `l`, or `xl`.
- `criticality`: `low`, `normal`, `high`, or `critical`.
- `risk`: `low`, `normal`, or `high` — likelihood the work goes sideways, a separate axis from effort.
- `status`: `idea`, `ready`, `in_progress`, `needs_input`, `completed`, or `archived`.
- `epic`: slug of the epic this item belongs to (see Epics below).

Set an axis only when the current context supports a grounded estimate; leave it unset instead of guessing. Difficulty is normally architect-owned. Criticality follows user or product intent; if you infer it, be conservative and let the user override.

To change any of these, edit the matching `key: value` line in the item's frontmatter and save — add the line to set a field, remove it to clear one — preserving the body and every other key. Legacy aliases (`size` → difficulty, `priority` → criticality, `itemType`/`backlog_type` → type) are still read. There is no `items.json` surgery for a status or triage change.

## Epics

An epic groups related items. It is itself a file at `backlog/epics/<slug>.md` with `type: epic`; `<slug>` is the filename stem and its title is the first `# Heading`. Membership is **stored up, derived down** — the only stored relationship is each child's `epic:` field:

- **Assign**: set `epic: <slug>` in the child item's frontmatter. **Remove**: delete that line.
- **Create**: write `backlog/epics/<slug>.md` with `type: epic` and a `# Title`, then assign members.
- **Enumerate children**: `grep -l "^epic: <slug>$" backlog/*.md`.
- **Completion**: an epic is `completed` only when every one of its children is `completed`.

## Working A Dropped Backlog Item

When a user drags a `backlog/...` item into a terminal and asks you to work it directly, treat the dragged file as the intake brief:

1. Confirm the path is under `backlog/`, read the item, and derive the project-root-relative source path, for example `backlog/example.md`.
2. Set the item `in_progress` by editing the `status:` line in its frontmatter (add it if absent) before role-specific work begins; leave the body and every other key untouched.
3. Mark it `needs_input` (with the blocking question stated in your reply) whenever you stop to wait on the user, `in_progress` again on resume, and `completed` only once the real work is complete and verified. Stopping incomplete for any other reason leaves it `in_progress` with the remaining work reported.

## Recording The Working Agent

When you pick up a Backlog item by **typing** (e.g. "work on `backlog/foo.md`") rather than dragging it onto your terminal, the app cannot observe the handoff, so record it yourself — this is what lets the Backlog panel link the item to you and shows the Backlog glyph on your terminal.

Do this only when your terminal exposes the agent-identity environment variables (set by Multicode when it launches an agent terminal):

- `MULTICODE_WORKSPACE_ID` and `MULTICODE_AGENT_ID` — required; the durable identity.
- `MULTICODE_AGENT_NAME` — optional; the display name for the link label.

If `MULTICODE_AGENT_ID` is empty or unset, skip this entirely (you are not a Multicode-launched agent terminal). Never invent the values, and skip it for worktree-isolated work (a worktree edits its own copy of the object store and would fork the link).

The working-agent link is the one piece of state that lives in the object store — links are app-owned, not frontmatter. When you set the item `in_progress`, also upsert a single link into the item's `links` array in `.multi-code/backlog/items.json`, keyed by its fixed `id` (replace the existing entry if present; leave all other links and fields untouched):

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

If the store or item record is missing, create the minimal schema-v1 record — `schemaVersion: 1`, `items: []` if needed, then an item with `id: stableBacklogObjectId(relativePath)`, `source: { type: "file", relativePath }`, `metadata: {}`, `links: []`, `createdAt`, and `updatedAt`. `stableBacklogObjectId` is the FNV-1a hash used by `src/renderer/src/utils/backlog.ts`. Run this command and use its output verbatim:

```bash
node -e "const p=process.argv[1].replace(/\\\\/g,'/').toLowerCase();let h=2166136261;for(const c of p){h^=c.charCodeAt(0);h=Math.imul(h,16777619)}console.log(JSON.stringify({id:'backlog_'+(h>>>0).toString(36),now:new Date().toISOString()}))" "backlog/<file>"
```

If `node` is unavailable, apply the same algorithm with any runtime (normalize slashes, lowercase, FNV-1a 32-bit from `2166136261` with multiplier `16777619`, formatted `backlog_${(hash >>> 0).toString(36)}`) — execute it, do not estimate. Do not write `status` or any triage field into this record; lifecycle lives in the file's frontmatter.

The fixed `id` makes this idempotent and most-recent-agent-wins per item. The `agent` link type is lifecycle-neutral: it records who is working the item and never changes item status, so the `status` you set in frontmatter stays authoritative.

</supporting-info>
