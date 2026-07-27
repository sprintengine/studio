# Sprint Engine Schema

Sprint Engine is Multicode's local execution authority for specialist runs.
Current runs use a folder-backed store under `.multi-code/sprintengine/<team>/`.
The folder store and normalized projection are the durable read contract.

Agents and app code must not hand-edit Sprint Engine store files. Mutations go
through the Sprint Engine CLI/tool boundary so locking, ready queue refresh,
activity, artifacts, events, metrics, and projections stay coherent.

## Run Store Layout

Each team folder contains these store files and directories:

```text
.multi-code/sprintengine/<team>/
  run.yaml
  projection.json
  events.jsonl
  dispatch.jsonl
  metrics/agent-feedback.jsonl
  tasks/
    todo/
    ready/
    in_progress/
    review/
    needs_input/
    done/
    canceled/
  artifacts/
    draft/
    recorded/
    ready_for_review/
    approved/
    changes_requested/
    superseded/
  reviews/
  validation/
  runner/
```

Folder-store files are not safe manual editing surfaces. Human/debug/headless
operators can use commands such as `sprintengine join`,
`sprintengine task next`, `sprintengine task log`, `sprintengine task status`,
`sprintengine artifact add`, and `sprintengine runner set`. Multicode-launched
autonomous agents use the managed Sprint Engine MCP server instead of CLI
commands.

## `run.yaml`

`run.yaml` stores compact run metadata and graph mirrors:

- `schemaVersion`: folder-store schema version, currently `3`
  (`store.RUN_SCHEMA_VERSION`). See "Store Version Rejection" below.
- `name`: team display name.
- `goal`: run goal.
- `status`: run status such as `planning` or `executing`.
- `rosterConfigured`: whether the run has an explicit role roster.
- `graphPolicy`: graph/readiness policy metadata.
- `rosterPolicy`: durable worker-assignment policy
  (`{"workerAssignment": "per_task"}`; an absent policy reads as `per_task`).
  Retained as a run-config field; under leases (v3) the live invariant is "a
  worker holds at most one **active lease**", enforced on the task record, not a
  seat count. See "Task Leases" below.
- `defaultPhases`: the ordered post-implementation phases every task inherits,
  and the ceiling a per-task `phases` list must be a subset of. Written once at
  init from `--default-phases-json`; absent means the engine default
  (`["review"]`). `[]` is valid and recorded.
- `tasks`: compact task graph entries with `id`, `status`, `role`, and
  `dependsOn`. Each graph entry also carries `needsTriage`, defaulting to
  `false` when absent.
- `artifacts`: compact artifact entries with `id`, `status`, `kind`, and
  `taskId`.
- `runner`: durable runner policy (`cliWatchPolling: enabled | disabled`) plus
  polling and completion settings. Legacy `mode: auto | off` is still read.
- There is **no `agents` map** (v3, MC-1591). Membership is `configuredRoles` and
  assignment is a **lease on the task record**; `sync_run_yaml_from_state` strips
  any legacy `agents` key on write and `state_from_folder_store` reconstructs
  none. The live "who is doing what" view is derived from task leases into
  `projection.workers` (and a `projection.roster` bridge). See "Task Leases".
- `roles`, `roleRuntimes`: the run's role metadata and per-role `{model, cli}`
  execution runtime map.
- `configuredRoles`: the run's enabled role set — the roles a task may be tagged
  with, enforced by `plan.add_task`. Absent when the run recorded none.
- `creation`: run creation metadata such as source and timestamp.
- `source`: the root seed document recorded at run creation (`kind`, `origin`,
  `path`, optional `planKind`/`originalPath`/`capturedAt`). Present only when the
  run was seeded from a doc.
- `sourceBundle`: attached reference seed documents, each with `kind`, `origin`,
  `path`, and optional `originalPath`/`capturedAt`. Present only when references
  were attached.
- `updatedAt`: UTC timestamp of the latest store sync.

The graph mirror lets readiness refresh validate dependency references and
cycles without requiring consumers to parse every task folder.

`source` and `sourceBundle` round-trip through `run.yaml` and are re-emitted on
the normalized projection's `run` payload (alongside `roleRuntimes` and
`configuredRoles`), omitted cleanly when absent, so the renderer can surface the
seed docs a run started from.

`defaultPhases` (`RUN_PHASE_KEYS`) round-trips through `run.yaml` and re-emits on
`projection.run` the same way, omitted when absent. The retired `requiredSweeps`
key (removed with the sweep concept, MC-1825) and the retired `rosterSource` /
`allowedRuntimes` keys (removed with the architect-picks-the-team formation,
MC-1889) do neither: an older `run.yaml` may still carry them, and the engine
ignores them.

### Store Version Rejection

`RUN_SCHEMA_VERSION` is `4` (v2 = MC-1542 single-owner; v3 = MC-1591 leases
replace the roster; v4 = MC-1611 a run declares a list of repos). Any store
below the current version is **rejected, never migrated**: its status enum, its
per-task quality requirements, and its role manifests are all incompatible — as
are, pre-v3, its persistent `agents` map, and pre-v4, its single repo described
by fields this build no longer writes.

`assert_store_is_current` (`sprintengine_core/store.py`) is the one function both
`state_from_folder_store` and `build_projection` call; it raises
`RunStoreVersionError` naming the team directory to delete. The projection also
carries `run.schemaVersion`, so the app can reject a stale `projection.json`
without invoking Python — `describeUnsupportedSprintEngineStore`
(`src/main/sprintengine-artifacts.ts`, mirror constant
`SPRINT_ENGINE_RUN_SCHEMA_VERSION = 4`) guards every surface that reads one. The
remedy is deleting `.multi-code/sprintengine/<team>/` and re-running the sprint.

## Role Registry Boundary

