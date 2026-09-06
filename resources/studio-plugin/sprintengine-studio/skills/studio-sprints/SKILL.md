---
name: studio-sprints
description: Work inside a SprintEngine Studio sprint run, or steer one from outside. Use when you were started as a sprint agent, when a prompt names a run slug or a task id like T3, when asked to claim, publish, review or advance sprint work, and when asked to create, resume, cancel, re-plan, approve artifacts for, or read the status, token usage or pull request of a sprint run through the sprintengine_* or sprint_* tools.
---

# Sprints

Two surfaces, and they are not interchangeable. The `sprintengine_*` tools are
the **in-run agent surface**: you are inside a run, you have an agent id, and
the run's state path is resolved for you. The `sprint_*` tools are the
**operator surface**: you are outside a run, you name it by `workspaceId` plus
`slug`, and you are doing what a person would do on the board. Use the one that
matches where you are standing. If you have an agent id, you are inside.

Read schemas from the tools themselves. This skill teaches order and meaning;
`tools/list` is the listing surface, and every parameter description is
authoritative over anything written here.

## Inside a run

**Open in this order.** `sprintengine_agent_join` with your `agentId` (and
`role` when the run has roles) — the response carries your Soul and your role's
rules, so read it before anything else. Then `sprintengine_task_next` with
`{role, id}`, or `{id}` on a roleless run. Do not initialize the run: Studio
owns initialization, and `sprintengine_init` is the architect's bootstrap, once.
`sprintengine_help` still exists and still works; the topics it prints
(`agent_workflow`, `tools`, `needs_input`, `artifacts`, `phases`) are what this
skill and its siblings carry, so you should not need it.

**If the claim returns no work, say so and stop.** Do not poll. Studio
re-engages this terminal when work is ready.

**You own your task from claim to done.** There is no separate reviewer.
Implement it, then `sprintengine_task_publish` with `{taskId, id, summary}`. In
a worktree-mode run publish also commits your task-scoped changes in your task's
project worktree, under that project's commit lock — you do not commit by hand.
Pass `noChangesOk` when the task legitimately produced no diff; it then lands in
`done` directly.

**Publish returns your next directive inline.** When your task produced a diff,
publish routes it into its review phase and the response carries
`nextDirective`. Follow it, fix what you find, then close the phase with
`sprintengine_task_advance` and `{taskId, id, phase, outcome, summary}`. `phase`
must equal the task's current status and only the owner may call it. `outcome`
is `pass` (reviewed, nothing to fix), `pass_with_fixes` (found issues and fixed
them in this session), or `escalate` (a plan contradiction, scope change or
product decision blocks you — `needsInputQuestion` is then required). Record
what you found, including what you fixed, as `findingJson` — an ARRAY of
findings, each `{kind, severity, area, title?}`, even when there is only one.
`issueJson` takes the same shape.

The walk is strictly forward and each phase is visited at most once. Fixes you
make during a phase are smoke-checked in place, never re-reviewed by re-entering
it. After the task is done, stop: Studio owns dispatch and continuation.

**Read a card with `sprintengine_task_get`.** It is slim by default; pass
`include: ["activity", "comments", "evidence_log", "diffs"]` only when you need
the history. There is no projection tool: the whole-run projection is a UI file
on disk, and over MCP it was a quarter of a million tokens in one call.

**Log evidence as you go** with `sprintengine_task_log`
(`{taskId, id, summary, file, command, result}`). Leave a note for a human with
`sprintengine_task_note`, a board comment with `sprintengine_task_comment`.
Release a task you cannot finish with `sprintengine_task_release` and a reason.
Retire yourself near context capacity with `sprintengine_agent_leave` — it
releases your lease, which a silent exit does not.

**Escalate rarely.** Move a task to needs_input with
`sprintengine_task_status` and `{taskId, id, status: "needs_input",
needsInputKind, needsInputReason, needsInputQuestion}`. `needsInputKind` is
`architect` when Studio should route the question to whoever plans this run, or
`user` when a human must answer. `needsInputReason` is one of `task_scope`,
`artifact_review`, `tooling`, `verification`, `product_decision`,
`blocked_other`.

`needsInputQuestion` is shown verbatim to a person. When the kind is `user`,
write it for a human operator: no tool names, command flags, code symbols, file
paths or acceptance-criteria shorthand unless essential and explained. Open with
one line naming the decision you need, then short bullet lines covering what is
blocked, why you cannot resolve it yourself, and the concrete options
(recommended first). End with the single thing you need back. Put your
recommended default in `needsInputSuggestedResolution`. A question the operator
cannot act on without reading the code is not finished.

Do **not** use needs_input for ordinary compile, test, review or validation
failures. You own the task: fix them and continue. Escalate only for a plan
contradiction, a scope change, or a product decision you must not invent. Use
`sprintengine_task_status` for anything else only as a low-level repair when no
workflow tool can represent the correction.

**Only claim work whose role matches yours.** On a roleless run, claim only work
that carries no role either. The run's roles are user configuration: if work
seems to need a role the run does not have, raise it with needs_input and let
the user decide — never invent or enable roles yourself.

## Planning (architect, or a roleless agent)

`sprintengine_plan_read` and `sprintengine_plan_list` read the graph;
`sprintengine_plan_add_task`, `sprintengine_plan_update_task`,
`sprintengine_plan_delete_task`, `sprintengine_plan_add_dependency` and
`sprintengine_plan_remove_dependency` change it. Every other role gets
`tool_not_permitted_for_role` and a suggested alternative — usually
`sprintengine_task_comment`, which is how a worker proposes a task.

