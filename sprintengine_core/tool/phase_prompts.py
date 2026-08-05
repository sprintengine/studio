"""Task, phase, and workspace prompt builders.

A task's owner reviews its own work (MC-1542): it implements, publishes, and then
walks its `phases` in the SAME session. The directive for each phase is composed
here and returned inline in the owner's own `task.publish` / `task.advance` tool
response. There are exactly two delivery channels — that inline response for a
live owner, and the respawn startup brief for an owner that died mid-phase. No
phase transition is ever announced by pasting into a terminal.
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
from sprintengine_core.tool.plans import plan_prompt_path
from sprintengine_core.tool.repo_model import get_run_vcs, vcs_repos
from sprintengine_core.tool.tasks import ensure_evidence

# Worker execution-workspace discipline is emitted from ONE template site so the
# shared plan-reading and owned-paths rules are written once (MC-1615 seam). The
# no-worktree and worktree prompts differ only in `location_lines` (where the
# agent works) and `trailing_lines` (commit flow vs. do-not-push); everything
# else — the header and the four owned-paths rules — comes from here verbatim.
def _execution_workspace_discipline_block(location_lines: List[str], trailing_lines: List[str]) -> str:
    return "\n".join([
        "## Execution Workspace Discipline",
        "- Read only the active team's approved `architect_plan` artifact from the Sprint Engine run store before claiming work.",
        "- The canonical plan is normally `.multi-code/sprintengine/<team>/plan.md`; do not use any other `plan.md` found by search.",
        *location_lines,
        "- Treat task-owned paths as the primary edit surface and collision boundary.",
        "- Prefer owned paths, but you may make small directly required companion edits for correctness, integration, type safety, tests, or cleaner structure.",
        "- Log every touched file. For files outside owned paths, also log a scope expansion with the path, reason, and risk.",
        "- Move to `needs_input` with kind `architect` before broad expansion, product scope changes, major ownership boundary changes, or likely overlap with another active task.",
        *trailing_lines,
    ])

def worker_plan_worktree_block() -> str:
    return _execution_workspace_discipline_block(
        location_lines=[
            "- Work in the current workspace directory used to launch this agent.",
            "- Do not create Sprint Engine worktrees.",
        ],
        trailing_lines=["- Do not merge or push."],
    )

# A run declares one project per worktree, so the location rule is written per
# project and never as "the" worktree: a task names its project in `repo`, and the
# tree that project's paths resolve against is the tree the agent's terminal was
# already launched into. `vcs_repos` yields the one-entry list for a single-repo
# run, so this text is the same shape in both — one project listed instead of many.
def _declared_project_labels(vcs: Dict[str, Any]) -> str:
    return ", ".join(
        f"`{repo['id']}` (`{repo.get('worktreePath') or ''}` on branch `{repo.get('branchName') or ''}`)"
        for repo in vcs_repos(vcs)
    )


def worker_execution_workspace_block(state: Dict[str, Any], state_path: Path) -> str:
    vcs = get_run_vcs(state)
    if not vcs:
        return worker_plan_worktree_block()
    run_file = project_relative_path(workspace_root_for_state_path(state_path), state_path)
    return _execution_workspace_discipline_block(
        location_lines=[
            f"- Every task names ONE project in its `repo` field. This run's projects are: {_declared_project_labels(vcs)}.",
            "- Work ONLY inside your task's project worktree. Your terminal already starts there; do not `cd` elsewhere and do not create another worktree.",
            "- Your task's paths — evidence, commits, any declared modules — are relative to THAT project's root. Another project is reachable only as its own task, never as a path that walks out of your tree.",
            f"- Shared Sprint Engine run file is `{run_file}`; mutate the run store only through the Sprint Engine tool.",
        ],
        trailing_lines=[
            "## Committing Your Work",
            "- After you finish a task's code changes, commit them to your project's run branch with `sprintengine vcs commit --task-id <id> --id <your-agent-id>`.",
            "- That command takes YOUR PROJECT's commit lock so only one agent stages that project's git index at a time. It is safe to run while other agents work: agents in other projects commit at the same time, agents in yours wait their turn.",
            "- Commit scope is what you actually CHANGED, not anything declared in advance. By default the commit takes every changed file in your project worktree except paths a currently-running sibling task claims — so new files and new directories anywhere in your tree are committed, and nothing is silently left out. You never need to edit `ownedPaths` to get your own work committed.",
            "- If other agents are running and you want to be precise, pass `--changed-path <file>` (repeatable) on `task publish` to commit exactly the paths you name. Anything still uncommitted comes back in the response as a question — include it in a follow-up commit or leave it. Publish is never refused over it.",
            "- Marking the task done also commits any still-uncommitted task-scoped changes as a backstop, so nothing is lost if you forget.",
            "- Other agents commit their own whole files independently; their commits on your project's branch are expected. Do not revert, amend, or worry about commits you did not make.",
            "- If git reports a conflict on a file you own, resolve it: stage the specific hunks you changed when that is clearly simple, otherwise commit the whole file. Then continue.",
            "- Do not push or open a pull request yourself. Each project the run changed gets its own pull request, opened after the run completes.",
        ],
    )

def prompt_list(title: str, values: List[str], empty: str = "None.") -> List[str]:
    lines = [f"## {title}"]
    lines.extend(values if values else [empty])
    return lines

def build_rework_prompt(state_path: Path, task: Dict[str, Any]) -> str:
    """The implementation-phase task brief, returned by every `task.next` claim.

    Feedback bodies are NOT re-listed here: the same response's task card already
    carries them (`openFeedback`, newest first, plus the raw comments on the CLI
    payload). The prompt names the queue and how to work it — serializing the
    bodies twice per claim was pure token cost (backlog item 1566).
    """
    plan_path = plan_prompt_path(state_path)
    open_feedback_count = len(open_feedback_comments(task))
    feedback_line = (
        f"This task has {open_feedback_count} open feedback comment(s) on its task card "
        "(`openFeedback`, newest first). Use them as the rework queue: address newer "
        "feedback first when comments conflict, then publish with `sprintengine.task.publish`."
        if open_feedback_count
        else "No open feedback. Implement against the task card, then publish with `sprintengine.task.publish`."
    )
    lines = [
        "# Sprint Engine Task Context",
        "",
        f"Plan path: `{plan_path}`",
        f"Task: `{task.get('id')}` - {task.get('title')}",
        f"Status: `{task.get('status')}`",
    ]
    source_docs = [str(p).strip() for p in (task.get("sourceDocs") or []) if str(p).strip()]
    if source_docs:
        lines.extend([
            "",
            "Canonical sources — read each in full before implementing. They are your "
            "operating brief; the task card carries only the delta (verified pointers, "
            "decisions, contracts):",
            *[f"- `{doc}`" for doc in source_docs],
        ])
    lines.extend(["", feedback_line])
    return "\n".join(lines)

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

    Phase header, the shared base pack, and the role's `directives.<phase>`
    additions. Returned inline in the `publish`/`advance` response, so it
    deliberately omits the diff, the task description, and the acceptance
    criteria the owner already holds on its card, and references — never
    re-lists — open feedback (the same response's `openFeedback` delta carries
    the bodies). The respawn brief (`build_phase_respawn_brief`) rebuilds the
    dropped context for an owner starting cold.
    """
    registry = discover_role_registry(workspace_root=workspace_root_for_state_path(state_path))
    role = str(task.get("role") or "")
    base_pack = _registry_skill_body(registry, phase_base_pack_skill_id(phase))
    open_feedback_count = len(open_feedback_comments(task))

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
    sections.append("Review against your task card's acceptance criteria and the plan.")
    if open_feedback_count:
        sections.append(
            f"Address the {open_feedback_count} open feedback comment(s) on this response "
            "(`openFeedback`, newest first) before you advance."
        )
    sections.extend([
        "",
        f"Close this phase with `sprintengine.task.advance` "
        f"`{{ taskId: \"{task.get('id')}\", phase: \"{phase}\", outcome, summary }}`.",
    ])
    return "\n".join(sections)