Sprint Engine roles are registry-backed. Tasks store role ids as strings, and
active CLI/MCP validation resolves those ids through
`sprintengine_core.role_registry` and the role helper layer in
`sprintengine_core/tool/roles.py`. The registry discovers role manifests and
skill documents from workspace, plugin, user, and bundled sources. Aliases
resolve to canonical ids before task, roster, join, and plan operations mutate
state.

The bundled-role compatibility set and renderer label/accent defaults are not
runtime dispatch authority. They exist for older callers, specialist UI
defaults, and graceful display fallbacks. Registry metadata in projection and
MCP discovery is the path for custom role labels, descriptions, icons, aliases,
source layers, and warnings.

A role is routing plus directive packs. The manifest schema is:

```json
{
  "id": "frontend",
  "label": "Frontend engineer",
  "aliases": ["front-end", "ui"],
  "description": "Builds user-facing screens and components. Staff this role when the run changes what the user sees.",
  "directives": {
    "implement": [{ "skill": "frontend" }],
    "review": [{ "skill": "frontend_review" }]
  }
}
```

- `directives` is required. `directives.implement` is a required, non-empty
  ordered list of `{ "skill": "<id>" }` entries composed into the role's startup
  brief. Entries carry a `skill` key and nothing else; inline text entries are
  rejected.
- Any other `directives` key must name a shipped phase. The shipped phase
  vocabulary is `review` only (`DIRECTIVE_PHASES`); an unknown key rejects the
  manifest, so a typo never silently drops a directive pack.
  `directives.review` entries are appended after the shared base review pack.
- `description` is the role's whole capability statement, in natural language:
  what the role does and when a sprint should staff it. The architect's join
  prompt renders each staffed role's description verbatim; nothing in the engine
  derives behaviour from its text, and there are no capability flags. Write one
  for every role. It is schema-optional only so a manifest predating the field
  still loads.
- `icon` is an optional string.
- The removed keys `soul` and `capabilities` are rejected **by name**
  (`REMOVED_MANIFEST_KEYS`). A manifest carrying either is skipped with a
  `v1_role_manifest` registry warning naming its replacement. There is no
  compatibility shim and no runtime migration.
- `summary`, the one-line predecessor of `description`, is **renamed, not
  removed** (`RENAMED_MANIFEST_KEYS`): the manifest still loads so an installed
  pack keeps staffing runs, the key is ignored, and discovery emits a
  `renamed_manifest_key` warning. Its value is never read as `description`.

Prompt composition is layered:

1. The startup brief: `directives.implement` skills, plus host-supplied layer
   skills (`render_soul`, `extra_skills`).
2. Sprint Engine coordination rules selected by the dispatch kind.
3. Runtime directive from the MCP lifecycle tools or the active task
   payload.

Phase directives are **not** composed at startup. They are composed on demand by
`build_phase_directive` (`sprintengine_core/tool/phase_prompts.py`) and delivered
inline in the owner's `task.publish` / `task.advance` tool response — or, for an
owner revived mid-phase, in the `build_phase_respawn_brief` startup brief. Those
are the only two channels.

### Task Leases

There is no persistent `agents` map. Assignment is a **lease minted on the task
record at claim** (`mint_lease`, `sprintengine_core/tool/state.py`), the sole
authority for claim, seat, and capacity decisions. The lease is stored under the
task's `lease` key:

- `workerId`: the worker id holding the lease. `ownerAgentId` on the task is its
  denormalized copy, kept in lockstep for every consumer that reads it.
- `role`: the role recorded at claim.
- `heartbeatAt`: UTC timestamp refreshed at every ownership event and by
  `sprintengine.agent.heartbeat`; the expiry sweep measures liveness from it.
- `since`: UTC timestamp the current worker took the lease.
- `sessionId`: optional CLI session id, present when recorded.

A lease is active while the task status is in `ACTIVE_TASK_STATUSES`
(`in_progress`, `review`, `needs_input`) and ends at `done`/`canceled` or on
release to the queue (`end_lease`). `active_lease_worker` returns the active
holder, falling back to `ownerAgentId` for records predating the field.

Invariants (`tests/sprintengine_tool/test_lease_claim_property.py`):

- **Atomic claim.** `runner/claim.queue.lock` serializes the mint, so concurrent
  claimers never double-assign a task.
- **≤1 active lease per worker.** `worker_has_active_lease` (the replacement for
  the deleted `task_claim_exceeds_worker_capacity` / `ownedTaskIds` cap) refuses
  a second claim; a re-claim of the worker's own task (rework) is allowed. A
  worker whose task is `done` holds none and may claim again — the deleted
  per-task-for-life rule.
- **Same-worker re-mint preserves `since`/`sessionId`; a different worker resets
  both**, so a successor never inherits the prior owner's session or token
  attribution.
- **Expiry / leave release only `in_progress` leases.** `release_agent_targets`
  (shared by MCP `agent.leave` and the 300s headless sweep
  `release_expired_agent_targets`, `agent_liveness_timeout_seconds`) frees an
  `in_progress` lease back to `todo`; a `review` or `needs_input` lease stays
  bound to its worker id, revived under the same id with a phase brief.

The live "who is doing what" view is derived from task leases, never stored:
`derive_worker_views(tasks, dispatches)` (`sprintengine_core/store.py`) builds
`projection.workers` (keyed by worker id) and the `projection.roster` bridge in
one pass, so the two shapes cannot drift. Each worker view carries `role`, a
derived `status` (`idle`/`running`/`needs_input`), `currentTaskId`,
`lastOwnedTaskId`, a derived `ownedTaskIds` list, `currentDispatch` (rebuilt from
the `dispatch.jsonl` ledger), and — when present on the lease — `sessionId`,
`since`, and `heartbeatAt`. `worker_view(state, id)` is the single-worker echo
that `agent.join`/`task.next`/`task.claim` return (a fresh joiner with no lease
→ `null`).

`currentDispatch` (on a worker view) records `dispatchId`, `targetKind` (`task`),
`taskId`, `role`, `reason` (e.g. `task_claimed`, `agent_expired_release`), and
`assignedAt`. Unclaimed ready tasks are wake candidates and are never
represented as `currentDispatch` assignments.

