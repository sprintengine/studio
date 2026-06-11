"""Task, gate, merge, and workspace prompt builders."""
from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List

from sprintengine_core.tool.artifacts import artifacts_for_task, project_relative_display_path
from sprintengine_core.tool.comments import *  # noqa: F403,F401
from sprintengine_core.tool.paths import project_relative_path, workspace_root_for_state_path
from sprintengine_core.tool.plans import plan_path_for_state, plan_prompt_path
from sprintengine_core.tool.prompts import load_sprintengine_runtime_skill
from sprintengine_core.tool.shell import get_run_vcs
from sprintengine_core.tool.tasks import ensure_evidence
from sprintengine_core.tool.state import gate_attempts

def architect_worktree_preference_block(use_worktrees: bool) -> str:
    if not use_worktrees:
        return "\n".join([
            "## Execution Workspace",
            "Sprint Engine worktree orchestration is disabled for this run.",
            "- Plan execution in the current workspace.",
            "- Do not create Sprint Engine worktrees or add worktree setup tasks.",
        ])
    return "\n".join([
        "## Execution Workspace",
        "This run executes in one shared git worktree on a dedicated branch; Sprint Engine already created it.",
        "- Do not add tasks to create, configure, or tear down the worktree — it exists before any task runs.",
        "- Plan tasks with tight, non-overlapping `ownedPaths` so two workers rarely touch the same file; that is what keeps per-task commits clean.",
        "- Workers commit their own changes to the shared branch after each task; you do not need committer tasks.",
        "- When the run is complete, open a pull request from the run branch with `sprintengine vcs pr`.",
    ])

def architect_worktree_preference_block_for_state(state: Dict[str, Any]) -> str:
    return architect_worktree_preference_block(get_run_vcs(state) is not None)

def worker_plan_worktree_block() -> str:
    return "\n".join([
        "## Execution Workspace Discipline",
        "- Read only the active team's approved `architect_plan` artifact from the Sprint Engine run store before claiming work.",
        "- The canonical plan is normally `.multi-code/sprintengine/<team>/plan.md`; do not use any other `plan.md` found by search.",
        "- Work in the current workspace directory used to launch this agent.",
        "- Do not create Sprint Engine worktrees.",
        "- Treat task-owned paths as the primary edit surface and collision boundary.",
        "- Prefer owned paths, but you may make small directly required companion edits for correctness, integration, type safety, tests, or cleaner structure.",
        "- Log every touched file. For files outside owned paths, also log a scope expansion with the path, reason, and risk.",
        "- Move to `needs_input` with kind `architect` before broad expansion, product scope changes, major ownership boundary changes, or likely overlap with another active task.",
        "- Do not merge or push.",
    ])

def worker_execution_workspace_block(state: Dict[str, Any], state_path: Path) -> str:
    vcs = get_run_vcs(state)
    if not vcs:
        return worker_plan_worktree_block()
    worktree_path = str(vcs.get("worktreePath") or "")
    branch = str(vcs.get("branchName") or "")
    return "\n".join([
        "## Execution Workspace Discipline",
        "- Read only the active team's approved `architect_plan` artifact from the Sprint Engine run store before claiming work.",
        "- The canonical plan is normally `.multi-code/sprintengine/<team>/plan.md`; do not use any other `plan.md` found by search.",
        f"- This run shares ONE git worktree `{worktree_path}` on branch `{branch}`. You are already working inside it; do not `cd` elsewhere and do not create another worktree.",
        f"- Shared Sprint Engine run file is `{project_relative_path(workspace_root_for_state_path(state_path), state_path)}`; mutate the run store only through the Sprint Engine tool.",
        "- Treat task-owned paths as the primary edit surface and collision boundary.",
        "- Prefer owned paths, but you may make small directly required companion edits for correctness, integration, type safety, tests, or cleaner structure.",
        "- Log every touched file. For files outside owned paths, also log a scope expansion with the path, reason, and risk.",
        "- Move to `needs_input` with kind `architect` before broad expansion, product scope changes, major ownership boundary changes, or likely overlap with another active task.",
        "## Committing Your Work",
        "- After you finish a task's code changes, commit them to the shared branch with `sprintengine vcs commit --task-id <id> --id <your-agent-id>` (add `--path <file>` for any file outside your owned paths).",
        "- That command takes the run's commit lock so only one agent stages the git index at a time, then stages and commits ONLY your task's files. It is safe to run while other agents work.",
        "- Marking the task done also commits any still-uncommitted task-scoped changes as a backstop, so nothing is lost if you forget.",
        "- Other agents commit their own whole files independently; their commits on the shared branch are expected. Do not revert, amend, or worry about commits you did not make.",
        "- If git reports a conflict on a file you own, resolve it: stage the specific hunks you changed when that is clearly simple, otherwise commit the whole file. Then continue.",
        "- Do not push or open a pull request yourself; the architect opens the pull request when the run is complete.",
    ])

