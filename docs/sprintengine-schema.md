# Sprint Engine Schema

Sprint Engine is Multicode's local execution authority for specialist runs.
Current runs use a folder-backed store under `.multi-code/sprintengine/<team>/`.
The compatibility `state.yaml` file can still exist during staged migration, but
new coordination code should treat the folder store and normalized projection as
the durable read contract.

Agents and app code must not hand-edit Sprint Engine store files. Mutations go
through the Sprint Engine CLI/tool boundary so locking, ready queue refresh,
activity, artifacts, events, metrics, and projections stay coherent.

## Run Store Layout

Each team folder contains these store files and directories:

```text
.multi-code/sprintengine/<team>/
  state.yaml
  run.yaml
  projection.json
  events.jsonl
  metrics/agent-feedback.jsonl
  tasks/
    todo/
    ready/
    in_progress/
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

`state.yaml` is the legacy compatibility file. It is not a safe manual editing
surface. Folder-store files are also not safe manual editing surfaces. Use
commands such as `sprintengine task next`, `sprintengine task log`,
`sprintengine task status`, `sprintengine artifact add`, and
`sprintengine migrate`.

## `run.yaml`

`run.yaml` stores compact run metadata and graph mirrors:

- `schemaVersion`: folder-store schema version.
- `name`: team display name.
- `goal`: run goal.
- `status`: run status such as `planning` or `executing`.
- `rosterConfigured`: whether the run has an explicit role roster.
- `graphPolicy`: graph/readiness policy metadata.
- `tasks`: compact task graph entries with `id`, `status`, `role`, and
  `dependsOn`.
- `artifacts`: compact artifact entries with `id`, `status`, `kind`, and
  `taskId`.
- `migration`: source, backup path, counts, timestamps, and compatibility
  metadata when the run has been migrated from `state.yaml`.
- `updatedAt`: UTC timestamp of the latest store sync.

The graph mirror lets readiness refresh validate dependency references and
cycles without requiring consumers to parse every task folder.

## Task Files

Task JSON files live under `tasks/<folder-status>/`. Folder location is the
materialized board column; the embedded `status` field mirrors that folder for
display and validation. A task in `tasks/ready/` can include `stateStatus` to
show the semantic status, usually `todo`. A task whose semantic status is
`changes_requested` stays in `tasks/changes_requested/`; it remains claimable
but is not flattened into normal ready work.

Supported task folders are:

- `todo`
- `ready`
- `in_progress`
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
- `dispatch`
- `needsInput`
- `feedback`
- `startedAt`, `completedAt`
- `activity`

`ownedPaths`, evidence files, artifact paths, review paths, and notes must use
project-root-relative paths. Do not write absolute paths or machine-specific
paths into task records or evidence.

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

Agent feedback is attached to task records and also exported to
`metrics/agent-feedback.jsonl`. Metrics records use JSON Lines so each feedback
payload is append-friendly and durable across syncs.

## Needs Input

`needsInput` routes blocked work:

- `kind`: actor who must act, normally `architect`, `user`, or `owner`.
- `reason`: `task_scope`, `artifact_review`, `tooling`, `verification`,
  `product_decision`, or `blocked_other`.
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
  `spec_review`, `performance_review`, or `validation_report`
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

Register artifacts through `sprintengine artifact add`, `sprintengine artifact
ready`, `sprintengine artifact approve`, or `sprintengine artifact
request-changes`.

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
`artifact_approved`, and `folder_store_migrated`.

## Locks

The folder store is the preferred mutation source when `run.yaml` and task
folders exist. `state.yaml` is a compatibility mirror for legacy tools and may
be absent or stale between writes; consumers should read `projection.json`, not
`state.yaml`, for migrated runs.

The store uses lock files to serialize high-risk operations:

- `runner/run.queue.lock`: run-level mutation lock for folder-store writes.
- `runner/ready.queue.lock`: ready queue materialization lock.
- `runner/claim.queue.lock`: narrow queue lock for task claim selection.
- `state.yaml.lock`: legacy compatibility state lock for unmigrated runs.
- `runner/run.lock.json`: run-level status marker.
- `runner/ready.lock.json`: ready runner status marker.

Consumers should not inspect lock files directly. `sprintengine projection`
reports lock state and stale-lock warnings in the normalized projection.

## DAG Readiness

`tasks/ready/` is a materialized deterministic queue for normal `todo` work. A
`changes_requested` task uses the same dependency and ownership readiness rules
but stays in `tasks/changes_requested/` so reviewers, testers, and product
flows can count rework separately. A task is claimable when:

- its semantic status is `todo` or `changes_requested`;
- it has no `ownerAgentId`;
- its dispatch mode allows dependency readiness;
- every dependency in the run graph is `done`.

Readiness refresh rejects unknown dependencies and cycles. The CLI command is:

```bash
sprintengine task refresh-ready
```

`sprintengine task next --role <role> --id <agent-id>` claims under the
folder-store run lock plus the claim queue lock, prioritizing
`changes_requested` rework before normal ready work without changing its status
until the claim moves it to `in_progress`.

## Projection Boundary

Consumers should use the normalized projection instead of reading folder files:

```bash
sprintengine projection
```

The projection reads real folder-store files for migrated and new runs. It
falls back to legacy `state.yaml` only when the folder store has not been
initialized.

Projection fields include:

- `projectionVersion`
- `source`: `folder_store` or `state_yaml_fallback`
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

## Migration Compatibility

`sprintengine migrate --actor <actor-id>` is idempotent. It creates the folder
store from `state.yaml`, writes `state.migration-backup.yaml`, appends migration
activity and events once, writes metrics records, refreshes the ready queue, and
records migration metadata in `run.yaml`.

After migration, reads should prefer folder-store projection data. The legacy
`state.yaml` file can remain as a compatibility mirror during rollout.

## Verification Commands

Use focused backend and app checks when changing this contract:

```bash
python3 -m py_compile sprintengine_core/tool.py sprintengine_core/store.py scripts/sprintengine_tool.py
uv run --with pytest --with PyYAML python -m pytest tests/sprintengine_tool -q
npx esbuild src/main/mobile/sprintengine/snapshot.test.ts --bundle --platform=node --format=cjs --packages=external --outfile=node_modules/.cache/multicode/mobile-sprintengine-snapshot.test.cjs && node node_modules/.cache/multicode/mobile-sprintengine-snapshot.test.cjs
npx esbuild src/main/index.ts --bundle --platform=node --format=cjs --packages=external --outfile=node_modules/.cache/multicode/main-index.check.cjs
```