Agents and app code must not edit task records directly. Use the lifecycle tools
so store locks, leases, task ownership, events, projection sync, and dispatch
ledger writes remain coherent.

## Dispatch Ledger

`dispatch.jsonl` is an append-only sibling of `events.jsonl` — durable dispatch
telemetry with an idempotency key, surfaced as `projection.dispatches`. MC-1591
deleted the per-agent dispatch **cursor** surface (`sprintengine.dispatch.next` /
`sprintengine.dispatch.ack` / `sprintengine.subscribe`, plus the per-agent
`subscription`, `currentDispatch`, and `dispatchCursors` state): leases on the
task record are the assignment authority, so there is no cursor to replay. A
worker's `currentDispatch` is now *reconstructed* from this ledger by
`derive_worker_views` (`sprintengine_core/store.py`), never persisted per agent.
Consumers read Sprint Engine tools or projection fields, never the file directly.

Durable dispatch records are created for claimed tasks, re-engagement directed
back to the task owner, and expiry re-queues. Renderer prompts for unclaimed
ready tasks are wake candidates only: they may wake an available live agent to
call the direct claim tool, but they do not append `dispatch.jsonl` or mutate
canonical task state before the claim tool claims.

Each line is a JSON object with:

- `id`: stable dispatch id derived from the target and assignment context.
  Replaying, reconnecting, or re-notifying the same assignment reuses this id
  and must not double-assign work.
- `timestamp`: UTC timestamp for the ledger entry.
- `agentId`: target agent id.
- `role`: canonical role requested by the target.
- `target`: object with `kind` (`task`) and `taskId`.
- `reason`: why the scheduler selected the target.
- `state`: snapshot fields needed for idempotency, currently `taskStatus`.
- `outcome`: currently `dispatched` for assignment records; future terminal
  records may use values such as `acknowledged`, `canceled`, `released`, or
  `superseded`.
- `source`: currently `core` for assignments produced by the shared
  Sprint Engine core path. Future transports may identify `mcp`, `cli_compat`,
  or `system`.

There is no MCP read contract for this ledger — the deleted `dispatch.next` /
`dispatch.ack` / `subscribe` tools were its cursor surface. Headless watch is
re-expressed as a `task.next` poll loop (which also runs the expiry sweep on each
poll); an agent learns its assignment from the `currentDispatch` reconstructed on
its worker view and from `task.next` resume. `sprintengine.agent.heartbeat`
answers the pure-liveness ack `{ok, known}` and never conveys assignment state.
The `run.subscribe` run-event stream is unaffected — it is the run-level history
feed, not a per-agent dispatch cursor.

Dispatch is durable telemetry, not a guarantee that a model session woke up.
Multicode remains responsible for spawning, focusing, or injecting terminal
input for current CLIs. Correctness comes from reconciling task leases and
dispatch ids, not from a notification arriving.

## MCP Tool Contract

The final MCP v1 surface is schema-first in `sprintengine_mcp/schemas.py`.
Lifecycle, discovery, task, artifact, plan, run, and support operations all use
structured JSON schemas. Final contract schemas are exposed separately from the
active `TOOL_SCHEMAS` registry so `list_tools` advertises only operations with
server handlers (`ACTIVE_TOOL_NAMES`, `sprintengine_mcp/tool_contracts.py`).
Future names move into active `TOOL_SCHEMAS` when their handlers land.

Lifecycle names (MC-1591 deleted the per-agent dispatch cursor tools
`sprintengine.dispatch.next` / `sprintengine.dispatch.ack` / the bare
`sprintengine.subscribe`; a call to any of them is now an unknown tool):

- `sprintengine.agent.join`
- `sprintengine.agent.heartbeat`
- `sprintengine.agent.leave`

Discovery names:

- `sprintengine.roles.list`
- `sprintengine.roles.get`
- `sprintengine.soul.get`
- `sprintengine.skills.list`
- `sprintengine.skill.get`

Active operation names:

- Tasks: `sprintengine.task.get`, `sprintengine.task.list`,
  `sprintengine.task.next`, `sprintengine.task.claim`,
  `sprintengine.task.status`, `sprintengine.task.resolve_input`,
  `sprintengine.task.release`,
  `sprintengine.task.log`, `sprintengine.task.note`,
  `sprintengine.task.comment`, `sprintengine.task.comment.list`,
  `sprintengine.task.publish`, `sprintengine.task.advance`.
  `sprintengine.task.publish` is the only tool that enters a task's phase walk;
  `sprintengine.task.advance` is the only tool that walks it. Routed blockers use
  `sprintengine.task.status` with `status: needs_input`, or `task.advance` with
  `outcome: "escalate"` mid-phase.
- Artifacts: `sprintengine.artifact.add`, `sprintengine.artifact.ready`,
  `sprintengine.artifact.approve`, `sprintengine.artifact.request_changes`,
  `sprintengine.artifact.list`.
- Plans: `sprintengine.plan.add_task`, `sprintengine.plan.update_task`,
  `sprintengine.plan.delete_task`, `sprintengine.plan.add_dependency`,
  `sprintengine.plan.remove_dependency`.
- Run: `sprintengine.run.get`, `sprintengine.run.policy.get`,
  `sprintengine.run.subscribe`. The run projection is deliberately not an MCP
  tool: it exists for the UI, which reads `projection.json` from disk, and
  over MCP it returned more tokens than an agent context window. The CLI
  `projection` command is unaffected.
- Roster: none. MC-1591 deleted the membership ops (`roster.add` /
  `roster.retire` / `roster.replenish` / `roster.list`) and MC-1889 deleted
  `roster.configure` with the "Architect picks the team" formation it served — a
  call to any of them is an unknown tool for every role. The operator `roster
  runtime` and `roster enable` edits are CLI/IPC-only, never MCP tools.
- Support: `sprintengine.init`, `sprintengine.recover`, `sprintengine.summary`,
  feedback tools, and `sprintengine.health`.

