# SprintEngine State Schema

The shared Sprint Engine coordination files are:

- `.multi-code/sprintengine/<team-slug>/state.yaml`
  - machine-readable kanban board and run state
- `.multi-code/sprintengine/<team-slug>/handover.md`
  - optional incoming planning context created before the sprintengine architect starts
- `.multi-code/sprintengine/<team-slug>/plan.md`
  - architect-authored final execution plan for that named team
- `.multi-code/sprintengine/<team-slug>/plan-reviews/<agent-id>.md`
  - specialist-authored markdown review of the current architect plan

The Python tool is the preferred write path for `.multi-code/sprintengine/state.yaml`.

Legacy root-level `.multi-code/sprintengine/plan.md` files are not canonical for named runs. Agents should use the active team's `architect_plan` artifact path from state instead.

Use `sprintengine handover --name <team> --goal "..." --handover <path>` to create a named team bootstrap and canonical `handover.md`.
Use `sprintengine handover --name <team> --goal "..." --handover-stdin` when an active planning agent should stream its full handover through the Python tool.
Use `sprintengine summary` to print a read-only completion summary from task evidence.
Use `sprintengine task next --role <role> --id <agent-id>` for normal worker task claiming.
Use `sprintengine task claim --task-id <id> --id <agent-id>` when a specific ready task must be claimed.
Use `sprintengine task status`, `sprintengine task note`, and `sprintengine task log` to update task status, notes, and evidence.
Use `Sprint Engine plan add-task` to build the task board one task at a time while planning.
Use `Sprint Engine plan update-task`, `Sprint Engine plan delete-task`, `Sprint Engine plan add-dependency`, and `Sprint Engine plan remove-dependency` to revise the board during user review.
Use `Sprint Engine plan start-review --role <role> --id <agent-id>` when a specialist should critique the architect plan before execution.
Use `Sprint Engine plan review-status` to summarize expected, missing, stale, and unexpected plan review files.
Use `Sprint Engine plan address-reviews --actor architect` when the architect is ready to revise the plan from specialist feedback.
Use `sprintengine artifact add` to register a review artifact under the active team folder.
Use `sprintengine artifact ready --artifact-id <id> --id <agent-id>` to move an artifact to `ready_for_review` and the linked task to `needs_input`.
Use `sprintengine artifact approve --artifact-id <id> --id <actor>` to approve an artifact and complete the linked task once all non-superseded linked artifacts are approved.
Use `sprintengine artifact request-changes --artifact-id <id> --id <actor> --feedback "..."` to record feedback and reopen the linked task.
Artifact-producing workers register artifacts and stop in `needs_input`; implementation workers wait for approved artifact dependencies before building.
The app uses narrow IPC to request artifact review mutations through the Python tool; workers and renderer code must not edit state files directly.

## Task Card Fields

- `id`
- `title`
- `description`
  - Concrete worker brief copied from the architect plan.
  - Should describe exactly what changes, target behavior, important constraints, and non-goals.
- `role`
- `status`
  - `todo`
  - `in_progress`
  - `needs_input`
  - `done`
- `ownerAgentId`
- `dependsOn`
- `ownedPaths`
  - Files or directories the worker is expected to own for this task.
- `acceptanceCriteria`
  - Repeatable verifiable outcomes for completion.
- `implementationNotes`
  - Repeatable low-level details distilled from `plan.md`, such as functions to update, state transitions, API contracts, edge cases, migration constraints, compatibility requirements, and rollback notes.
- `evidence`
  - `summary`
  - `touchedFiles`
  - `commandsRan`
  - `results`
