"""Task, phase, merge, and workspace prompt builders.

Phase directives are the MC-1542 replacement for gate review prompts. A task's
owner implements, publishes, and then walks its `phases` in the SAME session; the
directive for each phase is composed here and returned inline in the owner's own
`task.publish` / `task.advance` tool response. There are exactly two delivery
channels — that inline response for a live owner, and the respawn startup brief
for an owner that died mid-phase. No phase transition is ever announced by pasting
into a terminal.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional

from sprintengine_core.role_registry import (
    RegistryDiscovery,
    RoleManifest,
    SkillDocument,
    discover_role_registry,
    normalize_role_id,
)
from sprintengine_core.tool.comments import *  # noqa: F403,F401
from sprintengine_core.tool.paths import project_relative_path, workspace_root_for_state_path
from sprintengine_core.tool.plans import plan_path_for_state, plan_prompt_path
from sprintengine_core.tool.shell import get_run_vcs
from sprintengine_core.tool.tasks import ensure_evidence

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
        "- NEW files and directories are only committed if they fall inside your task's ownedPaths. If you create a file outside them — for example splitting a panel into a new sibling directory — add that path to your task's ownedPaths (`sprintengine plan update-task`) or pass it with `--path <file>`, or it will be silently left out of the commit and a clean checkout will fail to build.",
        "- `vcs commit` warns when changed paths fall outside every task's owned paths, and `task publish` refuses to publish while such orphaned changes are uncommitted. Do not ignore that warning — a green local build does not mean the committed tree builds.",
        "- Marking the task done also commits any still-uncommitted task-scoped changes as a backstop, so nothing is lost if you forget.",
        "- Other agents commit their own whole files independently; their commits on the shared branch are expected. Do not revert, amend, or worry about commits you did not make.",
        "- If git reports a conflict on a file you own, resolve it: stage the specific hunks you changed when that is clearly simple, otherwise commit the whole file. Then continue.",
        "- Do not push or open a pull request yourself; the architect opens the pull request when the run is complete.",
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
    """The implementation-phase task brief, returned by every `task.next` claim.

    Feedback is no longer grouped by gate (there are no gates, and no reviewer
    files findings against another agent's task). What remains is the human Inbox
    loop and architect notes: a flat, newest-first queue.
    """
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
        *prompt_list(
            "Open Feedback (newest first)",
            [comment_prompt_line(comment) for comment in open_feedback],
        ),
        "",
        *prompt_list("Latest Comments (newest first)", [comment_prompt_line(comment) for comment in latest_comments]),
        "",
        "Use the open feedback as the rework queue. Address newer feedback first when comments conflict, then publish with `sprintengine.task.publish`.",
    ])

# ---------------------------------------------------------------------------
# Phase directives (MC-1542)
# ---------------------------------------------------------------------------

# The shared base pack for a phase, resolved through the role registry so a
# workspace layer can shadow `sprintengine_phase_review` and change the review
# lens for every task on the run without touching the engine.
def phase_base_pack_skill_id(phase: str) -> str:
    return f"sprintengine_phase_{normalize_role_id(phase)}"


def _registry_skill_body(registry: RegistryDiscovery, skill_id: str) -> Optional[str]:
    entry = registry.skills.get(normalize_role_id(skill_id))
    if entry is None or not isinstance(entry.value, SkillDocument):
        return None
    body = entry.value.body.strip()
    return body or None


def _role_phase_directive_bodies(registry: RegistryDiscovery, role: str, phase: str) -> List[str]:
    """The role's own additions for `phase`, appended after the base pack.

    An unresolvable role or a missing skill degrades to no additions: the base
    pack alone is a complete directive, and a broken pack must not block a live
    owner mid-transition.
    """
    try:
        manifest = registry.get_role(role)
    except KeyError:
        return []
    if not isinstance(manifest, RoleManifest):
        return []
    bodies: List[str] = []
    for entry in manifest.directives_for_phase(phase):
        body = _registry_skill_body(registry, entry.skill)
        if body:
            bodies.append(body)
    return bodies


PHASE_HEADERS: Dict[str, str] = {
    "review": (
        "Your task has entered review — you are now reviewing your own work. "
        "No other agent will review it."
    ),
}


def phase_header(phase: str) -> str:
    return PHASE_HEADERS.get(
        normalize_role_id(phase),
        f"Your task has entered the {phase} phase.",
    )


def build_phase_directive(
    state: Dict[str, Any],
    state_path: Path,
    task: Dict[str, Any],
    phase: str,
) -> str:
    """Compose the directive an owner receives on entering `phase`.

    Phase header, the shared base pack, the role's `directives.<phase>` additions,
    the task's acceptance criteria, and any open feedback comments. Returned inline
    in the `publish`/`advance` response, so it deliberately omits the diff and the
    task description the owner already has in context; the respawn brief
    (`build_phase_respawn_brief`) adds them back for an owner starting cold.
    """
    registry = discover_role_registry(workspace_root=workspace_root_for_state_path(state_path))
    role = str(task.get("role") or "")
    base_pack = _registry_skill_body(registry, phase_base_pack_skill_id(phase))
    open_feedback = newest_comments(open_feedback_comments(task), limit=10)

    sections: List[str] = [
        f"# {phase_header(phase)}",
        "",
        f"Task: `{task.get('id')}` - {task.get('title')}",
        f"Phase: `{phase}`",
        "",
    ]
    if base_pack:
        sections.extend([base_pack, ""])
    for body in _role_phase_directive_bodies(registry, role, phase):
        sections.extend([f"## {role} additions for this phase", "", body, ""])
    sections.extend(
        prompt_list(
            "Acceptance Criteria",
            [f"- {item}" for item in task.get("acceptanceCriteria", []) or []],
            empty="None recorded — review against the task description and plan.",
        )
    )
    if open_feedback:
        sections.extend([
            "",
            *prompt_list(
                "Open Feedback (address before you advance)",
                [comment_prompt_line(comment) for comment in open_feedback],
            ),
        ])
    sections.extend([
        "",
        f"Close this phase with `sprintengine.task.advance` "
        f"`{{ taskId: \"{task.get('id')}\", phase: \"{phase}\", outcome, summary }}`.",
    ])
    return "\n".join(sections)


def build_phase_respawn_brief(
    state: Dict[str, Any],
    state_path: Path,
    task: Dict[str, Any],
    phase: str,
) -> str:
    """The startup brief for an owner revived mid-phase (Flow 6).

    The live-owner directive assumes the diff is already in context. A revived
    owner has nothing, so this prepends the task card and the published diff
    evidence before the same directive body.
    """
    evidence = ensure_evidence(task)
    plan_path = plan_prompt_path(state_path)
    return "\n".join([
        "# Sprint Engine Phase Handover",
        "",
        f"You previously owned `{task.get('id')}` and are resuming it mid-phase. "
        "The work below is yours; the diff is already committed to the task.",
        "",
        f"Plan path: `{plan_path}`",
        f"Task role: `{task.get('role')}`",
        "",
        *prompt_list("Task Card", [
            f"- Description: {task.get('description') or ''}",
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
        "---",
        "",
        build_phase_directive(state, state_path, task, phase),
    ])