The operator counterpart is CLI-only `sprintengine roster runtime --role --cli
[--model] --actor ui` (MC-1516, the app-owned mid-run role runtime edit): it
merges the one role into `roleRuntimes` in a locked transaction and appends a
`role_runtime_changed` event (`{role, cli, model, previous}`). It is not an MCP
tool and none of validations (1)–(3)/(5) apply — the role must only resolve in
the registry and be in `configuredRoles` when that set exists
(`role_not_enabled_for_run`).

### `sprintengine.task.advance`

```json
{
  "taskId": "T3",
  "id": "developer-1",
  "phase": "review",
  "outcome": "pass_with_fixes",
  "summary": "Fixed a silent parse fallback and added the missing regression test.",
  "findingJson": [{ "kind": "code_bug", "severity": "high", "area": "cli", "title": "Silent parse fallback" }]
}
```

Required: `taskId`, `id`, `phase`, `outcome`, `summary`. The tool is **owner-only**
(`not_task_owner`) and `phase` must equal the task's current status
(`phase_mismatch`). `phase` is enum-checked against `VALID_TASK_PHASES`
(`["review"]`) and `outcome` against `VALID_PHASE_OUTCOMES`
(`pass`, `pass_with_fixes`, `escalate`).

`escalate` additionally requires `needsInputQuestion`; it accepts
`needsInputKind`, `needsInputReason`, and `needsInputSuggestedResolution`, moves
the task to `needs_input`, and records `needsInput.originatingStatus` so
resolution returns the task to that phase.

`pass`/`pass_with_fixes` step to the next phase, or to `done` when none remains.
When a next phase exists, its composed directive rides the response as
`nextDirective` (as it does on `task.publish`).

`findingJson` and the other feedback properties are optional categorical
telemetry, validated best-effort: an invalid optional sub-field is dropped with a
`feedbackWarnings` entry rather than rejecting the transition.

### Task `phases`

`sprintengine.plan.add_task` and `sprintengine.plan.update_task` accept
`phases: string[]` (`PHASES_PROPERTY`), each item enum-checked against
`VALID_TASK_PHASES`. Omit it to inherit the run's `defaultPhases`; pass `[]` for
none (publish routes straight to `done`). It must be a subset of the run's list —
a phase outside it is rejected with `phase_not_configured_for_run`. Over the CLI
the same flag is a comma-separated string, where `--phases ""` is the explicit
empty list.

MCP response contract (`sprintengine_mcp/response_shapes.py`): MCP responses
carry deltas and references, not state echoes — the run store stays the source
of truth and the UI keeps reading it from disk. Mutation tools (`task.log`,
`task.publish`, `task.advance`, `task.status`, `plan.add_task`, artifact
review, and the rest of `MUTATION_ACK_TOOLS`) return acks with `taskId`,
`taskStatus`, the event, and any progression/continuation fields instead of
the full task. `nextDirective` rides the `publish`/`advance` ack unchanged — the
phase directive must reach the live owner. Acks include an `openFeedback` delta
(newest open feedback and user notes, newest first) so a working agent still
notices comments posted mid-task. Read tools (`task.next`, `task.claim`,
`task.get`) return a slim task card without `activity`, full `comments`,
full `notes`, full `needsInput.resolution`,
`evidence.commandsRan`/`results`, or `evidence.diffs`; default cards include
only bounded newest notes and bounded needs-input prose. `task.get` accepts
`include: ["activity", "comments", "evidence_log", "diffs", "notes",
"needs_input"]` for deep reads.
Directives carry `{id, title, status, role}` stubs. Server-composed phase and
rework prompts are built from full store state, and since item 1566 they
reference — never re-list — content the same response already carries: the
rework prompt names the open-feedback count and points at the card's
`openFeedback`; the phase directive points at the card's acceptance criteria
and the ack's `openFeedback` delta. The respawn brief (the one cold-start
payload) re-lists the card including acceptance criteria, with capped evidence
tails and diff line counts (`RESPAWN_*` limits,
`sprintengine_core/tool/phase_prompts.py`) and explicit elision markers. The
human/debug CLI keeps full command output shapes. Response-shape regression
tests live in `tests/sprintengine_tool/test_response_shapes.py`.

Role capability policy (`sprintengine_mcp/capabilities.py`): one role→tool
table is consumed by both sides of the contract — `tools/list` filters the
advertised schemas by the session's role, and every call is checked against
the same table, failing with `tool_not_permitted_for_role` (naming the role
and, where known, the permitted alternative) when a hidden tool is called by
name. Classification derives from the role registry, not hardcoded ids, so
plugin roles participate. There are four classifications:

- `operator` — `role: "user"` or no role: the app's IPC actor, the human/debug
  CLI, and stdio sessions. Full surface.
- `architect` — the registry-normalized `architect` id: `AGENT_COMMON_TOOLS` plus
  the planning surface (`PLANNING_TOOLS`).
- `general` — the manifest-less `general` identity, recognised by id: identical
  to `architect` (`AGENT_COMMON_TOOLS` + `PLANNING_TOOLS`). MC-1591 deleted the
  roster-growth tools (`ROSTER_GROWTH_TOOLS` is gone with the roster), and those
  were the only difference, so the two classifications converge. A General still
  cannot expand the team — no membership op exists for anyone.
- `owner` — every other resolvable role, and the conservative fallback for a role
  the registry cannot resolve. `AGENT_COMMON_TOOLS` only.

A reviewer role is an `owner` like any other worker: same tools, same lifecycle.
It claims its own task, fixes what it finds, and closes its phases with
`task.advance`. `task.publish` and `task.advance` are the whole lifecycle surface
in `AGENT_COMMON_TOOLS`; there is no separate reviewer tool set.
`artifact.request_changes` is a planner/operator tool (`PLANNING_TOOLS`): the
human Inbox loop and the architect adjudicate artifacts, and it is not a rework
channel back onto a task.

