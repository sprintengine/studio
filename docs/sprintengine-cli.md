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

## Common Worker Flow

Workers join the active run, read the plan returned by the directive, claim one
ready task for their exact role, log evidence, then publish or mark the task
done:

```bash
sprintengine join --role developer --id developer-1 --watch
sprintengine task next --role developer --id developer-1
sprintengine task log --task-id T8 --id developer-1 --summary "Updated Sprint Engine docs" --file docs/sprintengine-cli.md --command "uv run --with pytest --with PyYAML python -m pytest tests/sprintengine_tool -q" --result "Passed"
sprintengine task status --task-id T8 --status done --id developer-1 --confidence-pct 90 --hallucination-risk-pct 5
```

Use `sprintengine task next`, not manual file moves, for normal claiming. It
claims under folder-store locks, prioritizes `changes_requested` rework before
normal ready work, and refreshes folder-store materialization.

For gated implementation tasks, prefer `sprintengine task publish` after
logging evidence. Publishing writes an `implementation_summary` or
`implementation_response` comment and routes the task to the next configured
quality phase or to `done`:

```bash
sprintengine task publish --task-id T3 --id developer-1 --summary "Implemented the CLI route and added regression coverage." --path sprintengine_core/tool.py
```

Do not use a plain `task status --status done` to bypass required quality
gates.

## Command Groups

Inspect help before scripting a command:

```bash
sprintengine --help
sprintengine task next --help
sprintengine artifact add --help
sprintengine projection --help
```

Current command groups:

- `handover`: create a team bootstrap and handoff context.
- `init`: initialize a run.
- `recover`: run an integrity recovery audit prompt.
- `projection`: read the normalized run projection.
- `runner`: read or update the durable runner policy.
- `roster`: add or list canonical roster members.
- `join`: receive the role prompt and next directive.
- `triage`: inspect architect-actionable blockers.
- `task`: claim, update, release, log, comment, and refresh tasks.
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
fields, runner policy, and per-task quality gate/comment context.

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
sprintengine task publish --task-id T3 --id developer-1 --summary "Implementation is ready for gate review." --path sprintengine_core/store.py
sprintengine task comment add --task-id T3 --id user --source user --type user_note --body "Please include migration notes."
sprintengine task comment list --task-id T3
sprintengine task refresh-ready
```

Use `--scope-expansion-json` when evidence includes a touched file outside the
task's owned paths:

```bash
sprintengine task log --task-id T3 --id developer-1 --scope-expansion-json '{"path":"src/shared/electron-api.ts","reason":"Expose projection read result type for renderer consumers.","risk":"low"}'
```

## Quality Gate Commands

Quality gates are separate from normal task claiming. A task in `review`,
`testing`, or `product` stays in that lifecycle folder while reviewers or
testers claim individual gates.

List gates:

```bash
sprintengine task gate list --task-id T3
sprintengine task gate list --role code_reviewer
```

Claim the next available gate for your role:

```bash
sprintengine task gate next --role code_reviewer --id code-reviewer
```

Claim a specific gate:

```bash
sprintengine task gate claim --task-id T3 --gate-id code_reviewer --role code_reviewer --id code-reviewer
```

Submit an approving verdict:

```bash
sprintengine task gate verdict --task-id T3 --gate-id code_reviewer --role code_reviewer --id code-reviewer --verdict approved --summary "Implementation matches the task and evidence is sufficient." --correctness-pct 92 --evidence-quality-pct 88 --claims-checked 8
```

Request changes or record a failed validation:

```bash
sprintengine task gate verdict --task-id T3 --gate-id tester --role tester --id tester --verdict failed --summary "The rework path regresses changes_requested readiness." --required-action "Add a regression test for changes_requested task next."
```

Block on routed input:

```bash
sprintengine task gate verdict --task-id T3 --gate-id architect_review --role architect --id architect --verdict blocked --summary "The task needs scope clarification." --needs-input-kind architect --needs-input-reason task_scope --needs-input-question "Should this task also own renderer projection types?" --needs-input-suggested-resolution "Either add the renderer type file as a scoped expansion or create a follow-up frontend task."
```

Skip a configured gate with rationale:

```bash
sprintengine task gate verdict --task-id T3 --gate-id product --role product --id product --verdict skipped --summary "Product acceptance is not rostered for this run."
```

Approved and skipped verdicts advance only after all required gates in the
current phase are closed. `changes_requested` and `failed` verdicts create open
feedback comments and route the task to `changes_requested`. `blocked` verdicts
require needs-input metadata and route the task to `needs_input`.

Gate verdict feedback metrics are attached to the reviewed task and exported to
`metrics/agent-feedback.jsonl` with reviewer agent, phase, gate, attempt, and
verdict fields.

## Recorded Artifacts

Gate verdicts can attach durable evidence as a `recorded` artifact:

```bash
sprintengine task gate verdict --task-id T3 --gate-id code_reviewer --role code_reviewer --id code-reviewer --verdict approved --summary "Review passed; notes recorded." --artifact-path .multi-code/sprintengine/team/reviews/code-review-T3.md --artifact-title "Task T3 review" --artifact-kind code_review
```

`recorded` artifacts are visible in projection and linked to the task/gate, but
they do not enter human approval queues and do not block task completion by
themselves. Use `artifact ready` only for artifacts that need human approval.

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

## Runner Policy

The durable runner policy lives in `run.yaml` and is exposed in projection:

```bash
sprintengine runner status
sprintengine runner set --mode auto
sprintengine runner set --mode off
```

Agents should start and continue with `join --watch`. When Auto Mode is on,
`join --watch` sleeps and polls under the CLI until work is available or Auto
Mode is turned off. When Auto Mode is off, idle agents stop. The renderer
should launch and monitor roster terminals;
the CLI decides which task, gate, or triage directive an agent receives.

## DAG Readiness

Readiness is deterministic and dependency-aware. A normal `todo` task appears
in `tasks/ready/` when every dependency is `done`, the task has no owner, and
dispatch allows dependency readiness. A `changes_requested` task with the same
readiness properties stays in `tasks/changes_requested/` and is still claimable;
`task next` prioritizes that rework ahead of normal ready tasks without
flattening it to `ready`.

Lifecycle phase folders are not readiness queues. Reviewers, testers, and
product reviewers claim `qualityGates` with `task gate next` or `task gate
claim`. A task can remain in one phase while multiple required review gates are
claimed and completed independently.

Refresh readiness explicitly with:

```bash
sprintengine task refresh-ready
```

Unknown dependencies and cycles fail with clear errors. Do not create readiness
by moving task files by hand.

## Locks And Recovery

The CLI serializes folder-store mutations with `runner/run.queue.lock`,
materialization with `runner/ready.queue.lock`, and claim selection with
`runner/claim.queue.lock`. Gate claim and verdict selection uses
`runner/gate.queue.lock`. The projection reports lock status and stale-lock
warnings so app and mobile consumers do not need to inspect lock files.

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
python3 -m py_compile sprintengine_core/tool.py sprintengine_core/store.py scripts/sprintengine_tool.py
uv run --with pytest --with PyYAML python -m pytest tests/sprintengine_tool -q
npx esbuild src/main/mobile/sprintengine/snapshot.test.ts --bundle --platform=node --format=cjs --packages=external --outfile=node_modules/.cache/multicode/mobile-sprintengine-snapshot.test.cjs && node node_modules/.cache/multicode/mobile-sprintengine-snapshot.test.cjs
npx esbuild src/main/index.ts --bundle --platform=node --format=cjs --packages=external --outfile=node_modules/.cache/multicode/main-index.check.cjs
```

`npm run typecheck:app` is also useful when local frontend dependencies are
installed.
