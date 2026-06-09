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

Set metadata when the current context supports a grounded estimate. Leave an
axis unset instead of guessing. Difficulty is normally architect-owned.
Criticality should follow user or product intent; if you infer it, be
conservative and allow the user to override it.

For file-backed Backlog items, Multicode stores durable metadata in
`.multi-code/backlog/items.json`. Markdown frontmatter may seed metadata when
an agent creates or imports a file, but it is not required and is not the
long-term source of truth once the object store has a value.