The session role comes from agent-scoped HTTP run registrations: the
app registers each agent terminal with `agentId` + `role`
(`src/main/sprintengine-mcp-hub.ts` → `POST /runs`), and the returned token
binds that terminal's MCP session to the role. Registrations without
`agentId`/`role` stay run-scoped (operator surface), which keeps older
callers working. Capability tests live in
`tests/sprintengine_tool/test_capabilities.py`.

Compatibility names:

- `sprintengine.join` remains a compatibility alias for the agent join
  behavior, used by the one-shot `sprintengine join` operator command. It must
  keep the current CLI response shape while sharing lifecycle state with
  `sprintengine.agent.join`. It is operator-only under the capability policy:
  autonomous agents never see it. Managed Multicode prompt flows use
  `sprintengine.agent.join` followed by the direct claim tool named in the
  runtime prompt. `sprintengine.agent.next_directive` and the `--watch` polling
  loop it adapted were deleted (MC-1827).
- CLI wrapper flows still use `sprintengine.task.next`,
  `sprintengine.task.claim`, `sprintengine.task.note`,
  `sprintengine.task.resolve_input`, `sprintengine.task.release`,
  `sprintengine.task.publish`, and `sprintengine.task.advance` while preserving
  the same core mutation path.

Transition tests must prove that `sprintengine.join` does not duplicate
dispatch ledger entries, returns active work before claiming new work, records
or refreshes the same agent lifecycle fields as the final join path, treats
unclaimed ready tasks as wake candidates until claim time, and returns idle
without mutation when no target is available.

## Task Files

Task JSON files live under `tasks/<folder-status>/`. Folder location is the
materialized board column; the embedded `status` field mirrors that folder for
display and validation. Columns and claimability are distinct:

- Folder/status columns show where the task sits on the board.
- Claimability is computed from dependencies, ownership, `needsTriage`, and
  status. Only a `todo` task is claimable.

A task in `tasks/ready/` can include `stateStatus` to show the semantic status,
which is always `todo`.

Supported task folders are:

- `todo`
- `ready`
- `in_progress`
- `review`
- `needs_input`
- `done`
- `canceled`

`ready` is the materialized queue, not a semantic status. The semantic task
statuses (`VALID_TASK_STATUSES`, `sprintengine_core/tool/constants.py`) are
`todo`, `in_progress`, `review`, `needs_input`, `done`, and `canceled`. A task in
`review` is still owned by the agent that implemented it
(`ACTIVE_TASK_STATUSES = {in_progress, review, needs_input}`).

Task records preserve the existing task card fields:

- `id`, `title`, `description`, `role`
- `status`, `stateStatus`, `ownerAgentId`
- `dependsOn`
- `ownedPaths`
- `acceptanceCriteria`
- `implementationNotes`
- `evidence`
- `notes`
- `comments`
- `phases`
- `needsTriage`
- `needsInput`
- `feedback`
- `difficulty`
- `model`, `cli`: the CLI/model that worked the task, stamped at claim and
  retained through handoff.
- `lastImplementedByAgentId`, `lastPublishedAt`
- `productFacing`, `producesImplementation` (optional booleans)
- `kind` (optional; only value: `integration_review`): charter marker for the
  terminal task that proves the run's pieces work together — build, run the
  app, exercise the seams between tasks. It is a marker, not machinery: the
  task claims, publishes, and completes like any other. Plan approval warns
  (`integrationWarnings`, never blocks) when implementation work is not
  transitively covered by an integration task, and `plan add-task` warns when
  implementation lands after the integration task already completed. Absent
  means ordinary work; `work` normalizes to absent.
- `startedAt`, `completedAt`
- `activity`

`phases` is the task's ordered list of post-implementation phases. It is optional:
absent means "inherit the run's `defaultPhases`" (which is how a task written
before the field existed reads), and `[]` is an explicit "no phases" — publish
routes it straight to `done`. Each entry must be in `VALID_TASK_PHASES`, and the
list must be a subset of the run's `defaultPhases`
(`phase_not_configured_for_run`). `resolve_task_phases`
(`sprintengine_core/tool/tasks.py`) is the resolver both `publish_task` and
`advance_task` read.

`difficulty` is optional so old task records do not require migration. Task-local
state uses existing camelCase conventions:

- `architectEstimatePct`, `architectEstimateReason`
- `implementerActualPct`, `implementerActualReason`
- `reviewerAssessments`: append-only entries with `pct`, `dimension`, `reason`,
  `reviewerAgentId`, `reviewerRole`, `phase`, and `capturedAt`. Preserved on read
  and in the feedback difficulty snapshot; no current command writes them.

Difficulty percentages must be integer values from `0` to `100`; booleans are
invalid. Reviewer assessment `dimension` must be one of `implementation`,
`review`, `verification`, `product_spec`, `security`, `performance`, or
`coordination`.

`ownedPaths`, evidence files, artifact paths, review paths, and notes must use
project-root-relative paths. Do not write absolute paths or machine-specific
paths into task records or evidence.

## Role Registry And Routing

Task roles and roster roles are configured data. CLI role
arguments are parsed as strings and then canonicalized through the role registry,
including aliases and hyphen/underscore variants supported by the registry.
Unknown roles are rejected at command boundaries once the registry can prove they
are unknown.

Task dispatch routes by exact canonical `task.role`. When the run records a
`configuredRoles` set, `plan.add_task` requires the task's role to be in it. The
core does not infer routing from role metadata at all: a manifest carries no
capability or review flags, so the architect reads the role's natural-language
`description` when deciding what to task it with. Each staffed role's
description is rendered verbatim into the architect's join prompt under
**Roles On This Run**.

Plan reviews use registry-backed non-architect role ids from the active roster
instead of a static reviewer-role list. Built-in roles can still have
role-specific prompt focus or artifact labels, but custom configured roles use
the generic specialist review focus and remain claimable.

## Activity Timeline

