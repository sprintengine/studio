# Sprint Engine CLI

Sprint Engine is the local execution authority for specialist runs. The CLI is
the supported mutation boundary for task claiming, task status changes, evidence
logging, artifact lifecycle, roster updates, ready queue refresh, runner policy, and
projection reads.

Do not edit `<sidecar>/sprintengine/<team>/run.yaml`, task JSON files,
artifact JSON files, `events.jsonl`, metrics files, `projection.json`, runner
files, or lock files by hand. Use the CLI so locks, folder moves, activity,
events, metrics, and projections stay synchronized.

`<sidecar>` is the workspace's app-owned directory: `.sprintengine`, or
`.multi-code` in a workspace made before the 2026-09-08 rename. A workspace has
exactly one of them and nothing migrates between them, so a path written by
hand has to use the one that is already there.

## Command Portability

On POSIX shells:

```bash
sprintengine --help
```

Direct Python fallback:

```bash
.venv/bin/python scripts/sprintengine_tool.py --help
```

On Windows PowerShell:

```powershell
.\scripts\sprintengine.cmd --help
```

Windows direct Python fallback:

```powershell
& ".\.venv\Scripts\python.exe" ".\scripts\sprintengine_tool.py" --help
```

When calling `scripts/sprintengine_tool.py` directly, put global flags such as
`--state <run.yaml>` before the command group.

## Local MCP Server

Run the local stdio MCP server through either supported entrypoint:

```bash
sprintengine mcp serve --workspace .
python -m sprintengine_mcp --workspace .
```

`sprintengine mcp serve` delegates to the same server as
`python -m sprintengine_mcp`. Use repeated `--workspace` or `--allowed-root`
flags to bound which workspace roots may contain Sprint Engine state paths.
Use repeated `--extra-dir <registry-root>` flags to add plugin registry roots
containing `roles/` and `skills/`, and `--user-dir <path>` to override the user
registry base directory. The server is a local stdio MCP boundary by default,
or a local Streamable HTTP server under `mcp serve --http`.
Studio-launched autonomous Sprint Engine agents use the managed
`sprintengine-studio` MCP gateway (which proxies the module-owned Python hub) and runtime dispatch.
Human and debug operators can run `sprintengine join --id <agent-id>`
(with `--role` on a role-tagged run) for a one-shot read of what the run would
hand that agent; it never polls.

## Single-Owner Task Lifecycle

One agent owns a task from claim to `done`. It implements, publishes, then
reviews its own diff in the same session; no other agent picks the task up. The
board columns are `todo → ready → in_progress → review → done`, plus
`canceled`, with `needs_input` as the blocked surface (`ready` is the
materialized queue, not a semantic status).

Two commands drive the whole lifecycle after the claim:

- `sprintengine task publish` records the implementation summary and routes the
  task. It is the only command that enters the phase walk.
- `sprintengine task advance` closes the task's current phase and steps forward.
  It is the only command that walks phases, and only the task owner may call it.

## Standalone CLI Worker Flow

Workers operating outside the studio's managed MCP runtime can join the active
run, read the plan returned by the directive, claim one ready task for their
exact role, log evidence, then publish and walk the task's phases:

```bash
sprintengine join --role developer --id developer-1
sprintengine task next --role developer --id developer-1
sprintengine task log --task-id T8 --id developer-1 --summary "Updated Sprint Engine docs" --file docs/sprintengine-cli.md --command "uv run --with pytest --with PyYAML python -m pytest tests/sprintengine_tool -q" --result "Passed"
sprintengine task publish --task-id T8 --id developer-1 --summary "Rewrote the CLI doc for the single-owner lifecycle." --path docs/sprintengine-cli.md
sprintengine task advance --task-id T8 --id developer-1 --phase review --outcome pass --summary "Re-read the diff against the acceptance criteria; no findings."
```

Use `sprintengine task next`, not manual file moves, for normal claiming. It
claims a ready `todo` task under folder-store locks and refreshes folder-store
materialization.

