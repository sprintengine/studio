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
    testing/
    product/
    changes_requested/
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
  plan-reviews/
  reviews/
  validation/
  runner/
```

Folder-store files are not safe manual editing surfaces. Human/debug/headless
operators can use commands such as `sprintengine join --watch`,
`sprintengine task next`, `sprintengine task log`, `sprintengine task status`,
`sprintengine artifact add`, and `sprintengine runner set`. Multicode-launched
autonomous agents use the managed Sprint Engine MCP server instead of CLI
commands.

## `run.yaml`

`run.yaml` stores compact run metadata and graph mirrors:

- `schemaVersion`: folder-store schema version.
- `name`: team display name.
- `goal`: run goal.
- `status`: run status such as `planning` or `executing`.
- `rosterConfigured`: whether the run has an explicit role roster.
- `graphPolicy`: graph/readiness policy metadata.
- `qualityPolicy`: roster-driven quality gate defaults and lifecycle policy.
- `tasks`: compact task graph entries with `id`, `status`, `role`, and
  `dependsOn`. Each graph entry also carries `needsTriage`, defaulting to
  `false` when absent.
- `artifacts`: compact artifact entries with `id`, `status`, `kind`, and
  `taskId`.
- `runner`: durable runner policy (`auto` or `off`) plus polling
  and completion settings.
- `agents`: durable agent lifecycle records keyed by stable agent id.
- `creation`: run creation metadata such as source and timestamp.
- `updatedAt`: UTC timestamp of the latest store sync.

The graph mirror lets readiness refresh validate dependency references and
cycles without requiring consumers to parse every task folder.

## Role Registry Boundary

Sprint Engine roles are registry-backed. Tasks and gates store role ids as
strings, and active CLI/MCP validation resolves those ids through
`sprintengine_core.role_registry` and the role helper layer in
`sprintengine_core/tool/roles.py`. The registry discovers role manifests and
Soul skills from workspace, plugin, user, and bundled sources. Aliases resolve
to canonical ids before task, gate, roster, join, and plan operations mutate
state.

The bundled-role compatibility set and renderer label/accent defaults are not
runtime dispatch authority. They exist for older callers, specialist UI
defaults, and graceful display fallbacks. Registry metadata in projection and
MCP discovery is the path for custom role labels, summaries, icons, aliases,
source layers, and warnings.

Role manifest `soul` arrays contain ordered skill entries only:
`{ "skill": "<id>" }`. Inline text entries such as `{ "text": "..." }` are
not part of the current schema and are rejected by registry validation.

Role manifests may include optional declarative `capabilities`. Capabilities
describe what a role can do; they do not make any review globally required.
Current production support recognizes `kind: "review"` with optional `phase`
(`review`, `testing`, or `product`), `reviews` tags, and `defaultFocus`.
Architect planning remains the authority for whether a capability becomes a
task quality gate. For example, `sprintengine plan add-task --require-gate
creative_director` can create a task-specific gate for a custom role whose
manifest declares a review capability, while a custom role without that
capability is not silently treated as a gate.

Prompt composition is layered:

1. Registry-rendered Soul from a role manifest and its ordered skill entries.
2. Sprint Engine coordination rules selected by the dispatch kind.
3. Runtime directive from `join --watch`, MCP lifecycle tools, or the active
   task/gate payload.

### Agent Records

`run.yaml` `agents` is the lifecycle mirror used by MCP dispatch, CLI
compatibility, projection, and Multicode terminal wake/resume orchestration. It
is keyed by stable Sprint Engine agent id, such as `developer-1`. The map is
owned by Sprint Engine commands and the local MCP server; manual edits can leave
task ownership, gate attempts, projection, and dispatch ledger state
inconsistent.

Each agent record normalizes to:

- `role`: canonical role id assigned to the agent.
- `status`: `idle`, `running`, `needs_input`, `left`, `dead`, or `retired`.
  Active dispatch is represented by `currentDispatch` and
  `sprintengine.dispatch.next` state, not by a persisted agent status value.
- `heartbeatAt`: UTC timestamp of the latest heartbeat observed through
  `sprintengine.agent.heartbeat` or a compatibility join refresh.
- `joinedAt`: UTC timestamp when the agent first joined this run.
- `leftAt`: UTC timestamp for a graceful leave, when present.
- `deadAt`: UTC timestamp set by liveness reconciliation, when present.
- `subscription`: dispatch subscription metadata with `mode` (`none`, `poll`,
  or `mcp_notifications`), `subscribedAt`, optional `lastDispatchId`, and ack
  mirrors such as `lastDispatchAckAt` and `lastDispatchOutcome`.
- `currentDispatch`: current durable dispatch target, when assigned.
- `currentTaskId`: compatibility mirror for an active normal task.
- `currentGate`: compatibility mirror for an active gate claim, normally with
  `taskId`, `gateId`, and attempt id.
- `currentGateId`: compatibility mirror for the active gate id, when present.
- `lastDirectiveAt`: UTC timestamp for the latest directive returned to or
  recorded for the agent.

`currentDispatch` records:

- `dispatchId`: stable idempotency key from `dispatch.jsonl`.
- `targetKind`: currently `task` or `gate` for active assignments; future
  server-created targets may use values such as `architect_judgment` or `run`.
- `taskId`: present for task and gate targets.
- `gateId`: present for gate targets.
- `role`: target role used for routing.
- `reason`: dispatch reason such as `task_claimed`, `gate_claimed`,
  `needs_triage`, or `final_review`. Normal unclaimed ready tasks, including
  ownerless `changes_requested` rework, are wake candidates and must not be
  represented as `currentDispatch` assignments.
- `assignedAt`: UTC timestamp of assignment.

Agents and app code must not edit this map directly. Use the lifecycle tools or
the CLI compatibility commands so store locks, task ownership, events,
projection sync, and dispatch ledger writes remain coherent.

## Dispatch Ledger

`dispatch.jsonl` is an append-only sibling of `events.jsonl`. It records durable
dispatch assignments with an idempotency key. Acknowledgement and subscription
state is mirrored on the agent record and in normal events; consumers should use
Sprint Engine tools or projection fields instead of parsing or editing the file
directly.

Durable dispatch assignments are created for claimed tasks, claimed quality
gates, rework directed back to the task owner, and explicit
`currentDispatch` targets. Renderer prompts for unclaimed ready tasks or
unclaimed gates are wake candidates only: they may wake an available live agent
to call the direct claim tool, but they do not write `currentDispatch`, append
`dispatch.jsonl`, or mutate canonical task or gate state before the claim tool
claims.

Each line is a JSON object with:

- `id`: stable dispatch id derived from the target and assignment context.
  Replaying, reconnecting, or re-notifying the same assignment reuses this id
  and must not double-assign work.
- `timestamp`: UTC timestamp for the ledger entry.
- `agentId`: target agent id.
- `role`: canonical role requested by the target.
- `target`: object with `kind`, optional `taskId`, optional `gateId`, and
  optional attempt id.
- `reason`: why the scheduler selected the target.
- `state`: snapshot fields needed for idempotency, currently including
  `taskStatus` and `gateStatus` where relevant.
- `outcome`: currently `dispatched` for assignment records; future terminal
  records may use values such as `acknowledged`, `canceled`, `released`, or
  `superseded`.
- `source`: currently `core` for assignments produced by the shared
  Sprint Engine core path. Future transports may identify `mcp`, `cli_compat`,
  or `system`.

`sprintengine.dispatch.next` is the read contract for this ledger. It requires
an `agentId`, returns the agent's `currentDispatch`, and filters ledger rows by
that same `agentId` before applying `lastDispatchId` pagination — when the
caller omits `lastDispatchId`, the cursor defaults to the acked
`agents.<id>.subscription.lastDispatchId`, so a subscribed agent replays only
the delta since its own ack. A cursor that matches no ledger row (mistyped
ack, pruned `dispatch.jsonl`) falls back to the full capped history instead
of an empty reply, so a poisoned cursor self-heals. Over MCP the replayed
rows are slim stubs in the `currentDispatch` field dialect (`dispatchId`,
`targetKind`, `taskId`/`gateId`/`attemptId`, `reason`, `assignedAt`), capped
at the newest `DISPATCH_REPLAY_LIMIT` (20) with `truncated`/`totalCount` when
older rows are dropped; the on-disk ledger keeps the full record shape.
`sprintengine.dispatch.ack` records acknowledgement metadata on
`agents.<id>.subscription` and appends a normal event; it does not rewrite
`dispatch.jsonl`. Its MCP response is the minimal ack
`{ok, dispatchId, outcome}` echoing the values the server persisted (not the
raw payload); `sprintengine.subscribe` answers `{ok, subscription}`, and
`sprintengine.agent.heartbeat` answers the pure-liveness ack `{ok, known}` —
heartbeat never conveys assignment state; agents learn assignments from
`dispatch.next` (`currentDispatch`) and `task.next` resume
(`sprintengine_mcp/response_shapes.py`).

Dispatch is durable state, not a guarantee that a model session woke up.
Multicode remains responsible for spawning, focusing, or injecting terminal
input for current CLIs. MCP notifications and subscriptions are allowed as
observability and future transport, but correctness must come from reconciling
agent records and dispatch ids.

## MCP Tool Contract

The final MCP v1 surface is schema-first in `sprintengine_mcp/schemas.py`.
Lifecycle, discovery, dispatch, task, gate, artifact, plan, run, and support
operations all use structured JSON schemas. Final contract schemas are exposed
separately from the active `TOOL_SCHEMAS` registry so `list_tools` advertises
only operations with server handlers. Future names move into active
`TOOL_SCHEMAS` when their handlers land.

Final lifecycle and dispatch names:

- `sprintengine.agent.join`
- `sprintengine.agent.heartbeat`
- `sprintengine.agent.leave`
- `sprintengine.subscribe`
- `sprintengine.dispatch.next`
- `sprintengine.dispatch.ack`

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
  `sprintengine.task.publish`, `sprintengine.task.request_changes`.
  `sprintengine.task.request_changes` records ordinary rework feedback and
  routes the task to `changes_requested`; routed blockers use
  `sprintengine.task.status` with `status: needs_input`.
- Gates: `sprintengine.gate.list`, `sprintengine.gate.next`,
  `sprintengine.gate.claim`, `sprintengine.gate.verdict`. The former
  `gate.publish` and `gate.skip` aliases were removed; a skip is
  `gate.verdict` with `verdict: "skipped"`, which records the summary as the
  skip rationale.
- Artifacts: `sprintengine.artifact.add`, `sprintengine.artifact.ready`,
  `sprintengine.artifact.approve`, `sprintengine.artifact.request_changes`,
  `sprintengine.artifact.list`.
- Plans: `sprintengine.plan.add_task`, `sprintengine.plan.update_task`,
  `sprintengine.plan.delete_task`, `sprintengine.plan.add_dependency`,
  `sprintengine.plan.remove_dependency`, `sprintengine.plan.start_review`,
  `sprintengine.plan.review_status`, `sprintengine.plan.address_reviews`.
- Run: `sprintengine.run.get`, `sprintengine.run.policy.get`,
  `sprintengine.run.subscribe`. The run projection is deliberately not an MCP
  tool: it exists for the UI, which reads `projection.json` from disk, and
  over MCP it returned more tokens than an agent context window. The CLI
  `projection` command is unaffected.
- Support: `sprintengine.init`, `sprintengine.recover`, roster tools,
  `sprintengine.summary`, feedback tools, and `sprintengine.health`.

MCP response contract (`sprintengine_mcp/response_shapes.py`): MCP responses
carry deltas and references, not state echoes — the run store stays the source
of truth and the UI keeps reading it from disk. Mutation tools (`task.log`,
`task.publish`, `task.status`, `gate.verdict`, `plan.add_task`, artifact
review, and the rest of `MUTATION_ACK_TOOLS`) return acks with `taskId`,
`taskStatus`, the event, and any progression/continuation fields instead of
the full task. Acks include an `openFeedback` delta (newest open feedback and
user notes, newest first) so a working agent still notices comments posted
mid-task. Read tools (`task.next`, `task.claim`, `gate.next`, `gate.claim`,
`task.get`) return a slim task card without `activity`, full `comments`,
full `notes`, full `needsInput.resolution`,
`evidence.commandsRan`/`results`, or `evidence.diffs`; default cards include
only bounded newest notes and bounded needs-input prose. `task.get` accepts
`include: ["activity", "comments", "evidence_log", "diffs", "notes",
"needs_input"]` for deep reads.
Directives carry `{id, title, status, role}` stubs. Server-composed review and
rework prompts are built from full store state and are unaffected. The
human/debug CLI keeps full command output shapes. Response-shape regression
tests live in `tests/sprintengine_tool/test_response_shapes.py`.

Role capability policy (`sprintengine_mcp/capabilities.py`): one role→tool
table is consumed by both sides of the contract — `tools/list` filters the
advertised schemas by the session's role, and every call is checked against
the same table, failing with `tool_not_permitted_for_role` (naming the role
and, where known, the permitted alternative) when a hidden tool is called by
name. Classification derives from the role registry, not hardcoded ids, so
plugin roles participate: `architect` (registry-normalized id) gets the
planning surface, any role whose manifest declares a `review` capability gets
the rework-request privileges (`task.request_changes`,
`artifact.request_changes` — this is why
`resources/sprintengine/roles/product.json` declares
`{"kind": "review", "phase": "product"}`), every other resolvable or unknown
role gets the worker surface, and the operator (`role: "user"`, the app's IPC
actor, the human/debug CLI, and stdio sessions) keeps the full surface. Gate
tools (`gate.list/next/claim/verdict`) are in the common agent surface, not
reviewer-only: quality gates carry their own role (a `frontend_review` gate
is claimed by the frontend worker), and `gate_is_claimable_for_role` is the
authority for who may claim a gate. The session role comes from agent-scoped HTTP run registrations: the
app registers each agent terminal with `agentId` + `role`
(`src/main/sprintengine-mcp-hub.ts` → `POST /runs`), and the returned token
binds that terminal's MCP session to the role. Registrations without
`agentId`/`role` stay run-scoped (operator surface), which keeps older
callers working. Capability tests live in
`tests/sprintengine_tool/test_capabilities.py`.

Compatibility names:

- `sprintengine.join` remains a compatibility alias for the agent join
  behavior used by `sprintengine join --watch`. It must keep the current CLI
  response shape while sharing lifecycle state with `sprintengine.agent.join`.
  It is operator-only under the capability policy: autonomous agents never see
  it. Managed Multicode prompt flows use `sprintengine.agent.join` followed by
  the direct claim tool named in the runtime prompt; `agent.next_directive`
  survives for standalone/headless compatibility only.
- CLI wrapper flows still use `sprintengine.task.next`,
  `sprintengine.task.claim`,
  `sprintengine.task.note`, `sprintengine.task.resolve_input`,
  `sprintengine.task.release`, `sprintengine.gate.next`,
  `sprintengine.gate.claim`, and `sprintengine.gate.verdict` while preserving
  the same core mutation path.

Transition tests must prove that `sprintengine.join` does not duplicate
dispatch ledger entries, returns active work before claiming new work, records
or refreshes the same agent lifecycle fields as the final join path, treats
unclaimed ready tasks as wake candidates until claim time, and returns idle
without mutation when Auto Mode is off and no target is available.

## Task Files

Task JSON files live under `tasks/<folder-status>/`. Folder location is the
materialized board column; the embedded `status` field mirrors that folder for
display and validation. Folder/status columns, claimability, and quality
requirements are related but distinct:

- Folder/status columns show where the task sits on the board.
- Claimability is computed from dependencies, ownership, dispatch, and status.
- Quality requirements live in `qualityGates`; a task in `review`, `testing`,
  or `product` can have several independent gates open at once.

A task in `tasks/ready/` can include `stateStatus` to show the semantic status,
usually `todo`. A task whose semantic status is `changes_requested` stays in
`tasks/changes_requested/`; it remains claimable but is not flattened into
normal ready work.

Supported task folders are:

- `todo`
- `ready`
- `in_progress`
- `review`
- `testing`
- `product`
- `changes_requested`
- `needs_input`
- `done`
- `canceled`

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
- `qualityGates`
- `dispatch`
- `needsTriage`
- `needsInput`
- `feedback`
- `difficulty`
- `startedAt`, `completedAt`
- `activity`

`difficulty` is optional so old task records do not require migration. Task-local
state uses existing camelCase conventions:

- `architectEstimatePct`, `architectEstimateReason`
- `implementerActualPct`, `implementerActualReason`
- `reviewerAssessments`: append-only reviewer entries with `pct`, `dimension`,
  `reason`, `reviewerAgentId`, `reviewerRole`, `gateId`, `gateAttemptId`, and
  `capturedAt`

Difficulty percentages must be integer values from `0` to `100`; booleans are
invalid. Reviewer assessment `dimension` must be one of `implementation`,
`review`, `verification`, `product_spec`, `security`, `performance`, or
`coordination`.

`ownedPaths`, evidence files, artifact paths, review paths, and notes must use
project-root-relative paths. Do not write absolute paths or machine-specific
paths into task records or evidence.

## Role Registry And Routing

Task roles, roster roles, plan-review roles, and quality-gate roles are
configured data. CLI role arguments are parsed as strings and then canonicalized
through the role registry, including aliases and hyphen/underscore variants
supported by the registry. Unknown roles are rejected at command boundaries once
the registry can prove they are unknown.

When `rosterConfigured` is true, task and gate targets must also be present in
the active roster. Normal task dispatch routes by exact canonical `task.role`.
Quality-gate dispatch routes by exact canonical `qualityGates[].role`. The core
does not infer routing from role capabilities such as implementer, reviewer, or
tester flags.

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

## Quality Policy And Gates

`run.yaml` stores `qualityPolicy` for roster-driven quality behavior:

- `enabled`: whether default gate derivation is active.
- `rosterDriven`: whether missing roster roles should be skipped instead of
  creating dead queues.
- `lifecyclePhases`: normally `review`, `testing`, and `product`.
- `gates`: default gate definitions keyed by gate id. Each definition includes
  `phase`, `role`, `required`, and `focus`. Bundled defaults include
  `code_reviewer`, `nuclear_reviewer`, `spec_reviewer`, `tester`, and
  product/architect gates; custom configured gate ids are preserved when they
  name a valid phase and role.

Task `qualityGates` entries normalize to:

- `id`: stable gate id such as `code_reviewer`, `nuclear_reviewer`,
  `spec_reviewer`, `tester`, `architect_review`, or a custom registry-backed
  gate id.
- `phase`: `review`, `testing`, or `product`.
- `role`: reviewer/tester/product role that can claim the gate.
- `status`: `pending`, `in_progress`, `approved`, `changes_requested`,
  `blocked`, or `skipped`.
- `required`: whether the phase must wait for this gate to become `approved` or
  `skipped`.
- `allowSelfReview`: whether the task owner may claim the gate.
- `focus`: gate-specific review guidance.
- `attempts`: gate claim/verdict history.
- `skipRationale`: present when a gate is skipped.

Gate attempts record durable reviewer activity:

- `id`: `GA-001`, `GA-002`, and so on within the gate.
- `status`: current or final verdict status.
- `role`, `claimedBy`
- `startedAt`, `completedAt`
- `summary`
- `artifactId`: optional recorded artifact linked to the verdict.

Gate claiming is separate from task claiming and uses
`runner/gate.queue.lock`. The task remains in its lifecycle folder while gate
attempts are claimed and completed.

Gate lifecycle is phase-driven. A gate's `phase` (`review`, `testing`, or
`product`) determines which lifecycle step it blocks and where the task advances
after approval; `role` only determines which configured roster role can claim
the gate.

Approved and skipped verdicts advance a phase only after all remaining required
gates in that phase are `approved` or `skipped`. `changes_requested` and
`failed` verdicts route the task to `changes_requested` with open feedback.
`blocked` verdicts route the task to `needs_input`.

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
structured `data`. Publish commands create implementation summary/response
comments. Gate verdicts create feedback or needs-input comments. Open feedback
comments use `data.status = "open"` and should be surfaced newest first for
rework.

Agent feedback is attached to task records and also exported to
`metrics/agent-feedback.jsonl`. Metrics records use JSON Lines so each feedback
payload is append-friendly and durable across syncs.

When a task has difficulty metadata and feedback is recorded, feedback metrics
include a `difficulty` snapshot using snake_case analytics keys:

- `architect_estimate_pct`, `architect_estimate_reason`
- `implementer_actual_pct`, `implementer_actual_reason`
- `reviewer_assessments`: reviewer assessment entries with `pct`, `dimension`,
  `reason`, `reviewer_agent_id`, `reviewer_role`, `gate_id`,
  `gate_attempt_id`, and `captured_at`

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
  findingsAgainst?, taskCounts? }` — derived from `reviewer_assessment` /
  `gate_verdict_assessment` records and attributed to the implementer via
  `review_target_agent_id` (never the reviewer). `counts` uses camelCase keys
  (`regressionCount`, `missedRequirements`, …); `hallucinationRatePct` is
  emitted only when `claimsChecked > 0`; `findingsAgainst` only when defects
  exist (so the consumer can show `0` when a review happened with no defects vs
  `—` when no review happened). `taskCounts` is the per-task drill-down detail,
  keyed by task id: `{ reviewSampleCount, counts }` (defect counts only —
  `claimsChecked` is excluded). Finding prose is NOT included here (kept in the
  projection) so the analysis output stays a sanitized aggregate.