`activity` is the task-local handoff timeline. Entries are structured objects
with an `id`, UTC `timestamp`, `type`, `actor`, `message`, and optional
task-specific metadata.

Known activity types include:

- `claim`
- `status_change`
- `comment`
- `evidence`
- `feedback`
- `needs_input`
- `artifact`
- `system`

Projection consumers should use activity as the inspector timeline and display
newest activity first.

## Evidence And Feedback

Task `evidence` contains:

- `summary`
- `touchedFiles`
- `commandsRan`
- `results`
- `scopeExpansions`

`scopeExpansions` records project-relative paths outside the task's owned paths,
with `path`, `reason`, and optional `risk`.

## The Phase Walk

One agent owns a task from claim to `done`. It implements, publishes, then
reviews its own diff in the same session. There is no separate reviewer, no
claimable review queue, and no route backward through the board.

**Enter the walk — `publish_task`** (`sprintengine_core/tool/tasks.py`). Publish
records an `implementation_summary` comment (or an `implementation_response` when
the task carries open feedback), then routes in two steps:

1. **Change detection** (`task_produced_changes`). In worktree mode, a task with
   any task-scoped commit produced a diff. Outside worktree mode, the working tree
   is inspected, scoped to the task's owned and declared paths. If the answer
   cannot be determined at all (no git repository), the answer is `True` — routing
   to review is the failure-safe direction. This is the task's cumulative output,
   not "since the last publish".
2. **Routing.** No changes → every phase is skipped and the task lands on `done`,
   `completedAt` stamped, owner cleared. Changes → the task advances to
   `phases[0]` (or `done` when the task has no phases) and **keeps its owner**.

The publish response carries `nextStatus`, `previousStatus`, `producedChanges`,
`phases`, and — when the task entered a phase — the composed `nextDirective`.

**Walk it — `advance_task`.** `sprintengine.task.advance` is the only mutation
that moves a task between phases; no comment, log, artifact, or status call may
move it forward. It is owner-only, and its `phase` argument must equal the task's
current status.

- `pass` / `pass_with_fixes` step to the phase after this one in the task's list,
  or to `done` when none remains. A `nextDirective` rides the response when a next
  phase exists.
- `escalate` moves the task to `needs_input` and records
  `needsInput.originatingStatus`. `task resolve-input` returns the task to that
  phase, not to `in_progress` (`resolve_task_input`,
  `sprintengine_core/tool/artifacts.py`).

Invariants:

- The walk is strictly forward. A phase is visited at most once per walk; fixes
  made during a phase are smoke-checked in place, never re-reviewed by re-entering
  it.
- A re-publish restarts the walk from `phases[0]`, re-running change detection.
- A task in `review` stays owned. `release_agent_targets`
  (`sprintengine_core/tool/state.py`) releases only `in_progress` tasks back to
  `todo`; `review` and `needs_input` tasks keep their `ownerAgentId` across a
  leave or an expiry sweep, and the owner is revived under the same id with a
  phase brief (`build_phase_respawn_brief`).

Phase directives are composed by `build_phase_directive`
(`sprintengine_core/tool/phase_prompts.py`) from the phase header, the shared base
pack (`resources/sprintengine/skills/sprintengine_phase_review/SKILL.md`, resolved
through the registry so a workspace layer can shadow it), the role's
`directives.<phase>` additions, the task's acceptance criteria, and any open
feedback comments.

Rework arrives from the human Inbox, not from another agent. `artifact
request-changes` records the feedback as a typed comment and reopens the linked
task (`reopen_task_for_artifact_changes`): to `in_progress` when the owner is
still active on it, otherwise to unowned `todo`. Moving an unowned task back to
`in_progress` re-binds it to `lastImplementedByAgentId`; a task with no
implementer on record returns to `todo` rather than becoming unclaimable
(`cmd_task_status`).

## Task Comments

Task comments are the human-readable handoff stream. Typed comments include:

- `implementation_summary`
- `implementation_response`
- `review_feedback`
- `test_feedback`
- `product_feedback`
- `architect_feedback`
- `needs_input`
- `user_note`
- `system_note`

New structured comments include `id`, `type`, `actor`, `authorAgentId`,
`authorRole`, `source`, `body`, `createdAt`, optional `paths`, and optional
structured `data`. `task publish` creates implementation summary/response
comments. `task advance` creates an `implementation_summary` comment carrying
`data.phase` and `data.outcome`, or a `needs_input` comment on `escalate`.
Artifact request-changes creates feedback comments. Open feedback comments use
`data.status = "open"` and should be surfaced newest first for rework.

Agent feedback is attached to task records and also exported to
`metrics/agent-feedback.jsonl`. Metrics records use JSON Lines so each feedback
payload is append-friendly and durable across syncs.

`build_feedback_payload` (`sprintengine_core/tool/feedback.py`) classifies each
record by `source`:

- `phase_advance_self_review` — written when `task advance` supplies feedback
  fields. A phase advance is the owner reporting on its own work, so it is a
  self-report; the record carries `phase` and `phase_outcome`, and the task-local
  payload carries a `phase: {phase, outcome}` object.
- `reviewer_assessment` — an agent assessing a different task (the
  `--review-target-*` trio), as a planned review task does.
- `agent_self_report` — everything else.

Findings and issues on the phase-advance path are validated best-effort
(`best_effort=True`): an invalid optional sub-field is dropped with a
`feedbackWarnings` entry rather than rejecting the operational transition.

When a task has difficulty metadata and feedback is recorded, feedback metrics
include a `difficulty` snapshot using snake_case analytics keys:

- `architect_estimate_pct`, `architect_estimate_reason`
- `implementer_actual_pct`, `implementer_actual_reason`
- `reviewer_assessments`: assessment entries with `pct`, `dimension`, `reason`,
  `reviewer_agent_id`, `reviewer_role`, `phase`, and `captured_at`

### Feedback Analysis (`sprintengine.feedback.summarize`)

