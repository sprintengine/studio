# Sprint Engine Schema

Sprint Engine is the execution-native core for local specialist runs. Milestone
01 keeps the schema deliberately close to the existing `swarm/<team>/state.yaml`
shape so Swarm compatibility can load current runs without migration.

The core schema lives in `sprintengine_core/schema.py`. Every object exposes
`to_dict()` and returns a deterministic, JSON-compatible dictionary with stable
field order.

## Top-Level State

`SprintEngineState`:

- `schemaVersion`: integer schema version.
- `run`: `SprintRun` metadata.
- `tasks`: ordered list of `SprintTask` objects.
- `artifacts`: ordered list of `SprintArtifact` objects.
- `agents`: ordered list of `SprintAgent` objects.
- `events`: append-only ordered list of `SprintEvent` objects.
- `specialistRoles`: role registry references used by execution tasks.
- `autoRun`: optional `AutoRunState`.
- `source`: optional `SourceMetadata`.

## Run

`SprintRun` identifies a run independently from its backing file.

- `id`: canonical run id. Current Swarm-backed runs use `sprint:<team-slug>`.
- `name`: display name or team slug.
- `goal`: execution goal.
- `status`: run phase such as `planning`, `planned`, `executing`, or
  `completed`.
- `updatedAt`: UTC ISO timestamp when known.
- `source`: optional source metadata.

## Tasks

`SprintTask` is the canonical execution unit.

- `id`, `title`, `description`: task identity and brief.
- `role`: specialist role id.
- `status`: one of `todo`, `in_progress`, `needs_input`, `done`.
- `ownerAgentId`: agent id currently responsible for active work, or null.
- `dependsOn`: task ids that must be done before this task is ready.
- `ownedPaths`: project-relative file or directory paths that define the
  task's primary edit surface and collision boundary. Workers should prefer
  these paths, but small directly required companion edits may be logged as
  evidence scope expansions when they are needed for correctness, integration,
  type safety, tests, or cleaner structure.
- `acceptanceCriteria`: behavior that must be proven before completion.
- `implementationNotes`: task-scoped guidance.
- `evidence`: summary, touched files, commands, and results.
- `notes`: human or agent notes.
- `needsInput`: optional routing metadata for `needs_input` tasks.
  `kind` is one of `architect`, `user`, `artifact`, `tooling`,
  `verification`, or `other`; `question` records the blocker;
  `suggestedResolution`, `reportedBy`, and `reportedAt` are optional.
- `learnedFacts`: execution facts discovered while doing the task.
- `blockers`: concrete unresolved or resolved execution blockers.
- `startedAt`, `completedAt`: UTC ISO timestamps or null.
- `source`: optional source metadata.

Readiness is derived, not stored: a task is ready when it is `todo`, has no
owner, and all dependencies are `done`.

Sprint Engine does not add Multiloop planning fields to tasks. Planning state,
roadmaps, milestones, entitlements, desktop login, and app-only automation
policies stay outside the core schema.

## Evidence And Reports

`Evidence` mirrors current Swarm task evidence:

- `summary`
- `touchedFiles`
- `commandsRan`
- `results`
- `scopeExpansions`: optional structured records for touched files outside
  `ownedPaths`, each with `path`, `reason`, and optional `risk`.

`SprintReport` is the export payload for read/status/report commands:

- `runId`
- `generatedAt`
- `summary`
- `evidence`
- `source`

## Artifacts

`SprintArtifact` represents reviewable or durable task output.

- `id`
- `kind`: one of `architect_plan`, `product_strategy`, `requirements`,
  `html_mockup`, `design_notes`, `branding`, `security_review`, `code_review`,
  `spec_review`, `performance_review`, `validation_report`.
- `title`
- `path`: project-relative artifact path.
- `status`: one of `draft`, `ready_for_review`, `approved`,
  `changes_requested`, `superseded`.
- `createdBy`
- `taskId`
- `reviewHistory`: ordered review transitions.
- `recommendedTasks`: follow-up task descriptions or ids.
- `approvedBy`
- `source`

`ReviewHistoryEntry` records `action`, `actor`, `timestamp`, and optional
`feedback`.

## Agents

`SprintAgent` records execution slots:

- `id`
- `role`
- `status`: one of `idle`, `running`, `needs_input`, `done`.
- `currentTaskId`
- `source`

## Events

`SprintEvent` is append-only execution history:

- `id`
- `timestamp`
- `type`
- `actor`
- `message`
- `taskId`
- `artifactId`
- `source`

## Specialist Role References

`SpecialistRoleRef` points at canonical role registry entries:

- `id`
- `label`
- `promptPath`
- `expectedArtifactKinds`
- `stopConditions`

Milestone 01 uses Souls (`souls/prompts/*.md`) as the role prompt source. The
execution schema must not load Sprint Engine roles from Multiloop prompt context.

## Auto-Run State

`AutoRunState` models local execution status only:

- `status`: one of `idle`, `running`, `paused`, `stopped`, `completed`,
  `failed`.
- `enabled`
- `requestedBy`
- `startedAt`
- `stoppedAt`
- `lastError`
- `source`

Terminal spawning and desktop access policy remain in the app boundary, not in
Sprint Engine core.

## Source Metadata

`SourceMetadata` describes where an object came from:

- `format`: for example `swarm-state`.
- `path`: project-relative source path where practical, such as
  `swarm/01-shared-domain-cli-readonly/state.yaml`.
- `keyPath`: path inside the source document, such as `tasks[2]`.
- `version`: source schema version when known.

Persisted and reported paths should be project-relative. Absolute or
machine-specific paths should be converted before they enter schema output.

## Swarm Compatibility

Current `swarm/<team>/state.yaml` maps directly:

- `swarm` -> `SprintRun`
- `tasks[]` -> `SprintTask[]`
- `artifacts[]` -> `SprintArtifact[]`
- `agents{}` -> `SprintAgent[]`
- `events[]` -> `SprintEvent[]`
- task `evidence` -> `Evidence`
- task `notes`, `startedAt`, and `completedAt` keep their current meaning

Swarm state remains the backing store for Milestone 01. Sprint Engine read-only
commands should load this file and serialize canonical objects without rewriting
state or updating timestamps.