# Cold-start respawn brief caps: enough to resume the work, never an unbounded
# dump — the full evidence stays on the task (`task.get include=[...]`).
RESPAWN_TEXT_LIMIT = 700
RESPAWN_LIST_LIMIT = 10
RESPAWN_DIFF_LINE_LIMIT = 100


def _respawn_text(value: Any) -> str:
    text = str(value or "").strip()
    if len(text) <= RESPAWN_TEXT_LIMIT:
        return text
    return f"{text[:RESPAWN_TEXT_LIMIT - 3].rstrip()}..."


def _respawn_description(task: Dict[str, Any]) -> str:
    """The card's description, with an honest elision marker when capped.

    The description is the worker's operating brief; a bare `...` reads as the
    whole card and a revived owner would work a truncated scope without knowing
    it. The full card lives on disk, so the marker points at `task.get` instead
    of inlining unbounded text.
    """
    text = str(task.get("description") or "").strip()
    truncated = _respawn_text(text)
    if truncated == text:
        return text
    return (
        f"{truncated} "
        f"(description truncated — `sprintengine.task.get` with "
        f"`{{taskId: \"{task.get('id')}\"}}` returns the complete card; read it before working)"
    )


def _respawn_tail(values: List[Any], label: str, *, code: bool = False) -> List[str]:
    """Newest-last tail of a list, with an elision marker naming what was cut."""
    items = [value for value in values if str(value or "").strip()]
    lines = [
        f"- {label}: `{_respawn_text(value)}`" if code else f"- {label}: {_respawn_text(value)}"
        for value in items[-RESPAWN_LIST_LIMIT:]
    ]
    if len(items) > RESPAWN_LIST_LIMIT:
        lines.insert(0, f"- ({len(items) - RESPAWN_LIST_LIMIT} earlier {label.lower()} entries elided — `sprintengine.task.get` with `include=[\"evidence_log\"]` has the full log)")
    return lines