`sprintengine.feedback.summarize` (`sprintengine_core/analysis.py`) reads
`metrics/agent-feedback.jsonl` and returns a sanitized `summary` of aggregate
signals only (no raw prompts, transcripts, or artifact bodies). In addition to
the per-role aggregates (`aggregateScoresByRole`, `aggregateCountsByRole`,
`benchmarkRates`, `findingCounts`, `difficultyAnalytics`) it emits
`aggregateByAgent`, keyed by `agent_id`:

- `selfReported`: `{ sampleCount, scores }` — averages of the agent's own
  `agent_self_report` score dimensions.
- `measured`: `{ reviewSampleCount, scores, counts, hallucinationRatePct?,
  findingsAgainst?, taskCounts? }` — derived from records carrying a
  `review_target_agent_id` (a cross-task assessment) and attributed
  to the implementer, never the assessor. `counts` uses camelCase keys
  (`regressionCount`, `missedRequirements`, …); `hallucinationRatePct` is
  emitted only when `claimsChecked > 0`; `findingsAgainst` only when defects
  exist (so the consumer can show `0` when a review happened with no defects vs
  `—` when no review happened). `taskCounts` is the per-task drill-down detail,
  keyed by task id: `{ reviewSampleCount, counts }` (defect counts only —
  `claimsChecked` is excluded). Finding prose is NOT included here (kept in the
  projection) so the analysis output stays a sanitized aggregate.
- `findingsRaised`: count of findings the agent authored while reviewing.
- `peerReview`: `{ tasksAudited, assessmentsRecorded, passed, fixedForward,
  escalated }` — what the agent found reviewing OTHER agents' tasks, and what it
  did about it. Emitted only when the agent recorded at least one cross-task
  assessment. (Named `sweep` before MC-1825; the shape is unchanged.)

The run-summary panel consumes this via the read-only
`sprintengine:feedback:summarize` IPC and joins it against the roster + local
task counts; agents with no records simply have no `aggregateByAgent` row.

## Needs Input

`needsInput` routes blocked work:

- `kind`: the actor who must act — `architect` or `user`
  (`VALID_NEEDS_INPUT_KINDS`). Legacy `owner` and `external_validation` values
  remap on read to `architect`/`blocked_other` and `user`/`verification`
  (`LEGACY_NEEDS_INPUT_KIND_MAP`).
- `reason`: one of `task_scope`, `artifact_review`, `tooling`, `verification`,
  `product_decision`, `blocked_other`. Defaults per kind
  (`NEEDS_INPUT_KIND_DEFAULT_REASONS`).
- `question`: concrete unblock question. A `user`-kind question is shown verbatim
  to a person and must be written for that reader.
- `suggestedResolution`: optional proposed next step.
- `artifactId`: optional artifact related to an artifact review blocker.
- `originatingStatus`: set when a mid-phase `task advance --outcome escalate`
  parked the task. `task resolve-input` returns the task to that phase rather than
  to `in_progress`.
- `reportedBy`, `reportedAt`: provenance metadata.

Use `needs_input` through the CLI; do not move files between status folders by
hand.

## Artifact Files

Artifact JSON files live under `artifacts/<artifact-status>/`. Supported
artifact folders are:

- `draft`
- `recorded`
- `ready_for_review`
- `approved`
- `changes_requested`
- `superseded`

Artifact records include:

- `id`
- `kind`: `architect_plan`, `product_strategy`, `requirements`,
  `html_mockup`, `design_notes`, `branding`, `security_review`, `code_review`,
  `spec_review`, `performance_review`, `production_readiness_review`,
  `cross_platform_review`, or
  `validation_report`
- `title`
- `path`
- `status`
- `createdBy`
- `taskId`
- `fingerprint`
- `reviewHistory`
- `recommendedTasks`
- `createdAt`, `updatedAt`
- `approvedBy`, `approvedAt`
- `approvalMode`: optional approval provenance, `manual` (a human approved it) or
  `policy` (the run auto-approval policy approved it). Set by `sprintengine
  artifact approve --approval-mode` / the `approvalMode` payload field. Additive
  and back-compatible: an approval that omits it stays a plain approved artifact.

Register artifacts through `sprintengine artifact add`, `sprintengine artifact
ready`, `sprintengine artifact approve`, or `sprintengine artifact
request-changes`. `sprintengine artifact approve` accepts an optional
`--approval-mode manual|policy` to record approval provenance; the value is
validated at the mutation path (the MCP `approvalMode` payload field bypasses
argparse choices, so an invalid mode is rejected there too).

Artifact review actions are command-mediated mutations, not renderer writes to
the folder store and not terminal handoffs to the artifact producer. Manual
approval, manual request-changes, and policy-approved auto-approval may be
started by authenticated app IPC, but they must call the Sprint Engine
core/MCP artifact operation so review history, task notes, events, folder
movement, and projection refresh stay coherent.

Main/preload/renderer contracts should return and apply the refreshed
projection content after a successful review mutation, falling back to
`sprintengine projection` or the existing projection watcher only when the
mutation response lacks usable projection data. A failed mutation must not apply
stale projection content as success.

`recorded` is a durable evidence status: such artifacts are visible in task
projection data (`recordedArtifacts`) but do not enter human approval queues and
do not block task completion by themselves. No current command writes it —
`artifact add` creates a `draft`, and `--ready` moves it to `ready_for_review`.
Use `ready_for_review` only for artifacts that require human approval.

## Events

`events.jsonl` is append-only run history. Each line is a JSON object, normally
with:

- `id`
- `timestamp`
- `type`
- `actor`
- `message`
- optional task or artifact metadata

Examples include `task_claimed`, `task_evidence_appended`, `task_published`,
`task_phase_advanced`, `task_status_changed`, `task_input_resolved`,
`artifact_added`, `artifact_ready_for_review`, `artifact_approved`,
`role_enabled`, `role_runtime_changed`, and `runner_policy_updated`.

## Locks