- `findingsRaised`: count of findings the agent authored while reviewing.

The run-summary panel consumes this via the read-only
`sprintengine:feedback:summarize` IPC and joins it against the roster + local
task counts; agents with no records simply have no `aggregateByAgent` row.

## Needs Input

`needsInput` routes blocked work:

- `kind`: actor or external condition that must act, normally `architect`,
  `user`, `owner`, or `external_validation`.
- `reason`: short category or issue text. Common categories are `task_scope`,
  `artifact_review`, `tooling`, `verification`, `product_decision`, and
  `blocked_other`.
- `question`: concrete unblock question.
- `suggestedResolution`: optional proposed next step.
- `artifactId`: optional artifact related to an artifact review blocker.
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
- `gateId`: optional gate id for recorded gate evidence.

Register artifacts through `sprintengine artifact add`, `sprintengine artifact
ready`, `sprintengine artifact approve`, or `sprintengine artifact
request-changes`.

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

`recorded` artifacts are durable gate evidence. They are visible in task
projection data but do not enter human approval queues and do not block task
completion by themselves. Use `ready_for_review` only for artifacts that require
human approval.

## Events

`events.jsonl` is append-only run history. Each line is a JSON object, normally
with:

- `id`
- `timestamp`
- `type`
- `actor`
- `message`
- optional task or artifact metadata