`backlogRef` is one item per task; a second task pointing at the same item is
rejected by name. `sourceDocs` names canonical documents the worker must read in
full on claim — keep the card the delta, never a restatement. `path` is a
scheduling advisory, not a contract: tasks with overlapping modules never run at
the same time, so give genuinely concurrent tasks disjoint modules and leave it
empty when you do not know, which is the normal case. `kind` marks a task as
`work`, `review` or `integration_review`. `fromFinding` carries
`{taskId, findingId}` when you are triaging a reviewer's escalation into a new
task, which is what keeps the finding chain intact across the run.

`sprintengine_triage_needs_input` lists what is waiting on the planner.
`sprintengine_task_resolve_input` answers it with `{taskId, id, resolution}`,
and `complete: true` closes the task instead of returning it to work.

## Artifacts

`sprintengine_artifact_add` with `{taskId, kind, title, path}`. `kind` must be
one of `architect_plan`, `product_strategy`, `requirements`, `html_mockup`,
`design_notes`, `branding`, `security_review`, `code_review`, `spec_review`,
`performance_review`, `production_readiness_review`, `cross_platform_review`,
`validation_report`; other values are rejected. Set `ready: true` only when the
artifact must wait for human approval. `sprintengine_artifact_ready` hands it
over; `sprintengine_artifact_list` reads. Artifact statuses are `draft`,
`recorded`, `ready_for_review`, `approved`, `changes_requested`, `superseded`.

**Adjudicating an artifact is not yours.** `sprintengine_artifact_approve` and
`sprintengine_artifact_request_changes` are planning tools: the architect (or a
roleless agent, or the human Inbox loop) holds them, and a worker calling one
gets `tool_not_permitted_for_role`. Review is not a rework channel back onto a
task. What a worker holds is `sprintengine_artifact_add`,
`sprintengine_artifact_list` and `sprintengine_artifact_ready`.

## Version control inside a run

Publish commits for you. Reach for `sprintengine_vcs_status` and
`sprintengine_vcs_commit` only when publish cannot represent what you need, and
`sprintengine_vcs_request_repo` to declare an additional project root. Those
three are the worker's whole VCS surface.

`sprintengine_vcs_pr` is a planning tool, not one of them: a worker calling it
gets `tool_not_permitted_for_role`. Opening the run's pull request belongs to
the architect, a roleless agent, or an operator through `sprint_pr_create`.

## Steering a run from outside

`sprint_list` with `{workspaceId}` gives slugs, newest first; every other tool
takes `{workspaceId, slug}`. Never pass a state path — it is reconstructed
server-side and refused from a caller.

`sprint_status` is the projection plus the run's automation mode. The mode is
`manual`, `run_agents`, or `run_agents_and_approve_artifacts`; there is no
paused state, because pause is `manual`. `sprint_set_mode` sets it and is
idempotent (`changed: false` when it already held that mode) — verify the live
effect with `sprint_status`, because `sprint_resume` is fire-and-forget and
confirms nothing. `sprint_cancel` is terminal.

`sprint_create` takes `folderPath`, not a workspace id, and creates the run in a
new workspace. Pass `sourceRef` to plan from a backlog item or epic (or a plan
file or HTML mockup) — `goal` may then be empty because it derives from the item
heading, and for a backlog source the execution link is written. Permissions are
not selectable: a goal-only run is pinned to `manual` so an external caller with
no human-authored source cannot self-escalate, while a source-launched run
spawns in bypass. With `startRunner` the run is handed to the scheduler; without
it the run sits in manual until a person opens it. Read `cli_runtime_list`
before passing `runtime`, `roleClis`, `roleModels` or `roleEfforts` — those are
otherwise blind strings, and only rows with `agentSelectable: true` may staff a
run.

Task-level operator tools: `sprint_task_create` (`title` and `role` are both
required, and `role` must be one of nine — `architect`, `product`, `developer`,
`frontend`, `tester`, `security`, `performance`,
`production_readiness_reviewer`, `cross_platform` — so this tool cannot add work
to a roleless run, which has no role to name; `acceptanceCriteria`,
`implementationNotes` and `notes` are arrays of non-empty strings, never a bare
string), `sprint_task_update`, `sprint_task_comment`,
`sprint_task_set_status` (`todo`, `in_progress`, `review`, `needs_input`,
`done`, `canceled` — the common use is reopening a reviewed task as
`in_progress` for rework under its original owner), and
`sprint_task_resolve_input`. Artifacts: `sprint_artifact_approve` (optional
feedback) and `sprint_artifact_request_changes` (feedback required and
non-empty).

`sprint_pr_create` opens the run's pull request and returns the refreshed `vcs`
block, so no second status read is needed; `sprint_pr_status` refreshes and
returns `vcs.pullRequestState` (`open`, `merged`, `closed`, or null).
`sprint_token_usage` reports per-run, per-agent and per-task token accounting;
unmeasured agents are reported as unmeasured, never as zero.

## When a call is refused

`sprintengine_module_disabled` and `no_active_sprint` mean the surface is not
available here, not that you called it wrong. `tool_not_permitted_for_role`
names a permitted alternative — take it rather than retrying.
`sprintengine_proxy_error` is the engine itself failing; report it with the
message rather than working around it.