def benchmark_feedback_prompt_block() -> str:
    return "\n".join([
        "## Benchmark Feedback Guidance",
        "",
        "- Feedback counts are evidence fields. Report only values you actually evaluated; leave fields unset when you did not check them.",
        "- `claims_checked`: concrete implementation, specification, evidence, or verification claims you checked.",
        "- `hallucinated_claims`: checked claims unsupported by the repository, task card, evidence, or observed behavior.",
        "- `factual_errors`: checked claims contradicted by source, docs, tests, state, or runtime evidence.",
        "- `missed_requirements`: required acceptance criteria, task notes, or plan items absent or only partially implemented.",
        "- `implementation_mistakes`: code, state, schema, routing, integration, or workflow defects in the delivered work.",
        "- `regression_count`: previously working behavior or contract broken by the change.",
        "- `test_failures_introduced`: new failing tests or reproducible validation failures caused by the change.",
        "- `unsafe_changes`: security, data-loss, destructive-operation, privacy, or permission risks introduced by the change.",
        "- Reviewed difficulty uses `--reviewed-difficulty-pct`, `--reviewed-difficulty-dimension`, and `--reviewed-difficulty-reason` when you assessed it.",
        "- Valid reviewed difficulty dimensions are `implementation`, `review`, `verification`, `product_spec`, `security`, `performance`, and `coordination`.",
    ])

def build_merge_start_prompt(state: Dict[str, Any], state_path: Path, actor_id: str, target: str) -> str:
    sprintengine = state.get("sprintengine", {})
    goal = sprintengine.get("goal") or "(not set - read the codebase for context)"
    plan_path = plan_path_for_state(state_path)
    target_branch = target.strip()
    return "\n".join([
        "You are the architect responsible for the post-run sprintengine merge.",
        f"Actor id: {actor_id}",
        f"Goal: {goal}",
        f"State file: {state_path}",
        f"Plan file: {plan_path}",
        f"Requested merge target: {target_branch}",
        "",
        "This command only returns instructions. It has not changed task cards and has not run Git.",
        "",
        "Hard rules:",
        "- Confirm the sprintengine run is complete before merging.",
        f"- Read the exact plan file `{plan_path}` and `sprintengine summary` before touching Git state.",
        "- Do not use any other `plan.md` found elsewhere in the repo.",
        "- Verify the current branch is the intended source branch and `git status --short` is clean.",
        "- Verify the merge target branch and fetch or update only if the user has allowed network/remote operations.",
        "- Perform the merge to the requested target branch, resolving conflicts where reasonable.",
        "- Run relevant validation after the merge.",
        "- Record the result in run summary evidence or the user handoff; do not create, reopen, or edit task cards for merge work.",
        "- Do not push unless explicitly instructed by the user.",
        "- If the merge cannot be completed safely, document the blocker and stop.",
    ])

def prompt_list(title: str, values: List[str], empty: str = "None.") -> List[str]:
    lines = [f"## {title}"]
    lines.extend(values if values else [empty])
    return lines

def build_rework_prompt(state_path: Path, task: Dict[str, Any]) -> str:
    plan_path = plan_prompt_path(state_path)
    open_feedback = newest_comments(open_feedback_comments(task), limit=10)
    latest_comments = newest_comments(task_comments(task), limit=5)
    return "\n".join([
        "# Sprint Engine Task Context",
        "",
        f"Plan path: `{plan_path}`",
        f"Task: `{task.get('id')}` - {task.get('title')}",
        f"Status: `{task.get('status')}`",
        "",
        *prompt_list("Open Feedback (newest first)", [comment_prompt_line(comment) for comment in open_feedback]),
        "",
        *prompt_list("Latest Comments (newest first)", [comment_prompt_line(comment) for comment in latest_comments]),
        "",
        "Use the open feedback as the rework queue. Address newer feedback first when comments conflict, and publish an `implementation_response` when the changes are ready.",
    ])

