# Multicode Backlog

<!-- Keep the lifecycle rules in this skill in sync with
     resources/skills/backlog/SKILL.md (the installable Backlog built-in
     skill that carries the same contract for manual agent terminals). -->

<what-to-do>

Backlog items are durable work records. Capture the outcome in plain language — the what and why, user impact, reproduction notes for bugs, and any reference needed to understand the request.

The Backlog panel reads item status from each item file's **frontmatter** under `backlog/`, so keeping it current is part of the work, not optional bookkeeping. Whenever the real state of your work changes, call `backlog.update` for its `status` in the same step:

- **Starting**: set `in_progress` before role-specific work begins.
- **Blocked on the user**: set `needs_input` the moment you stop to wait for a decision, missing information, or help only a human can provide — and state the specific question in your reply. A `needs_input` status with no stated question is incomplete.
- **Resuming**: set `in_progress` again once unblocked.
- **Finished**: set `completed` only when the work is genuinely complete and verified. Never for partial work.
- **Stopping incomplete**: leave the item `in_progress` and report the remaining work — never let it silently look finished or abandoned.

Creating an item needs no tool: write the markdown file under `backlog/` yourself, with only grounded frontmatter fields and no `id:` or `updated:` line — the app allocates the id on its next scan. For lifecycle and triage mutations on existing items, prefer the SprintEngine Studio MCP tools (`backlog.update`, `backlog.assign`, `backlog.work`): they validate schema, preserve omitted fields, and stamp exact timestamps — never supply `updated`. The tools target the project your agent connection was launched from; pass `projectRoot` only for a different folder. If the Studio MCP is unavailable, edit the frontmatter directly with the same vocabulary and delete the `updated:` line rather than inventing a timestamp. `.multi-code/backlog/items.json` stays app-owned; never edit it.

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
- `dependsOn`: prerequisite items as one flat comma-separated scalar of file-name-stem slugs (same identifier scheme as `epic:`), e.g. `dependsOn: a-item, b-item`. Only the dependent stores the edge; the app derives blocked/waiting presentation — never write `blocked` as a status. Not covered by `backlog.update`; set it when authoring the file or edit the frontmatter line directly.
- `mockups`: attached mockups as one flat comma-separated scalar of project-relative, comma-free paths (canonical home `backlog/mockups/`). Absolute paths and `..` escapes are invalid. Also outside `backlog.update`; edit the file directly.
- `updated`: the exact UTC instant of the last real content/frontmatter change; full ISO-8601 date-time with seconds, never date-only. Tool mutations stamp it; omit it from files you author.

Set an axis only when the current context supports a grounded estimate; leave it unset instead of guessing. Difficulty is normally architect-owned. Criticality follows user or product intent; if you infer it, be conservative and let the user override.

Mutate lifecycle and triage only with `backlog.update`, passing the project-relative path and only fields that truly change. It preserves omitted fields and the body and stamps the update time. Legacy aliases remain readable inputs, but new tool mutations use the canonical fields. Never edit `items.json` or compute ids.

## Epics

An epic groups related items. It is itself a file at `backlog/epics/<slug>.md` with `type: epic`; `<slug>` is the filename stem and its title is the first `# Heading`. Membership is **stored up, derived down** — the only stored relationship is each child's `epic:` field:

- **Assign/remove**: update the child's `epic` through `backlog.update`.
- **Create**: write `backlog/epics/<slug>.md` with `type: epic` frontmatter and a `# Title` heading, then assign members through `backlog.update`.
- **Enumerate children**: `grep -l "^epic: <slug>$" backlog/*.md`.
- **Completion**: an epic is `completed` only when every one of its children is `completed`.

When authoring an epic's children, prefer items sized for one agent in one session and, where practical, within one discipline (frontend / backend / main-process / engine), so a sprint architect can route each child to one task without re-slicing. Work that genuinely spans disciplines is either split into sibling children linked in prose, or states its seam — the contract between the halves — so an architect splitting it has the contract handed to them. Keep acceptance criteria self-contained per child: a criterion only verifiable by another child's work belongs on that other child. Every item that changes UI carries a mockup under `backlog/mockups/` (owner rule, 2026-07-26): author it against the design-system tokens, reference it from the item as "build to it", and never leave the reference dangling — a UI item without its mockup is not `ready`. UI must be self-evident (owner rule, same day): no captions or helper copy explaining what a control is or why it exists — if a control needs a sentence, redesign the control.

## Working A Dropped Backlog Item

When a user drags a `backlog/...` item into a terminal and asks you to work it directly, treat the dragged file as the intake brief:

1. Confirm the path is under `backlog/`, read the item, and derive the project-root-relative source path, for example `backlog/example.md`.
2. Call `backlog.update` with `status: in_progress` before role-specific work begins; the server stamps the exact time and preserves the body.
3. Mark it `needs_input` (with the blocking question stated in your reply) whenever you stop to wait on the user, `in_progress` again on resume, and `completed` only once the real work is complete and verified. Stopping incomplete for any other reason leaves it `in_progress` with the remaining work reported.

## Recording The Working Agent

For a typed pickup not already linked by drag/drop or `backlog.work`, call `backlog.assign` with the item path and the real `MULTICODE_AGENT_ID`, using `MULTICODE_AGENT_NAME` as its label when present. Never invent identity; skip attribution when no agent id is exposed. The app owns the object-store link and timestamp.

</supporting-info>