`sprintengine task status` remains the low-level repair/admin transition for
corrections a workflow command cannot express. It is not the normal completion
path — `publish` and `advance` are.

## Roles

Sprint Engine roles are registry-backed. Active role validation resolves role
ids and aliases through the Sprint Engine role registry at command time rather
than through a hardcoded runtime enum. The registry search path supports
workspace-local `.sprintengine/{roles,skills}/`, plugin-scoped Sprint Engine
registry folders, and user registry folders — where the app installs the
specialist pack shipped in `resources/specialist-pack/{roles,skills}/`. The
bundled layer under `resources/sprintengine/` carries skills only; there is no
bundled `roles/` directory.

A role manifest (`sprintengine_core/role_registry.py`) is `id`, `label`,
`aliases`, optional `description`/`icon`, and a required `directives` object:

- `directives.implement` — the ordered `{ "skill": "<id>" }` entries composed
  into the role's startup brief. Required and non-empty.
- `directives.<phase>` — optional role-specific additions appended to that
  phase's shared base pack. The only shipped phase key is `review`; any other
  key rejects the manifest.
- The removed keys `soul` and `capabilities` are rejected by name
  (`REMOVED_MANIFEST_KEYS`): a manifest carrying either is skipped with a
  `v1_role_manifest` warning that names its `directives` replacement. There is
  no compatibility shim.
- The renamed key `summary` is ignored with a `renamed_manifest_key` warning
  naming `description` (`RENAMED_MANIFEST_KEYS`, MC-1831).

Sprint Engine routing is driven by run state: the run's `configuredRoles` (the
roles a task may be tagged with), the per-role `roleRuntimes` binding, and each
task's `role`. Bundled role label maps may remain for display defaults, but they
are not the active Sprint Engine authority for workspace custom roles.

### Registry Inspection

Read-only registry inspection commands use the current working directory as the
workspace registry root. They do not read or mutate a Sprint Engine run store,
so `--state` is optional and ignored for these command groups.

```bash
sprintengine roles list
sprintengine roles list --include-shadowed
sprintengine role get developer
sprintengine soul get developer --run-id my-run
sprintengine skill list
sprintengine skill list --include-body
sprintengine skill get developer
```

The JSON payloads match the local MCP registry tools. Role and skill records
include `source.layer`, and commands that inspect one role or list roles with
`--include-shadowed` include `shadowedSources` where lower-precedence registry
entries are hidden by workspace, plugin, user, or bundled precedence. Unknown
role and skill errors include the known configured ids to make typos and
missing custom registries easy to diagnose.

The same inspection commands can be routed through the local MCP backend:

```bash
sprintengine --backend mcp-local roles list
sprintengine --backend mcp-local role get developer
sprintengine --backend mcp-local soul get developer
sprintengine --backend mcp-local skill list
sprintengine --backend mcp-local skill get developer
```

Plugin registry roots can be supplied to direct inspection commands, the MCP
backend, or the stdio server:

```bash
sprintengine roles list --extra-dir ./plugin/.sprintengine
sprintengine --backend mcp-local roles list --extra-dir ./plugin/.sprintengine
sprintengine mcp serve --workspace . --extra-dir ./plugin/.sprintengine
```

## Roster Composition

### Operator runtime edits (`roster runtime`, MC-1516)

The **operator** (never an agent) can change one role's runtime at any point in
the run, including after plan approval — this is the app-owned path behind the
board's Roster tab role bands:

```bash
sprintengine roster runtime --role developer --cli claude-code --model claude-haiku-4-5 --actor ui
```

- `--cli` is required (pass the role's current CLI when changing only the
  model); omitting `--model` pins the CLI's own default (no `--model` flag at
  launch).