Examples include `task_claimed`, `task_evidence_appended`,
`task_status_changed`, `artifact_added`, `artifact_ready_for_review`,
`artifact_approved`, and `runner_policy_updated`.

## Locks

The folder store is the mutation source. Consumers should read
`projection.json` or `sprintengine projection`, not folder internals.

The store uses lock files to serialize high-risk operations:

- `runner/run.queue.lock`: run-level mutation lock for folder-store writes.
- `runner/ready.queue.lock`: ready queue materialization lock.
- `runner/claim.queue.lock`: narrow queue lock for task claim selection.
- `runner/gate.queue.lock`: narrow queue lock for gate claim and verdict
  selection.
- `runner/run.lock.json`: run-level status marker.
- `runner/ready.lock.json`: ready runner status marker.

Consumers should not inspect lock files directly. `sprintengine projection`
reports lock state and stale-lock warnings in the normalized projection.

## DAG Readiness

`tasks/ready/` is a materialized deterministic queue for normal `todo` work. A
`changes_requested` task uses the same dependency and active-claim readiness
rules but stays in `tasks/changes_requested/` so reviewers, testers, and
product flows can count rework separately. Rework is claimable by any matching
role roster agent when it has no `ownerAgentId`; previous implementer
attribution lives in comments, evidence, and optional attribution fields. A
normal implementation task is claimable when:

- its semantic status is `todo` or `changes_requested`;
- it has no `ownerAgentId`;
- `needsTriage` is absent or `false`;
- its dispatch mode allows dependency readiness;
- every dependency in the run graph is `done`.

An entry in `tasks/ready/` is claimability state, not a durable assignment to a
specific agent. Auto-run renderers may surface it as a wake candidate for a live
agent only when the current projection shows that agent has no active task,
gate, dispatch, or `needs_input` ownership. `task next`, `task claim`, or
`join --watch` must perform the actual claim before any task owner,
`currentDispatch`, or dispatch ledger row is created.

`needsTriage` is a task-card readiness flag, not a replacement for
`needsInput`. Missing `needsTriage` normalizes to `false`. When `true`, the task
remains visible in the `todo` board/projection, is omitted from materialized
ready queues, and cannot be claimed through `task next`, `task claim`,
`join --watch`, or normal dispatch. Clearing it restores normal
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
renderer prompt (`sprintengine.task.next`, `sprintengine.gate.next`, or
`sprintengine.triage.needs_input`) exactly once. The managed server resolves
`statePath` and `workspaceRoot` from run context, so autonomous prompt payloads
omit those fields.

When CLI join directs normal implementation work,
`sprintengine task next --role <role> --id <agent-id>` claims under the
folder-store run lock plus the claim queue lock, prioritizing
`changes_requested` rework before normal ready work without changing its status
until the claim moves it to `in_progress`.