- `feedback` (optional)
  - Latest agent self-feedback recorded through `sprintengine task status --status done` or `sprintengine artifact ready`.
  - `schemaVersion`: currently `3`.
  - `capturedAt`: UTC ISO timestamp.
  - `source`: currently `agent_self_report`.
  - `agentId`
  - `role`
  - `scores`
    - Optional integer percentage fields from `0` to `100`: `directiveClarityPct`, `taskClarityPct`, `acceptanceCriteriaClarityPct`, `swarmToolEffectivenessPct`, `promptOptimizationPct`, `contextFitPct`, `hallucinationRiskPct`, `roleFitPct`, `autonomyPct`, `confidencePct`.
    - For all fields except `hallucinationRiskPct`, `100` is best. For `hallucinationRiskPct`, `0` is best and `100` is highest risk.
  - `topFriction` (optional, short text)
  - `suggestedImprovement` (optional, short text)
  - `issues` (optional)
    - Prompt/process improvement signals reported by the agent for the user to review.
    - Existing swarms and feedback records may omit this field.
    - `id`
    - `category`: `system_prompt`, `role_prompt`, `task_card`, `acceptance_criteria`, `context`, `tooling`, `coordination`, `validation`, `permissions`, `ui`, or `other`
    - `severity`: `low`, `medium`, or `high`
    - `target` (optional): prompt, template, tool, or process area affected, such as `developer_prompt` or `sprintengine_tool`
    - `title`
    - `detail`
    - `evidence` (optional)
    - `suggestedPromptChange` (optional)
    - `suggestedProcessChange` (optional)
    - `status` (optional): `new`, `reviewed`, `applied`, `rejected`, or `deferred`; omitted values are treated as `new`
  - `findings` (optional)
    - Role-specific review findings reported by agents, such as bugs, security issues, requirement violations, and test gaps.
    - Existing swarms and feedback records may omit this field.
    - `id`
    - `kind`: `code_bug`, `security_issue`, `product_requirement_violation`, `test_gap`, `accessibility_issue`, `performance_issue`, `reliability_issue`, `documentation_gap`, or `other`
    - `severity`: `critical`, `high`, `medium`, or `low`
    - `area`: `frontend`, `backend`, `database`, `networking`, `auth`, `security`, `filesystem`, `cli`, `ipc`, `mobile`, `testing`, `performance`, `docs`, `product`, or `other`
    - `title`
    - `detail`
    - `recommendation` (optional)
    - `requirementId` (optional)
    - `file` (optional)
    - `status` (optional): `open`, `accepted`, `fixed`, `rejected`, or `deferred`; omitted values are treated as `open`
- `notes`
- `needsInput` (optional; set when a task is in `needs_input` and needs routed attention)
  - `kind`: `architect`, `user`, `artifact`, `tooling`, `verification`, or `other`
  - `question`
  - `suggestedResolution` (optional)
  - `reportedBy` (optional)
  - `reportedAt` (optional)
- `startedAt`
- `completedAt`

When feedback is supplied, the tool also appends a normalized record to `.multi-code/sprintengine/<team-slug>/metrics/agent-feedback.jsonl`. This JSONL file is append-only benchmark/analytics history; `task.feedback` is only the latest compact task-linked value for UI and summaries.

## Artifact Fields

Top-level `artifacts` is optional for compatibility. Missing artifact arrays are treated as empty.

- `id`
- `kind`
  - `architect_plan`
  - `product_strategy`
  - `requirements`
  - `html_mockup`
  - `design_notes`
  - `branding`
  - `security_review`
  - `code_review`
  - `spec_review`
  - `performance_review`
  - `validation_report`
- `title`
- `path`
  - Stored as a repository-relative path when possible.
  - Must resolve under the active `.multi-code/sprintengine/<team-slug>/` folder.
- `status`
  - `draft`
  - `ready_for_review`
  - `approved`
  - `changes_requested`
  - `superseded`
- `createdBy`
- `taskId`
- `fingerprint`
- `reviewHistory`
  - `action`
  - `actor`
  - `timestamp`
  - `note`
- `recommendedTasks`
- `createdAt`
- `updatedAt`
- `approvedBy`
- `approvedAt`
- `changesRequestedBy`
- `changesRequestedAt`

## Coordination Rules

- `handover.md` is incoming context from a previous planning agent. The product strategist and architect validate it before creating approved artifacts.
- New sprintengine runs start with a product intake task and a `requirements` or `product_strategy` artifact. If no meaningful product discovery is needed, the artifact should say so and still record goal, non-goals, constraints, and acceptance expectations.
- Architect planning starts after the product intake artifact is approved.
- The active team's `architect_plan` artifact path is the canonical plan path, normally `.multi-code/sprintengine/<team-slug>/plan.md`.
- `plan.md` is architect-owned final execution context for workers and reviewers only when it is under the active team folder. Agents must not find or choose plans by filename search.
- Task cards should contain the relevant distilled plan context. Workers should not need to search `plan.md` to understand the concrete change assigned to them.
- Board `Ready` is derived, not stored as a separate task status.
- A task is ready when:
  - `status` is `todo`
  - all dependencies are `done`
  - `ownerAgentId` is empty