- Merges the one role into `roleRuntimes` in a locked transaction and appends a
  `role_runtime_changed` event carrying the previous value. `apply_role_runtimes`
  rebuilds the entry and carries `reasoning` forward when the key is absent, so
  a reasoning level the command does not mention is preserved rather than
  dropped (MC-1885); an explicit `"reasoning": null` clears it. This command is
  cli/model-scoped.
- Deliberately **not** an MCP tool: a role's execution runtime is user config.
  The role must resolve in the registry and, on configured rosters, be in
  `configuredRoles` (`role_not_enabled_for_run`).
- Applies to every future spawn and claim of the role; live sessions keep the
  runtime they launched with until they next start.

### Operator role enablement (`roster enable`, MC-1593)

The **operator** (never an agent) can enable one more role for the run at any
point, including after plan approval — this is the app-owned path behind the
board's "Add a role" control on the Agents tab:

```bash
sprintengine roster enable --role tester --cli claude-code --actor ui
```

- **Additive only**: the role is unioned into `configuredRoles`; the existing
  set is never replaced or reduced.
- Optional `--cli`/`--model` seed the role's runtime in the same locked write
  (a plain `roleRuntimes` merge, same semantics as `roster runtime`).
- Appends a `role_enabled` event; re-enabling an already-enabled role is a
  no-op reported as `alreadyEnabled: true`.
- A run with **no** `configuredRoles` (legacy/unconstrained) already admits
  every role, so no list is written — writing one would suddenly constrain
  the run.
- Like `roster runtime`, deliberately **not** an MCP tool and **not** subject
  to the architect-mode guards: roles are user config, so the user's own board
  action is the sanctioned writer. Agents route roster wishes through
  `needs_input(user)`.

## Run Phases (`--default-phases-json`)

`sprintengine init --default-phases-json '<json>'` writes the run's top-level
`defaultPhases` key: the ordered list of post-implementation phases every task
inherits when `plan add-task` passes no `--phases`. The only shipped phase is
`review` (`store.VALID_TASK_PHASES`); the list shape exists so a future phase
slots in without a schema change.

```bash
sprintengine init --name my-team --default-phases-json '["review"]'
sprintengine init --name my-team --default-phases-json '[]'
```

- It is the **default and the ceiling**. A task's `--phases` must be a subset of
  it; a phase outside the run's set is rejected with
  `phase_not_configured_for_run` (`assert_phases_within_run_ceiling`,
  `sprintengine_core/tool/tasks.py`). A task may trim phases, never add one.
- `[]` is valid and recorded: every publish that produced changes routes
  straight to `done`.
- An absent key reads as the engine default `["review"]`
  (`store.run_default_phases`).
- CLI-init-only, like `--role-runtimes-json`. It is not MCP-mutable: "agents on this run do not review their own work" is an operator
  guarantee, not an architect preference.

Per-task trimming happens at plan time with a comma-separated `--phases`
(`""` = no phases):

```bash
sprintengine plan add-task --title "Update the changelog" --role developer --phases ""
sprintengine plan update-task --task-id T4 --phases review
```

## Review tasks

Cross-cutting quality (QA, security, performance, product, UX, production
readiness) is planned by the architect as ordinary tasks in a reviewer role's
lane, typically `dependsOn` the implementation they audit. Nothing in a manifest
marks a role as a reviewer — the architect reads the role's natural-language
`description` and decides what to task it with.

A reviewer has the same tool surface as any worker: it claims its task, patches
what it finds, publishes, and — because it produced a diff — walks `review` on
its own fixes. A review that found nothing produces no diff and publishes
straight to `done`.

There is no run-level mandate for reviewer coverage: the `requiredSweeps` run
key and `--required-sweeps-json` were removed in MC-1825. The engine ignores the
key an older `run.yaml` still carries.

## Integration review (`--kind integration_review`)

Every plan that produces implementation should end with one task chartered to
prove the pieces work together — build the product, run the app, exercise the
seams between the tasks. The architect marks it at plan time:

```bash
sprintengine plan add-task --title "Integration review" --role developer \
  --kind integration_review --depends-on T2 --depends-on T5 \
  --acceptance "App builds and boots; every cross-task seam exercised through a real product path"
```

The marker is not machinery. An integration task claims, publishes, and walks
`review` like any other task; its freshness is graph shape — because it
`dependsOn` the implementation work, it necessarily runs against the final
tree. Two advisory warnings (never errors) keep the shape honest:

- Approving an `architect_plan` artifact returns `integrationWarnings` when
  implementation tasks exist with no integration task, or when coverage is
  partial (an implementation task the integration task does not transitively
  depend on).
- `plan add-task` returns a `warnings` entry when implementation work is added
  after every integration task already completed — the finished check no
  longer covers the new work; plan a fresh one.

A docs-only or spike plan may legitimately skip the integration task; the
warnings exist so the absence is a visible decision at plan approval, not an
accident.

## Command Groups

Inspect help before scripting a command:

```bash
sprintengine --help
sprintengine task next --help
sprintengine artifact add --help
sprintengine projection --help
```

Current command groups:

- `handover`: create a team bootstrap and handoff context. `--source-plan-kind` accepts `unknown`, `product_plan`, `architect_plan`, `epic` (a backlog epic launched as a reference-based sprint), or `selection`. `--reference-sources` records the `--handover` markdown and every `--source kind:path` item as project-root-relative references to the canonical originals instead of copying them into the run store — the architect reads and updates those files in place. Inline (`--handover-text`) and stdin sources have no durable file and keep the copy behavior.
- `init`: initialize a run.
- `recover`: run an integrity recovery audit prompt.
- `projection`: read the normalized run projection.
- `runner`: read or update the durable runner policy.
- `roster`: run-config operations only — `runtime` (operator per-role runtime edit) and `enable` (add a role to the run's `configuredRoles`). MC-1591 deleted the membership ops (`add`/`retire`/`replenish`/`list`) and MC-1889 deleted `configure`; membership is `configuredRoles` and assignment is a task lease.
- `join`: receive the role prompt and next directive.
- `triage`: inspect architect-actionable blockers.
- `mcp`: `serve` the MCP boundary — local stdio by default, or a local Streamable HTTP server under `--http` with `--host`, `--port` and `--auth-token`.
- `roles`: list configured registry roles.
- `role`: inspect one configured registry role.
- `soul`: render a role's startup brief from its `directives.implement` skills.
- `skill`: list or inspect configured registry skills.
- `task`: `next`, `claim`, `status`, `resolve-input`, `release`,
  `refresh-ready`, `log`, `publish`, `advance`, `note`, `comment` and `list`.
  Editing a task's own fields is `plan update-task`, not a `task` action.
- `plan`: architect-owned task graph operations — `add-task`, `update-task`,
  `delete-task`, `add-dependency`, `remove-dependency`, `list`, `read`.
- `artifact`: register and review artifacts.
- `vcs`: the repo boundary — `status`, `task-worktree`, `commit`,
  `request-repo`, `pr`, `pr-status`, `pr-merge`.
- `summary`: print final run summary.
- `cancel`: cancel the run.

## Folder Store And Projection

The folder store lives under `<sidecar>/sprintengine/<team>/` and contains
`run.yaml`, `events.jsonl`, `projection.json`, status folders under `tasks/`,
status folders under `artifacts/`, `metrics/agent-feedback.jsonl`, and support
folders such as `runner/`, `reviews/`, and `validation/`.

The projection command is the stable read API:

```bash
sprintengine projection
```

It reads real folder-store files for initialized runs. It includes run
metadata, roster, tasks, board columns, artifacts, lock status, stale-lock
warnings, activity, feedback, ready counts, needs-input counts, run summary
fields, runner policy, and per-task comment context (`latestComments`,
`latestOpenFeedback`, `recordedArtifacts`).

The run store carries a `schemaVersion` (currently `5` —
`RUN_SCHEMA_VERSION`, `sprintengine_core/store.py`). One step is migrated and
the rest are rejected: `state_from_folder_store` and `build_projection` both
call `migrate_run_store`, which upgrades a v4 store in place
(`MIGRATABLE_RUN_SCHEMA_VERSION`), and then `assert_store_is_current`, which
raises `RunStoreVersionError` for anything older. The projection re-emits
`run.schemaVersion`, so the app rejects a stale `projection.json` without
calling Python (`describeUnsupportedSprintEngineStore` and
`SPRINT_ENGINE_RUN_SCHEMA_VERSION` in `src/shared/sprintengine/store-schema.ts`,
re-exported by `src/main/sprintengine-artifacts.ts`). The remedy for a store
below the migratable floor is to delete `<sidecar>/sprintengine/<team>/` and
re-run the sprint.

Renderer and mobile code should consume projection data or `projection.json`;
they should not parse task folders, artifact folders, locks, events, metrics, or
run-store internals directly.

## Task Commands

Typical task commands:

```bash
sprintengine task list --role developer
sprintengine task next --role developer --id developer-1
sprintengine task claim --task-id T3 --id developer-1
sprintengine task status --task-id T3 --status needs_input --id developer-1 --needs-input-kind architect --needs-input-reason task_scope --needs-input-question "Does this task need a wider owned path?"
sprintengine task resolve-input --task-id T3 --id architect --resolution "Scope narrowed; continue."
sprintengine task release --task-id T3 --id architect --reason "Original worker inactive."
sprintengine task log --task-id T3 --id developer-1 --summary "Implemented store projection" --file sprintengine_core/store.py --command "uv run --with pytest --with PyYAML python -m pytest tests/sprintengine_tool -q" --result "Passed"
sprintengine task note --task-id T3 --id developer-1 --note "Blocked until artifact A1 is approved."
sprintengine task publish --task-id T3 --id developer-1 --summary "Implemented the projection route and added regression coverage." --path sprintengine_core/store.py
sprintengine task advance --task-id T3 --id developer-1 --phase review --outcome pass_with_fixes --summary "Found and fixed an unguarded empty-list read; smoke-checked the projection command."
sprintengine task comment add --task-id T3 --id user --source user --type user_note --body "Please include migration notes."
sprintengine task comment list --task-id T3
sprintengine task refresh-ready
```

Use `--scope-expansion-json` when evidence includes a touched file outside the
task's owned paths:

```bash
sprintengine task log --task-id T3 --id developer-1 --scope-expansion-json '{"path":"src/shared/electron-api.ts","reason":"Expose projection read result type for renderer consumers.","risk":"low"}'
```

Architects can add optional task difficulty estimates when planning or updating
task cards:

```bash
sprintengine plan add-task --title "Persist feedback metrics" --role developer --path sprintengine_core/tool/feedback.py --acceptance "Metrics JSONL preserves benchmark counts" --difficulty-pct 58 --difficulty-reason "Small schema-compatible CLI and metrics change."
sprintengine plan update-task --task-id T3 --difficulty-pct 65 --difficulty-reason "Analysis change touches derived rates and edge cases."
```

Implementers can record actual difficulty at publish or done time:

```bash
sprintengine task publish --task-id T3 --id developer-1 --summary "Implemented the analytics rollup." --path sprintengine_core/analysis.py --actual-difficulty-pct 68 --actual-difficulty-reason "Moderate analytics work plus compatibility tests."
sprintengine task status --task-id T3 --status done --id developer-1 --actual-difficulty-pct 42 --actual-difficulty-reason "Focused docs-only change."
```

## Publish And Phase Commands

### `task publish`

`sprintengine task publish` records an `implementation_summary` comment — or an
`implementation_response` when the task carries open feedback — then routes the
task in one step (`publish_task`, `sprintengine_core/tool/tasks.py`):

1. **Change detection** (`task_produced_changes`). In worktree mode a task with
   any task-scoped commit produced a diff. Outside worktree mode the working
   tree is checked, scoped to the task's owned and declared paths. When the
   answer cannot be determined at all (no git repository), the answer is `True`
   — routing to review is the failure-safe direction.
2. **Routing.** A diff → the task advances to `phases[0]`, or to `done` when
   the task has no phases. No diff is **refused** since MC-1753 unless the
   caller passes `--no-changes-ok` or the task was planned with an explicit
   empty `phases` list — the analysis-only exit has to be declared, not
   inferred. A no-diff publish is also refused while in-scope changes are
   uncommitted.

The owner **keeps** the task when it enters a phase, and the composed phase
directive comes back inline in the publish response as `nextDirective` — the
owner is mid-tool-call, so there is nothing to paste and nothing to spawn. On
the `done` route the owner is cleared and the lease ended.

In worktree mode publish also commits task-scoped changes under that repo's
`runner/git.commit.<repoId>.lock` (one lock per declared repo since MC-1611).
A task-adjacent orphaned change — a changed path owned by no task — is **not**
a refusal: MC-2127 returns it as `uncommittedPaths` plus an
`uncommittedPathsQuestion` and lets the publish stand.

```bash
sprintengine task publish --task-id T3 --id developer-1 --summary "Added the phase-routing branch and its regression tests." --path sprintengine_core/tool/tasks.py
```

Response fields: `ok`, `task`, `comment`, `event`, `nextStatus`,
`previousStatus`, `producedChanges`, `phases`, `nextDirective` (only when the
task entered a phase), `committed`, `commitSha`, and conditionally
`completionKind`, `uncommittedPaths`, `uncommittedPathsQuestion`, `warnings`,
`seamSignals`, `feedbackRecorded` and `feedbackMetricsPath`.

### `task advance`

`sprintengine task advance` closes the current phase and steps forward. It is
the only mutation that walks phases, and it is **owner-only** — the caller must
be the task's `ownerAgentId` (`not_task_owner`). `--phase` must equal the task's
current status (`phase_mismatch`), which is what stops a stale call from a
resumed session skipping a phase.

```bash
sprintengine task advance --task-id T3 --id developer-1 --phase review --outcome pass --summary "Re-read the diff against acceptance; traced the empty and duplicate cases; smoke-checked the CLI route."
sprintengine task advance --task-id T3 --id developer-1 --phase review --outcome pass_with_fixes --summary "Fixed a silent fallback that masked a parse failure; added the missing regression test." --finding-json '{"kind":"code_bug","severity":"high","area":"cli","title":"Silent parse fallback"}'
sprintengine task advance --task-id T3 --id developer-1 --phase review --outcome escalate --summary "The acceptance criteria contradict the plan's owned-path boundary." --needs-input-kind architect --needs-input-reason task_scope --needs-input-question "Should this task also own the renderer projection types?" --needs-input-suggested-resolution "Add the renderer type file as a scope expansion, or create a follow-up frontend task."
```

Outcomes (`VALID_PHASE_OUTCOMES`):

- `pass` — the phase found nothing to fix.
- `pass_with_fixes` — findings were found and fixed in the same session.
- `escalate` — a plan contradiction, scope change, or product decision blocks
  the owner. Requires `--needs-input-question`. The task moves to `needs_input`
  and the phase it escalated from is recorded as
  `needsInput.originatingStatus`, so `task resolve-input` returns it to **that
  phase**, not to `in_progress` (`resolve_task_input`).

`pass`/`pass_with_fixes` step to the next phase in the task's list, or to `done`
when none remains. The walk is strictly forward: a phase is visited at most once
per walk, and only `task publish` enters the walk.

`--finding-json` is best-effort categorical telemetry
(`build_feedback_payload(..., best_effort=True)`): an invalid optional sub-field
is dropped with a `feedbackWarnings` entry rather than rejecting the transition.
Records land on the task and in `metrics/agent-feedback.jsonl` with
`source: phase_advance_self_review` and `phase`/`phase_outcome` keys — a phase
advance is the owner reporting on its own work, so it is a self-report.

### Rework

Human artifact review is the rework channel. `sprintengine artifact
request-changes` records the feedback as a typed comment and reopens the linked
task (`reopen_task_for_artifact_changes`): to `in_progress` when the owner is
still active on it, otherwise to unowned `todo`. Moving an unowned task back to
`in_progress` with `task status` re-binds it to `lastImplementedByAgentId`; with
no implementer on record the task returns to `todo` instead of becoming
unclaimable. A re-publish then runs change detection and phase routing again
from `phases[0]`.

### Benchmark Feedback Counts And Difficulty

Feedback count flags are optional evidence fields. Report only values you
actually evaluated; leave a flag unset when you did not check that category.

- `--claims-checked`: concrete implementation, specification, evidence, or
  verification claims checked.
- `--hallucinated-claims`: checked claims unsupported by the repository, task
  card, evidence, or observed behavior.
- `--factual-errors`: checked claims contradicted by source, docs, tests, state,
  or runtime evidence.
- `--missed-requirements`: required acceptance criteria, task notes, or plan
  items absent or only partially implemented.
- `--implementation-mistakes`: code, state, schema, routing, integration, or
  workflow defects in the delivered work.
- `--regression-count`: previously working behavior or contract broken by the
  change.
- `--test-failures-introduced`: new failing tests or reproducible validation
  failures caused by the change.
- `--unsafe-changes`: security, data-loss, destructive-operation, privacy, or
  permission risks introduced by the change.

Findings are optional categorical telemetry, reported with repeatable
`--finding-json`. `kind`, `severity`, and `area` are required and enum-checked;
`title` is an optional short label. Report every real finding, including the
ones you fixed.

Difficulty fields are optional assessed metadata. Architects use
`--difficulty-pct` and `--difficulty-reason` on plan add/update commands.
Implementers use `--actual-difficulty-pct` and `--actual-difficulty-reason` on
publish/done commands.

## Artifact Commands

Artifacts are durable outputs tied to producing tasks:

```bash
sprintengine artifact add --task-id T1 --kind architect_plan --title "Architect plan" --path .sprintengine/sprintengine/team/plan.md --created-by architect
sprintengine artifact ready --artifact-id A1 --id architect
sprintengine artifact list --task-id T1
sprintengine artifact approve --artifact-id A1 --id user
sprintengine artifact request-changes --artifact-id A1 --id user --feedback "Narrow the scope."
```

`sprintengine artifact add --ready` immediately registers an artifact as
`ready_for_review` and moves the linked task to `needs_input` when human review
is required.

Artifact approval and request-changes are Sprint Engine state mutations. App UI
code may initiate explicit user review actions through authenticated main/MCP
IPC, but the command must still run through the Sprint Engine artifact mutation
path so artifact files, task notes, events, and projection stay synchronized.
This is different from direct store mutation: renderer, preload, mobile, and
agents must not edit artifact JSON, task folders, events, or projection files.

Auto-approval follows the same boundary after its policy checks pass. It should
call the Sprint Engine artifact approval command and apply the returned
projection data; it should not send approval request text to the producing
agent terminal. The studio may wake or focus terminals after Sprint Engine
records notification, dispatch, or rework state, but direct MCP notifications
are not assumed to wake Codex or Claude sessions by themselves.

## Runner Policy

The durable runner policy lives in `run.yaml` and is exposed in projection:

```bash
sprintengine runner status
sprintengine runner set --mode auto
sprintengine runner set --mode off
```

`join` is a one-shot operator read: it reports what the run would hand this
role right now and returns. The polling `--watch` loop and its completion
machinery were retired with the CLI-runner era (MC-1827); the managed runtime
is the product.

Studio-launched autonomous agents never use the CLI. Their startup and wake
prompts call `sprintengine.agent.join`, then claim with `sprintengine.task.next`.
The studio owns later continuation, terminal wake/resume, and replacement
spawning for ready work, owner re-engagement after human feedback, and
`needs_input` recovery.

Phase directives never travel this way. They have exactly two delivery channels
(`sprintengine_core/tool/phase_prompts.py`): inline in the owner's own
`task.publish` / `task.advance` response (`build_phase_directive`, the live
owner), and the respawn startup brief for an owner that died mid-phase
(`build_phase_respawn_brief`). No phase transition is announced by pasting into
a terminal.

Renderer roster prompts for unclaimed ready tasks are wake candidates, not
durable dispatch assignments. A `dispatch.jsonl` row is appended only after
Sprint Engine records a task claim, owner re-engagement, or an expiry re-queue; a
worker's `currentDispatch` is then reconstructed from that ledger by the derived
worker view, not persisted per agent (MC-1591 deleted the per-agent dispatch
cursor tools `dispatch.next`/`dispatch.ack`/`subscribe`). Repeated directive or
`task next` calls reuse the existing dispatch id rather than creating duplicates.

## DAG Readiness

Readiness is deterministic and dependency-aware. A `todo` task appears in
`tasks/ready/` when every dependency is `done`, the task has no owner, and
`needsTriage` is not set (`task_is_ready`, `sprintengine_core/tool/tasks.py`).

Ready queue membership means claimable work exists. It does not mean the work
has a durable dispatch id or has been assigned to an agent before the claim
command runs.

`tasks/review/` is not a readiness queue. A task in `review` is still **owned**
by the agent that implemented it: `release_agent_targets`
(`sprintengine_core/tool/state.py`) releases only `in_progress` tasks back to
`todo`, so a departing or expired owner keeps its `review` task and is revived
under the same id with a phase brief. `needs_input` stays owned for the same
reason.

Refresh readiness explicitly with:

```bash
sprintengine task refresh-ready
```

Unknown dependencies and cycles fail with clear errors. Do not create readiness
by moving task files by hand.

## Locks And Recovery

The CLI serializes folder-store mutations with `runner/run.queue.lock`,
materialization with `runner/ready.queue.lock`, and claim selection with
`runner/claim.queue.lock`. In worktree mode, staging and committing the shared
run worktree's git index is serialized by `runner/git.commit.lock`. The
projection reports lock status and stale-lock warnings so app and mobile
consumers do not need to inspect lock files.

Use recovery when a run needs an integrity audit:

```bash
sprintengine recover
```

Recovery is for diagnosing and repairing run integrity through the tool
boundary; it is not permission to edit store files manually.

## Paths

Use project-root-relative paths in task cards, evidence, artifacts, notes,
review files, docs, and handoffs:

```text
docs/sprintengine-cli.md
sprintengine_core/store.py
.sprintengine/sprintengine/team/reviews/code-review.md
```

Do not write absolute paths, home-directory paths, drive-letter paths, UNC
paths, URLs, or `..` traversal into Sprint Engine records.

## Verification Commands

Use real CLI/core paths when validating Sprint Engine changes:

```bash
python3 -m py_compile sprintengine_core/store.py sprintengine_core/tool/tasks.py sprintengine_core/tool/phase_prompts.py scripts/sprintengine_tool.py
uv run --with pytest --with PyYAML python -m pytest tests/sprintengine_tool -q
npx esbuild src/main/mobile/sprintengine/snapshot.test.ts --bundle --platform=node --format=cjs --packages=external --outfile=node_modules/.cache/multicode/mobile-sprintengine-snapshot.test.cjs && node node_modules/.cache/multicode/mobile-sprintengine-snapshot.test.cjs
npx esbuild src/main/index.ts --bundle --platform=node --format=cjs --packages=external --outfile=node_modules/.cache/multicode/main-index.check.cjs
```

`npm run typecheck:app` is also useful when local frontend dependencies are
installed.