def build_phase_respawn_brief(
    state: Dict[str, Any],
    state_path: Path,
    task: Dict[str, Any],
    phase: str,
) -> str:
    """The startup brief for an owner revived mid-phase (Flow 6).

    The live-owner directive assumes the card and diff are already in context. A
    revived owner has nothing, so this prepends the task card (including the
    acceptance criteria the inline directive no longer re-lists) and the published
    evidence before the same directive body. Every unbounded surface is capped
    with an explicit elision marker (backlog item 1566).
    """
    evidence = ensure_evidence(task)
    plan_path = plan_prompt_path(state_path)
    diff_lines = diff_prompt_lines(evidence)
    if len(diff_lines) > RESPAWN_DIFF_LINE_LIMIT:
        elided = len(diff_lines) - RESPAWN_DIFF_LINE_LIMIT
        diff_lines = diff_lines[:RESPAWN_DIFF_LINE_LIMIT]
        diff_lines.append(f"- ({elided} more changed files elided — read the task's committed diff with git)")
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
            f"- Description: {_respawn_description(task)}",
            *[f"- Acceptance: {_respawn_text(item)}" for item in task.get("acceptanceCriteria", []) or []],
            *[f"- Implementation note: {_respawn_text(item)}" for item in task.get("implementationNotes", []) or []],
        ]),
        "",
        *prompt_list("Owned Paths", [f"- `{path}`" for path in task.get("ownedPaths", []) or []]),
        "",
        *prompt_list("Implementation Evidence", [
            f"- Summary: {_respawn_text(evidence.get('summary'))}",
            *_respawn_tail(list(evidence.get("touchedFiles", []) or []), "Touched file", code=True),
            *_respawn_tail(list(evidence.get("commandsRan", []) or []), "Command", code=True),
            *_respawn_tail(list(evidence.get("results", []) or []), "Result"),
        ]),
        "",
        *prompt_list("Diff Evidence", diff_lines),
        "",
        "---",
        "",
        build_phase_directive(state, state_path, task, phase),
    ])