Lifecycle phase tasks are not claimed with `task next` by reviewers or testers.
Use `sprintengine task gate next --role <role> --id <agent-id>` or
`sprintengine task gate claim` to claim a gate attempt while the task remains in
`review`, `testing`, or `product`.

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
- `roster`
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

Each projected task includes gate and comment context for UI/mobile consumers:

- `qualityGates`: normalized gate records.
- `qualityGateSummary`: counts by phase/status plus required/open-required
  totals.
- `comments`: full task comment list.
- `latestComments`: newest comments, bounded for inspector display.
- `latestOpenFeedback`: newest open review/test/product/architect feedback.
- `recordedArtifacts`: recorded artifact references linked to the task.

Projection consumers should use these fields instead of parsing task folders,
artifact folders, metrics files, or comments from folder internals.

## Runner Policy

Runner policy is stored in `run.yaml` and projected under `run.runner`.
For standalone/headless CLI sessions, `off` means `join --watch` returns idle
immediately when no work is ready, and `auto` means `join --watch` sleeps and
polls until work appears, Auto Mode is turned off, the run completes, or a
diagnostic max-wait limit is reached. In Multicode, the runtime owns terminal
dispatch/continuation and restarts missing same-role capacity instead of asking
agents to poll.

## Verification Commands

Use focused backend and app checks when changing this contract:

```bash
python3 -m py_compile sprintengine_core/tool.py sprintengine_core/store.py scripts/sprintengine_tool.py
uv run --with pytest --with PyYAML python -m pytest tests/sprintengine_tool -q
npx esbuild src/main/mobile/sprintengine/snapshot.test.ts --bundle --platform=node --format=cjs --packages=external --outfile=node_modules/.cache/multicode/mobile-sprintengine-snapshot.test.cjs && node node_modules/.cache/multicode/mobile-sprintengine-snapshot.test.cjs
npx esbuild src/main/index.ts --bundle --platform=node --format=cjs --packages=external --outfile=node_modules/.cache/multicode/main-index.check.cjs
```
