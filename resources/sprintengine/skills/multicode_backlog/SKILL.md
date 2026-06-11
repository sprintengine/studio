# Multicode Backlog

<!-- Keep the lifecycle rules in this skill in sync with
     resources/skills/backlog/SKILL.md (the installable /backlog built-in
     skill that carries the same contract for manual agent terminals). -->

<what-to-do>

Backlog items are durable work records. Capture the outcome in plain language — the what and why, user impact, reproduction notes for bugs, and any reference needed to understand the request.

The Backlog panel reads item status from `.multi-code/backlog/items.json`, so keeping it current is part of the work, not optional bookkeeping. Whenever the real state of your work changes, update the item's `status` and `updatedAt` in the same step:

- **Starting**: set `in_progress` before role-specific work begins.
- **Blocked on the user**: set `needs_input` the moment you stop to wait for a decision, missing information, or help only a human can provide — and state the specific question in your reply. A `needs_input` status with no stated question is incomplete.
- **Resuming**: set `in_progress` again once unblocked.
- **Finished**: set `completed` only when the work is genuinely complete and verified. Never for partial work.
- **Stopping incomplete**: leave the item `in_progress` and report the remaining work — never let it silently look finished or abandoned.

Follow the object-store procedure in the supporting info exactly; never compute ids or timestamps in your head.

</what-to-do>

<supporting-info>

## Item Content

Include as much detail as is useful — err on the side of a rich, complete item rather than a thin one. Beyond the behaviour-and-intent core, items may carry a structured implementation plan:

- **Planned intake**: when the item will be planned by the architect at sprint start, behaviour-focused content is the ideal — the architect designs the implementation then, against the current codebase, Knowledge Graph, tests, and runtime constraints. Implementation notes are advisory hints the architect may override.
- **Direct pickup**: when the item is handed straight to a single agent, include the intended approach, affected areas, task breakdown, and verification expectations so any agent can execute without a separate planning pass.

Do not strip detail from an item to keep it "behaviour only". If implementation notes conflict with the codebase at execution time, the stated behaviour and the current codebase win.

## Metadata

- `type`: `feature`, `bug`, or `mockup`.
- `difficulty`: t-shirt size `xs`, `s`, `m`, `l`, or `xl`.
- `criticality`: `low`, `normal`, `high`, or `critical`.
- `status`: `idea`, `ready`, `in_progress`, `needs_input`, `completed`, or `archived`.

Set an axis only when the current context supports a grounded estimate; leave it unset instead of guessing. Difficulty is normally architect-owned. Criticality follows user or product intent; if you infer it, be conservative and let the user override.

Markdown frontmatter may seed metadata when an agent creates or imports a file, but the object store is the source of truth once it has a value. Do not edit frontmatter just to change status.

## Working A Dropped Backlog Item

When a user drags a `backlog/...` item into a terminal and asks you to work it directly, treat the dragged file as the intake brief:

1. Confirm the path is under `backlog/`, read the item, and derive the project-root-relative source path, for example `backlog/example.md`.
2. Set the item `in_progress` in `.multi-code/backlog/items.json` before role-specific work begins.
3. Match records by `source.relativePath` case-insensitively after normalizing slashes. Preserve existing `type`, `difficulty`, `criticality`, `metadata`, `links`, `createdAt`, and any other fields.
4. If the store or item record is missing, create the minimal schema-v1 record: `schemaVersion: 1`, `items: []` if needed, then an item with `id: stableBacklogObjectId(relativePath)`, `source: { type: "file", relativePath }`, `status: "in_progress"`, `metadata: {}`, `links: []`, `createdAt`, and `updatedAt`. `stableBacklogObjectId` is the FNV-1a hash used by `src/renderer/src/utils/backlog.ts`. Run this command and use its output verbatim:

   ```bash
   node -e "const p=process.argv[1].replace(/\\\\/g,'/').toLowerCase();let h=2166136261;for(const c of p){h^=c.charCodeAt(0);h=Math.imul(h,16777619)}console.log(JSON.stringify({id:'backlog_'+(h>>>0).toString(36),now:new Date().toISOString()}))" "backlog/<file>"
   ```

   If `node` is unavailable, apply the same algorithm with any runtime (normalize slashes, lowercase, FNV-1a 32-bit from `2166136261` with multiplier `16777619`, formatted `backlog_${(hash >>> 0).toString(36)}`) — execute it, do not estimate. Use the real current time for timestamps.
5. Do not edit markdown frontmatter just to change status. The object store is the source of truth for Backlog lifecycle once present.

</supporting-info>
