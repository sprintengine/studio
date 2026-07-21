# Sprint Engine CLI

Sprint Engine is the local execution authority for specialist runs. The CLI is
the supported mutation boundary for task claiming, task status changes, evidence
logging, artifact lifecycle, roster updates, ready queue refresh, runner policy, and
projection reads.

Do not edit `.multi-code/sprintengine/<team>/run.yaml`, task JSON files,
artifact JSON files, `events.jsonl`, metrics files, `projection.json`, runner
files, or lock files by hand. Use the CLI so locks, folder moves, activity,
events, metrics, and projections stay synchronized.

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
registry base directory. The server remains a local stdio MCP boundary.
Studio-launched autonomous Sprint Engine agents use the managed
`sprintengine-studio` MCP gateway (which proxies the module-owned Python hub) and runtime dispatch; they do not use
`join --watch` for idle polling. Standalone/headless CLI users can still run
`sprintengine join --role <role> --id <agent-id> --watch`, where the CLI owns
polling/backoff.

## Single-Owner Task Lifecycle

One implementation agent normally owns a task from claim to `done`. It
implements, publishes, and reviews its own diff in the same session. A
configured independent phase runtime may temporarily own `review`; an open
review request then returns implementation to the worker and reapproval to the
recorded requester. The board columns are `todo → ready → in_progress → review → done`, with
`needs_input` as the blocked surface (`ready` is the materialized queue, not a
semantic status).

Two commands drive the normal forward lifecycle after the claim:

- `sprintengine task publish` records the implementation summary and routes the
  task. It is the only command that enters the phase walk.
- `sprintengine task advance` closes the task's current phase and steps forward.
  It is the only command that walks phases, and only the task owner may call it.

## Standalone CLI Worker Flow

Workers operating outside Multicode's managed MCP runtime can join the active
run, read the plan returned by the directive, claim one ready task for their
exact role, log evidence, then publish and walk the task's phases:

```bash
sprintengine join --role developer --id developer-1 --watch
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
registry folders, user registry folders, and bundled
`resources/sprintengine/{roles,skills}/`.

A role manifest (`sprintengine_core/role_registry.py`) is `id`, `label`,
`aliases`, optional `summary`/`icon`, a required `directives` object, and an
optional `sweep` block:

- `directives.implement` — the ordered `{ "skill": "<id>" }` entries composed
  into the role's startup brief. Required and non-empty.
- `directives.<phase>` — optional role-specific additions appended to that
  phase's shared base pack. The only shipped phase key is `review`; any other
  key rejects the manifest.
- `sweep` — `null`, or `{ "focus": "...", "when": "..." }` on a sweep role: a
  full implementer that audits a body of work and fixes what it finds.
  `RegistryDiscovery.sweep_roles()` enumerates every registry-visible sweep
  role, bundled or custom.
- The removed keys `soul` and `capabilities` are rejected by name
  (`REMOVED_MANIFEST_KEYS`): a manifest carrying either is skipped with a
  `v1_role_manifest` warning that names its replacement (`directives` /
  `sweep`). There is no compatibility shim.

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

Two `sprintengine init` flags decide who composes the team and which runtimes
are in play. Both are written once at init (the app forwards them from the
sprint wizard) and are **not MCP-mutable**:

- `--roster-source <user|architect>`: who composes the roster. `user` (the
  default; absent/legacy runs behave as `user`) means the operator picked the
  team in the wizard. `architect` ("Architect picks the team") means the
  architect enables roles via `sprintengine roster configure` during planning.
- `--allowed-runtimes-json '<json>'`: the sprint's allowed runtime palette — a
  JSON array of `{"cli", "model"}` objects (`"model": null` = that CLI's own
  default). `roster configure` hard-rejects any role assignment whose
  `{cli, model}` is not an exact entry here. Absent on `user`/legacy runs.

On an `architect`-source run the architect enables roles and pins each role's
runtime in one sanctioned mutation, before creating task cards:

```bash
sprintengine roster configure --id architect --roles-json '[
  {"role": "developer", "cli": "claude-code", "model": "claude-opus-4-8"},
  {"role": "tester", "cli": "claude-code", "model": null}
]'
```

- `--roles-json` (required) is a JSON array of `{"role", "cli", "model"}`
  objects; `"model": null` pins the CLI default (no `--model`).
- `configuredRoles` is **replaced** by the union of the submitted roles and the
  run's planning role — this enabled set is what gates roles. `roleRuntimes` is
  **merged** over the existing map, so a revision that drops a role leaves that
  role's stale runtime entry behind (harmless, since `configuredRoles` gates).
- The command is rejected when: the run is not `rosterSource: architect`
  (`roster_configure_requires_architect_roster_source`); the plan is already
  approved (`roster_locked_after_plan_approval` — route post-approval changes
  through `needs_input(user)`); a submitted role is unknown to the registry; or
  a `{cli, model}` is outside `--allowed-runtimes-json`
  (`runtime_not_allowed_for_run`). Re-run the command to revise the team until
  the plan is approved.

Over MCP the same operation is `sprintengine.roster.configure` with
`{ roles: [{ role, cli, model }, ...], id? }`. It lives in `PLANNING_TOOLS`, so
the planning role holds it — architect and general converge on the same surface
(MC-1591 deleted the roster-growth tools that used to distinguish them). It still
gates on `rosterSource: architect`, so only an architect-composed run can seat a
team through it.

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
  `role_runtime_changed` event carrying the previous value.
- Deliberately **not** an MCP tool and **not** subject to the
  `rosterSource`/plan-approval-lock/`allowedRuntimes` guards above — the
  palette constrains the architect, never the operator. The role must resolve
  in the registry and, on configured rosters, be in `configuredRoles`
  (`role_not_enabled_for_run`).
- Applies to every future spawn and claim of the role; live sessions keep the
  runtime they launched with until they next start.

### Operator role enablement (`roster enable`, MC-1593)

The **operator** (never an agent) can enable one more role for the run at any
point, including after plan approval — this is the app-owned path behind the
board's "Add a role" control on the Agents tab:

```bash
sprintengine roster enable --role tester --cli claude-code --actor ui
```

- **Additive only**: the role is unioned into `configuredRoles`; unlike
  `roster configure`, the existing set is never replaced or reduced.
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
- CLI-init-only, like `--roster-source` and `--allowed-runtimes-json`. It is not
  MCP-mutable: "agents on this run do not review their own work" is an operator
  guarantee, not an architect preference.

Per-task trimming happens at plan time with a comma-separated `--phases`
(`""` = no phases):

```bash
sprintengine plan add-task --title "Update the changelog" --role developer --phases ""
sprintengine plan update-task --task-id T4 --phases review
```

## Sweeps

A sweep role is a full implementer that audits a body of work and fixes what it
finds, planned by the architect as an ordinary task (typically `dependsOn` the
implementation it audits). It declares a `sweep` block in its manifest and has
the same tool surface as any worker: it claims its task, patches what it finds,
publishes, and — because it produced a diff — walks `review` on its own fixes. A
clean sweep produces no diff and publishes straight to `done`.

The operator can mandate sweeps regardless of the architect's risk assessment:

```bash
sprintengine init --name my-team --required-sweeps-json '["tester", "security"]'
```

Each id must name a registry sweep role (a worker role or a typo fails at init,
listing the known sweeps). `requiredSweeps` is written once at init,
round-tripped through `run.yaml`/projection, and omitted when none are mandated.
Like the other init keys it is CLI-init-only and not MCP-mutable.

### `--phase-runtimes-json`

Binds a phase to its own runtime, so a strong model reviews what cheap models
build:

```bash
sprintengine init --name my-team \
  --allowed-runtimes-json '[{"cli": "claude-code", "model": "sonnet"}, {"cli": "claude-code", "model": "fable"}]' \
  --phase-runtimes-json '{"review": {"cli": "claude-code", "model": "fable"}}'
