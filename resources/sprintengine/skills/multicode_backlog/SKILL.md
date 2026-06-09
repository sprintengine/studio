# Multicode Backlog

Backlog items are durable work-intake records, not implementation plans.

When creating or updating a Backlog item, describe the outcome in plain
language: the feature to add, bug to fix, or mockup/reference to preserve.
Capture the what and why, user impact, reproduction notes for bugs, and any
external reference needed to understand the request.

Do not prescribe implementation components, files, services, migrations,
task breakdowns, or acceptance-test internals in the Backlog item. Those are
decided later by the architect at Sprint Engine start time after reading the
current codebase, Knowledge Graph, tests, and runtime constraints.

Backlog metadata is lightweight triage:

- `type`: `feature`, `bug`, or `mockup`.
- `difficulty`: t-shirt size `xs`, `s`, `m`, `l`, or `xl`.
- `criticality`: `low`, `normal`, `high`, or `critical`.
- `status`: `idea`, `ready`, `in_progress`, `completed`, or `archived`.

Set metadata when the current context supports a grounded estimate. Leave an
axis unset instead of guessing. Difficulty is normally architect-owned.
Criticality should follow user or product intent; if you infer it, be
conservative and allow the user to override it.

For file-backed Backlog items, Multicode stores durable metadata in
`.multi-code/backlog/items.json`. Markdown frontmatter may seed metadata when
an agent creates or imports a file, but it is not required and is not the
long-term source of truth once the object store has a value.

## Working A Dropped Backlog Item

When a user drags a `backlog/...` item into a terminal and asks you to work it
directly, treat the dragged file as the intake brief and the object store as the
durable lifecycle metadata.

1. Confirm the path is under `backlog/`, read the item, and derive the
   project-root-relative source path, for example `backlog/example.md`.
2. Before doing role-specific implementation work, update
   `.multi-code/backlog/items.json` so the matching item's `status` is
   `in_progress` and `updatedAt` is the current ISO timestamp.
3. Match records by `source.relativePath` case-insensitively after normalizing
   slashes. Preserve existing `type`, `difficulty`, `criticality`, `metadata`,
   `links`, `createdAt`, and any other fields.
4. If the store or item record is missing, create the minimal schema-v1 record:
   `schemaVersion: 1`, `items: []` if needed, then an item with
   `id: stableBacklogObjectId(relativePath)`, `source: { type: "file",
   relativePath }`, `status: "in_progress"`, `metadata: {}`, `links: []`,
   `createdAt`, and `updatedAt`. `stableBacklogObjectId` is the FNV-1a hash
   used by `src/renderer/src/utils/backlog.ts`: normalize slashes, lowercase
   the relative path, start with `2166136261`, for each character XOR the char
   code and multiply with `16777619` using 32-bit integer multiplication, then
   format `backlog_${(hash >>> 0).toString(36)}`.
5. Do not edit markdown frontmatter just to change status. The object store is
   the source of truth for Backlog lifecycle once present.
6. When the work is genuinely complete, set the Backlog item `status` to
   `completed`. If you cannot complete it, leave it `in_progress` and clearly
   report the blocker or remaining work.