- Only one task should be claimed by a worker at a time; `sprintengine task next` returns the existing active task instead of claiming another one.
- The architect builds and revises the task graph during planning with `Sprint Engine plan` commands.
- Product intake tasks should capture requirements, constraints, non-goals, user impact, and acceptance expectations. Product strategy/positioning work should be added only when the approved intake leaves a concrete product decision unresolved.
- Code review tasks are review-only. They should produce direct review evidence or `code_review` artifacts with findings and recommended follow-up tasks. Code reviewers do not edit application or test code; normal fixes become new architect-created `frontend` or `developer` tasks.
- Spec review tasks verify completed implementation against task descriptions, acceptance criteria, approved requirements, architect plans, comments, and evidence. They should produce direct review evidence or `spec_review` artifacts with requirement-by-requirement conformance, missing requirements, behavioral bugs, test gaps, and recommended follow-up tasks.
- Initial task graphs should include an architect-owned final review scheduling task after implementation, validation, and code review. That scheduler reads the completed evidence and adds only the needed product, security, and performance final review tasks, with explicit skip rationale for unneeded reviews.
- Product final acceptance review tasks should be scheduled when the work is product-facing, changes user-visible behavior, changes requirements interpretation, or when code review/validation raises acceptance uncertainty.
- Security review tasks should be scheduled when work touches auth, permissions, IPC, command execution, filesystem boundaries, network/relay surfaces, secrets/tokens, HTML rendering, sandboxing, dependency risk, or when code review raises a security-adjacent concern.
- Performance review tasks should be scheduled only after relevant code review evidence exists and should run when the work touches startup, hot paths, rendering scale, polling, filesystem/search/git traversal, command loops, memory growth, bundle/runtime resource usage, or when code review/validation raises a performance concern. They produce direct review evidence or `performance_review` artifacts with measured evidence where practical, clearly labeled hypotheses where not, findings, and recommended follow-up tasks.
- Workers should not rewrite the plan or change other workers' task cards.
- Review artifact lifecycle mutations must go through `sprintengine artifact` commands.
- `sprintengine init` creates or reuses a product intake approval task and artifact, plus a blocked architect plan approval task and `architect_plan` artifact for the active team's `plan.md`.
- Product intake tasks must move their artifact to `ready_for_review` and block architect planning until approved.
- Architect plan tasks must register the active team's `plan.md` as an `architect_plan` artifact, move to `needs_input`, and block downstream work until approved.
- Product strategy and requirements gate tasks should register `product_strategy` or `requirements` artifacts, move to `needs_input`, and block dependent implementation until approved.
- Frontend mockup/design gate tasks should register `html_mockup` or `design_notes` artifacts, move to `needs_input`, and block production UI implementation until approved.
- Downstream implementation tasks should depend on the producing gate task ids, not only mention artifact paths in notes.
- Review artifacts may include `recommendedTasks`; the architect decides whether to convert those recommendations into task cards.
- `artifact ready` moves the linked producing task and owning agent to `needs_input`.
- `artifact approve` marks the linked task `done` only when every non-superseded artifact for that task is `approved`.
- `artifact request-changes` stores feedback in task notes and reopens the producing task without changing unrelated tasks.

## Plan Review Flow

1. Architect finishes a draft `plan.md` in the active team folder and task graph.
2. Specialist runs `Sprint Engine plan start-review --role <role> --id <agent-id>`.
3. Specialist writes or replaces `plan-reviews/<agent-id>.md` using the returned prompt.
4. Architect runs `Sprint Engine plan address-reviews --actor architect`.
5. Architect updates the active team's `plan.md` directly and updates task cards only through `Sprint Engine plan` commands.

Review files include the current plan fingerprint. If `plan.md` changes after a review, `Sprint Engine plan review-status` marks that review stale.