```

Each key must be a valid phase and each binding must appear in
`allowedRuntimes` (validated at init, so the flag must follow
`--allowed-runtimes-json`).

The cost invariant is the point of the feature. **An absent `phaseRuntimes`, or
a binding that equals the task owner's own runtime, creates no extra sessions**
— the owner reviews its own diff in-session, exactly as it does without the
flag. Only a binding that *differs* from the owner's runtime releases the task
(`ownerAgentId: null`, `awaitingPhaseSession: {phase, runtime}`); the supervisor
then spawns a fresh, diff-seeded session on that runtime, which claims the task
through `task next` without rewinding its status. You pay for exactly the
independent reviews you asked for.

`phaseRuntimes` is CLI-init-only and not MCP-mutable, like the other init keys.

## Command Groups

Inspect help before scripting a command:

```bash
sprintengine --help
sprintengine task next --help
sprintengine artifact add --help
sprintengine projection --help
```

Current command groups:

- `handover`: create a team bootstrap and handoff context. `--source-plan-kind` accepts `unknown`, `product_plan`, `architect_plan`, or `epic` (a backlog epic launched as a reference-based sprint). `--reference-sources` records the `--handover` markdown and every `--source kind:path` item as project-root-relative references to the canonical originals instead of copying them into the run store — the architect reads and updates those files in place. Inline (`--handover-text`) and stdin sources have no durable file and keep the copy behavior.
- `init`: initialize a run.
- `recover`: run an integrity recovery audit prompt.
- `projection`: read the normalized run projection.
- `runner`: read or update the durable runner policy.
- `roster`: run-config operations only — `configure` (architect team composition) and `runtime` (operator per-role runtime edit). MC-1591 deleted the membership ops (`add`/`retire`/`replenish`/`list`); membership is `configuredRoles` and assignment is a task lease.
- `join`: receive the role prompt and next directive.
- `triage`: inspect architect-actionable blockers.
- `mcp`: run the local stdio MCP server.
- `roles`: list configured registry roles.
- `role`: inspect one configured registry role.
- `soul`: render a role's startup brief from its `directives.implement` skills.
- `skill`: list or inspect configured registry skills.
- `task`: claim, publish, advance, update, release, log, comment, and refresh
  tasks.
- `plan`: architect-owned task graph operations.
- `artifact`: register and review artifacts.
- `summary`: print final run summary.
- `merge`: print post-run merge instructions.

## Folder Store And Projection

The folder store lives under `.multi-code/sprintengine/<team>/` and contains
`run.yaml`, `events.jsonl`, `projection.json`, status folders under `tasks/`,
status folders under `artifacts/`, `metrics/agent-feedback.jsonl`, and support
folders such as `runner/`, `reviews/`, `validation/`, and `plan-reviews/`.

The projection command is the stable read API:

```bash
sprintengine projection
```

It reads real folder-store files for initialized runs. It includes run
metadata, roster, tasks, board columns, artifacts, lock status, stale-lock
warnings, activity, feedback, ready counts, needs-input counts, run summary
fields, runner policy, and per-task comment context (`latestComments`,
`latestOpenFeedback`, `recordedArtifacts`).

The run store carries a `schemaVersion` (currently `2`). A store written before
MC-1542 is rejected, never migrated: `state_from_folder_store` and
`build_projection` both call `assert_store_is_current`
(`sprintengine_core/store.py`) and raise `RunStoreVersionError`. The projection
re-emits `run.schemaVersion`, so the app rejects a stale `projection.json`
without calling Python (`describeUnsupportedSprintEngineStore`,
`src/main/sprintengine-artifacts.ts`). The remedy is to delete
`.multi-code/sprintengine/<team>/` and re-run the sprint.

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
2. **Routing.** No diff → every phase is skipped and the task lands on `done`
   (the clean-sweep / analysis-only exit). A diff → the task advances to
   `phases[0]`, or to `done` when the task has no phases.

The owner **keeps** the task across that transition. When the task enters a
phase, the composed phase directive is returned inline in the publish response
as `nextDirective` — the owner is mid-tool-call, so there is nothing to paste
and nothing to spawn.

In worktree mode publish also commits task-scoped changes under
`runner/git.commit.lock`, and refuses to publish while a task-adjacent orphaned
change (a changed path owned by no task) is uncommitted.

```bash
sprintengine task publish --task-id T3 --id developer-1 --summary "Added the phase-routing branch and its regression tests." --path sprintengine_core/tool/tasks.py
```

Response fields: `nextStatus`, `previousStatus`, `producedChanges`, `phases`,
`nextDirective` (only when the task entered a phase), `committed`, `commitSha`.

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

### `task request-changes` / `task approve-rework`

An independent phase reviewer can return its owned target to implementation:

```bash
sprintengine task request-changes --task-id T3 --id developer-reviewer-1 --feedback "The IPC handler is wired but the renderer never consumes its result." --path src/main/ipc/example.ts
```

The target returns to `todo` with its last implementer as a dispatch preference. A re-publish always enters `review`, even with no new diff, and restores the exact requesting phase reviewer; only that reviewer can approve through `task advance`.

A sweep or final-review task requests changes cross-task by naming the active source it owns. The source must depend transitively on the target and cannot complete while the request remains open:

```bash
sprintengine task request-changes --task-id T3 --source-task-id T9 --id spec_reviewer-1 --feedback "The declared consumer is not wired."
sprintengine task approve-rework --task-id T3 --source-task-id T9 --id spec_reviewer-1 --summary "Consumer path is connected and the regression passes."
```

If the stored requester cannot be restored, the planner replaces it explicitly;
approval authority is never inherited from a role or recovered source lease:

```bash
sprintengine task reassign-review --task-id T3 --id architect --reviewer-id spec_reviewer-2 --reviewer-role spec_reviewer --reason "Original reviewer session cannot be restored."
```

`task.log` remains advisory telemetry. Only `task request-changes` changes lifecycle. A missing task, invalid decomposition, or multi-target repair goes directly to planner `needs_input`; repeated rejection beyond the run policy's cycle cap does the same.

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
sprintengine artifact add --task-id T1 --kind architect_plan --title "Architect plan" --path .multi-code/sprintengine/team/plan.md --created-by architect
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
agent terminal. Multicode may wake or focus terminals after Sprint Engine
records notification, dispatch, or rework state, but direct MCP notifications
are not assumed to wake Codex or Claude sessions by themselves.

## Runner Policy

The durable runner policy lives in `run.yaml` and is exposed in projection:

```bash
sprintengine runner status
sprintengine runner set --mode auto
sprintengine runner set --mode off
```

Standalone/headless CLI agents can start and continue with `join --watch`.
When Auto Mode is on, `join --watch` sleeps and polls under the CLI until work
is available or Auto Mode is turned off. When Auto Mode is off, idle CLI agents
stop.

Multicode-launched autonomous roster agents use the managed Sprint Engine MCP
server instead. Their startup and wake prompts call `sprintengine.agent.join`
and `sprintengine.agent.next_directive`; if a directive includes
`nextMcpToolName`, the agent invokes that MCP tool once with
`nextMcpArguments`. Multicode owns later continuation, terminal wake/resume,
and replacement spawning for ready work, owner re-engagement after human
feedback, and `needs_input` recovery.

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
.multi-code/sprintengine/team/reviews/code-review.md
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