The folder store is the mutation source. Consumers should read
`projection.json` or `sprintengine projection`, not folder internals.

The store uses lock files to serialize high-risk operations:

- `runner/run.queue.lock`: run-level mutation lock for folder-store writes.
- `runner/ready.queue.lock`: ready queue materialization lock.
- `runner/claim.queue.lock`: narrow queue lock for task claim selection.
- `runner/git.commit.lock`: serializes the shared run worktree's git index across
  concurrent agents (worktree mode only).
- `runner/run.lock.json`: run-level status marker.
- `runner/ready.lock.json`: ready runner status marker.

Consumers should not inspect lock files directly. `sprintengine projection`
reports lock state and stale-lock warnings in the normalized projection.

## DAG Readiness

`tasks/ready/` is a materialized deterministic queue for `todo` work. A task is
claimable when:

- its semantic status is `todo`;
- it has no `ownerAgentId`;
- `needsTriage` is absent or `false`;
- every dependency in the run graph is `done`.

An entry in `tasks/ready/` is claimability state, not a durable assignment to a
specific agent. Auto-run renderers may surface it as a wake candidate for a live
agent only when the current projection shows that agent has no active task,
dispatch, or `needs_input` ownership. `task next`, `task claim`, or
`join` must perform the actual claim before any task owner,
`currentDispatch`, or dispatch ledger row is created.

A worker id holds at most one **active lease** (MC-1591; `worker_has_active_lease`,
`sprintengine_core/tool/state.py`). A claim by an id that already holds an active
lease on a different task is refused with `worker_task_capacity_reached` /
`agent_already_has_active_task`; a re-claim of the id's own task is allowed. Once
that task reaches `done` the lease ends and the same id may claim again — there
is no per-task-for-life cap.

`needsTriage` is a task-card readiness flag, not a replacement for
`needsInput`. Missing `needsTriage` normalizes to `false`. When `true`, the task
remains visible in the `todo` board/projection, is omitted from materialized
ready queues, and cannot be claimed through `task next`, `task claim`,
or normal dispatch. Clearing it restores normal
dependency-based readiness.

Readiness refresh rejects unknown dependencies and cycles. The CLI command is:

```bash
sprintengine task refresh-ready
```

Standalone/headless CLI agents can start and continue with:

```bash
sprintengine join --role <role> --id <agent-id> --watch
```

Multicode-launched autonomous agents instead register with
`sprintengine.agent.join`, then call the direct claim tool named by the
renderer prompt (`sprintengine.task.next` or `sprintengine.triage.needs_input`)
exactly once. The managed server resolves `statePath` and `workspaceRoot` from run
context, so autonomous prompt payloads omit those fields.

When CLI join directs implementation work,
`sprintengine task next --role <role> --id <agent-id>` claims under the
folder-store run lock plus the claim queue lock, moving the task to
`in_progress`.

`tasks/review/` is never claimed. The task's owner is already in it, and no other
agent may take it: `task advance` is owner-only.

## Projection Boundary

Consumers should use the normalized projection instead of reading folder files:

```bash
sprintengine projection
```

The projection reads real folder-store files for initialized runs.

Projection fields include:

- `projectionVersion`
- `source`: `folder_store`
- `generatedAt`, `updatedAt`
- `run`
- `workers`: the canonical lease-derived worker view (`derive_worker_views`),
  keyed by worker id.
- `roster`: the bridge derived from the same worker views for the four TS
  `roster` readers; it cannot drift from `workers`.
- `dispatches`: the append-only `dispatch.jsonl` telemetry.
- `tasks`
- `board`
- `artifacts`
- `locks`
- `activity`
- `feedback`
- `counts`
- `runSummary`
- `statePath`, `planPath`

`board.columns` and `board.counts` expose the current columns without requiring
renderer or mobile code to inspect status folders. `locks.warnings` exposes
stale-lock warnings without requiring direct lock-file reads.

`projection.run` carries `schemaVersion`, `roleRuntimes`, `configuredRoles`, `vcs`,
`rosterPolicy`, `runner`, and — when present — `source`/`sourceBundle`
(`RUN_SOURCE_KEYS`) and `defaultPhases` (`RUN_PHASE_KEYS`).

Each projected task includes comment context for UI/mobile consumers:

- `boardColumn`, `stateStatus`: the materialized column and the semantic status.
- `comments`: full task comment list.
- `latestComments`: newest comments, bounded for inspector display.
- `latestOpenFeedback`: newest open review/test/product/architect feedback
  comments.
- `recordedArtifacts`: `recorded` artifact references linked to the task.
- `artifacts`: every artifact linked to the task.

Projection consumers should use these fields instead of parsing task folders,
artifact folders, metrics files, or comments from folder internals.

## Runner Policy

Runner policy is stored in `run.yaml` and projected under `run.runner`. The CLI
watch loop these fields configured was deleted in MC-1827 — nothing in the
engine polls. `cliWatchPolling` survives as the run.yaml hint Multicode writes
when a run's automation mode changes and the mobile snapshot reads back to
derive that mode; the remaining timing fields are inert. The runtime owns
terminal dispatch/continuation and restarts missing capacity instead of asking
agents to poll; the supervisor ignores this field.

## Verification Commands

Use focused backend and app checks when changing this contract:

```bash
python3 -m py_compile sprintengine_core/store.py sprintengine_core/tool/tasks.py sprintengine_core/tool/phase_prompts.py scripts/sprintengine_tool.py
uv run --with pytest --with PyYAML python -m pytest tests/sprintengine_tool -q
npx esbuild src/main/mobile/sprintengine/snapshot.test.ts --bundle --platform=node --format=cjs --packages=external --outfile=node_modules/.cache/multicode/mobile-sprintengine-snapshot.test.cjs && node node_modules/.cache/multicode/mobile-sprintengine-snapshot.test.cjs
npx esbuild src/main/index.ts --bundle --platform=node --format=cjs --packages=external --outfile=node_modules/.cache/multicode/main-index.check.cjs
```