def build_gate_review_prompt(
    state: Dict[str, Any],
    state_path: Path,
    task: Dict[str, Any],
    gate: Dict[str, Any],
    attempt: Dict[str, Any],
    actor: str,
) -> str:
    plan_path = plan_prompt_path(state_path)
    evidence = ensure_evidence(task)
    implementation_comment = latest_implementation_comment(task)
    artifacts = artifacts_for_task(state, str(task.get("id") or ""))
    recorded_artifacts = [artifact for artifact in artifacts if artifact.get("status") == "recorded"]
    prior_attempts = [
        attempt_record for attempt_record in gate_attempts(gate)
        if isinstance(attempt_record, dict) and attempt_record.get("id") != attempt.get("id")
    ]
    gate_focus = str(gate.get("focus") or "").strip() or "Review the task against the gate role and phase."
    gate_role = str(gate.get("role") or "")
    validation_report_dir = project_relative_display_path(state_path, state_path.parent / "docs" / "validation")
    validation_report_example = f"{validation_report_dir}/{str(task.get('id') or 'task').lower()}-tester-validation.md"
    role_specific_lines: List[str] = []
    if gate_role == "tester":
        role_specific_lines = [
            "",
            "## Tester Gate Expectations",
            "",
            "- Act as QA for the completed implementation, not as a second code reviewer.",
            "- Build a short validation plan from the task acceptance criteria, changed paths, implementation evidence, and highest-risk user or integration paths.",
            "- Run independent, reproducible verification commands where practical; do not approve only by reading the implementation summary.",
            "- For UI, renderer, browser-visible, or end-to-end behavior, use Playwright/browser MCP or equivalent browser automation when available and proportionate. Exercise the real screen or workflow, check basic visual/layout correctness, and record the route/screen, actions, observed result, and any screenshots or artifacts.",
            "- If browser MCP is unavailable or not applicable, say why and run the strongest local alternative: focused Playwright tests, renderer/component tests, Electron smoke checks, screenshots, CLI/API checks, or targeted unit/integration tests. For UI-facing work, lack of browser-level validation is residual risk and should fail or block the gate when visual or interaction correctness is part of acceptance.",
            "- Evaluate whether the existing tests prove the behavior. Add narrow regression tests, fixtures, or test harness wiring when that is the smallest safe way to validate the task.",
            "- Keep any test edits tightly scoped to the task-owned paths or directly related test files. If broader edits are needed, fail or block the gate with a concrete required action instead of expanding scope silently.",
            f"- For any nontrivial validation or tester-authored test edits, write the validation report under the active Sprint Engine team folder, for example `{validation_report_example}`. Do not write tester reports under repo-root `docs/validation/`.",
            "- Submit the verdict with `--artifact-path <team-folder-report-path>`, `--artifact-title`, and `--artifact-kind validation_report`. Include changed test files, commands, results, browser/MCP evidence, path/reason/risk for any companion test edits, and residual risk.",
            "- If no new test is needed, say why and name the existing tests or checks that cover the risk.",
            "- Use `failed` or `changes_requested` when required behavior is unverified, regression coverage is missing, or validation cannot be reproduced. Use `blocked` with needs-input routing when tooling, fixtures, environment, or real integration access prevents validation.",
            "- A passing tester verdict should report scope reviewed, commands run, tests evaluated or added, release confidence, and residual risk.",
        ]
    lines = [
        "# Sprint Engine Gate Review Context",
        "",
        f"Plan path: `{plan_path}`",
        f"Reviewed task: `{task.get('id')}` - {task.get('title')}",
        f"Task role: `{task.get('role')}`",
        f"Task status: `{task.get('status')}`",
        f"Gate: `{gate.get('id')}` phase=`{gate.get('phase')}` role=`{gate.get('role')}` attempt=`{attempt.get('id')}`",
        f"Reviewer agent: `{actor}`",
        f"Gate focus: {gate_focus}",
        "",
        *prompt_list("Task Card", [
            f"- Description: {task.get('description') or ''}",
            *[f"- Acceptance: {item}" for item in task.get("acceptanceCriteria", []) or []],
            *[f"- Implementation note: {item}" for item in task.get("implementationNotes", []) or []],
        ]),
        "",
        *prompt_list("Owned Paths", [f"- `{path}`" for path in task.get("ownedPaths", []) or []]),
        "",
        *prompt_list("Implementation Evidence", [
            f"- Summary: {evidence.get('summary') or ''}",
            *[f"- Touched file: `{path}`" for path in evidence.get("touchedFiles", []) or []],
            *[f"- Command: `{cmd}`" for cmd in evidence.get("commandsRan", []) or []],
            *[f"- Result: {result}" for result in evidence.get("results", []) or []],
        ]),
        "",
        *prompt_list("Diff Evidence", diff_prompt_lines(evidence)),
        "",
        *prompt_list("Linked Artifacts", [
            f"- {artifact.get('id')} `{artifact.get('kind')}` status=`{artifact.get('status')}` path=`{artifact.get('path')}` title={artifact.get('title')}"
            for artifact in artifacts
        ]),
        "",
        *prompt_list("Recorded Artifact References", [
            f"- {artifact.get('id')} gate=`{artifact.get('gateId')}` path=`{artifact.get('path')}`"
            for artifact in recorded_artifacts
        ]),
        "",
        *prompt_list("Latest Implementation Summary Or Response", [comment_prompt_line(implementation_comment)] if implementation_comment else []),
        "",
        *prompt_list("Open Feedback (newest first)", [comment_prompt_line(comment) for comment in newest_comments(open_feedback_comments(task), limit=10)]),
        "",
        *prompt_list("Latest Comments (newest first)", [comment_prompt_line(comment) for comment in newest_comments(task_comments(task), limit=5)]),
        "",
        *prompt_list("Prior Gate Attempts", [
            f"- {record.get('id')} status=`{record.get('status')}` by `{record.get('claimedBy')}` summary={record.get('summary') or ''}"
            for record in prior_attempts
        ]),
        *role_specific_lines,
        "",
        load_sprintengine_runtime_skill("sprintengine_gate_feedback"),
        "",
        benchmark_feedback_prompt_block(),
        "",
        "Audit implementation comments as claims, not proof. Review diff evidence for every changed file, and treat skipped or truncated diffs as review risk that may require manual Git inspection. Use `sprintengine task gate verdict` when the gate review is complete.",
    ]
    return "\n".join(lines)
