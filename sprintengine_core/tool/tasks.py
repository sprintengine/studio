"""Task normalization, readiness, evidence, and publishing helpers."""
from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any, Dict, List, Optional

from sprintengine_core import store as folder_store
from sprintengine_core.diff_evidence import capture_task_diff_evidence
from sprintengine_core.tool.comments import *  # noqa: F403,F401
from sprintengine_core.tool.common import unique_strings
from sprintengine_core.tool.constants import *  # noqa: F403,F401
from sprintengine_core.tool.paths import now_iso, workspace_root_for_state_path
from sprintengine_core.tool.roles import require_configured_role
from sprintengine_core.tool.shell import assert_no_repo_dependency_cycle, worktree_for_task
from sprintengine_core.tool.state import *  # noqa: F403,F401

def task_produced_changes(state: Dict[str, Any], state_path: Path, task: Dict[str, Any]) -> bool:
    """Did this task produce a diff? The one input to publish-time phase routing.

    Worktree mode: task-scoped commits are the record of the task's changes, so a
    task with any commit produced a diff. Non-worktree mode: the working tree,
    scoped to owned + declared paths.

    This is the task's CUMULATIVE output, not "since the last publish". A task
    returned to `in_progress` by human feedback and re-published re-enters the walk
    and reviews the whole diff again — reviewing work already reviewed is cheap and
    safe; skipping review on a task that changed the codebase is not.

    When the answer cannot be determined (no git repository at all), this returns
    True: routing to review is the failure-safe direction.
    """
    from sprintengine_core.tool.shell import (
        get_run_vcs,
        task_scoped_dirty_paths,
        workspace_is_git_repository,
    )

    if get_run_vcs(state):
        commits = ensure_evidence(task).get("commits")
        return bool(isinstance(commits, list) and commits)
    if not workspace_is_git_repository(state_path):
        return True
    # Non-worktree change detection is scoped to the task's declared + owned paths.
    # If the task declared NO scope at all, we cannot tell what it touched -> route
    # to review, the same failure-safe direction as "no git repo" (E3 review finding).
    declared = task_diff_declared_paths(task)
    owned = [str(path) for path in task.get("ownedPaths", []) or []]
    if not declared and not owned:
        return True
    return bool(task_scoped_dirty_paths(state, state_path, task))


def publish_task(
    state: Dict[str, Any],
    state_path: Path,
    task: Dict[str, Any],
    actor: str,
    body: str,
    paths: Optional[List[str]] = None,
    data: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Record the implementation summary and route the task into its phase walk.

    Two steps, per decision 7. First change detection; then routing: no changes
    skips every phase and lands on `done` (the clean-sweep / analysis-only exit);
    changes enter `phases[0]`, or `done` when the task has no phases. Publish is the
    ONLY tool that enters the walk.
    """
    previous_status = str(task.get("status") or "")
    if previous_status != "in_progress":
        raise SystemExit("Only in_progress tasks can be published.")
    # `implementation_response` marks a publish that answers open feedback (the
    # human Inbox loop, Flow 5); a first publish is an `implementation_summary`.
    open_feedback_ids = [str(comment.get("id")) for comment in open_rework_comments(task) if comment.get("id")]
    if open_feedback_ids:
        comment = create_task_comment(
            state,
            task,
            actor=actor,
            body=body,
            comment_type="implementation_response",
            source="agent",
            paths=paths,
            data={**(data or {}), "feedbackCommentIds": open_feedback_ids},
        )
    else:
        comment = create_task_comment(
            state,
            task,
            actor=actor,
            body=body,
            comment_type="implementation_summary",
            source="agent",
            paths=paths,
            data=data,
        )

    produced_changes = task_produced_changes(state, state_path, task)
    phases = resolve_task_phases(state, task) if produced_changes else []
    next_status = phases[0] if phases else "done"
    published_at = now_iso()
    task["lastImplementedByAgentId"] = actor
    task["lastPublishedAt"] = published_at
    task["status"] = next_status
    task.pop("needsInput", None)
    if next_status == "done":
        task["completedAt"] = published_at
        task["ownerAgentId"] = None
        end_lease(task)
        # A plan/product approval task carries `phases: []`, so publishing it drives
        # it straight to done; resolve its draft placeholder like the other task-done
        # transitions. Imported lazily to avoid an artifacts<->tasks import cycle.
        from sprintengine_core.tool.artifacts import supersede_stale_gate_placeholder_on_completion
        supersede_stale_gate_placeholder_on_completion(state, task, actor)
    else:
        task["completedAt"] = None
        enter_phase(state, task, next_status, actor)

    append_task_activity(
        task,
        "status_change",
        actor,
        f"{actor} published {task.get('id')} to {next_status}.",
        {
            "status": next_status,
            "fromStatus": previous_status,
            "commentId": comment["id"],
            "producedChanges": produced_changes,
        },
    )
    return {
        "comment": comment,
        "nextStatus": next_status,
        "previousStatus": previous_status,
        "producedChanges": produced_changes,
        "phases": phases,
        "awaitingPhaseSession": task.get("awaitingPhaseSession"),
    }


def enter_phase(state: Dict[str, Any], task: Dict[str, Any], phase: str, actor: str) -> None:
    """Bind the task to whoever will run `phase`.

    Default (MC-1542): the owner stays bound through every phase — it is already
    in-session and mid-tool-call, and the phase directive is returned to it inline.

    Premium (MC-1543): when the run binds this phase to a DIFFERENT `{cli, model}`,
    the phase runs as a fresh, diff-seeded session on that runtime. The task is
    released from its implementer and marked `awaitingPhaseSession`; the supervisor
    spawns the bound session, which claims the task and becomes its owner.
    `lastImplementedByAgentId` is retained either way, so attribution survives.
    """
    if phase_needs_own_session(state, task, phase):
        task["ownerAgentId"] = None
        end_lease(task)
        task["awaitingPhaseSession"] = {"phase": phase, "runtime": dict(phase_runtime(state, phase))}
        append_task_activity(
            task,
            "status_change",
            actor,
            f"{task.get('id')} awaits a {phase} session on its bound runtime.",
            {"status": phase, "awaitingPhaseSession": phase},
        )
        return
    task.pop("awaitingPhaseSession", None)
    task["ownerAgentId"] = actor
    # The owner stays bound across the phase walk; refresh its lease so review /
    # needs_input stay bound to it and the expiry sweep measures from re-entry.
    mint_lease(task, actor, task.get("role"))


def task_awaiting_phase_session(task: Dict[str, Any]) -> Optional[str]:
    """The phase a task is waiting for a bound session to run, or None."""
    awaiting = task.get("awaitingPhaseSession")
    if not isinstance(awaiting, dict) or task.get("ownerAgentId"):
        return None
    phase = str(awaiting.get("phase") or "").strip()
    return phase if phase == str(task.get("status") or "") else None


def claim_phase_session(state: Dict[str, Any], task: Dict[str, Any], agent_id: str) -> Dict[str, Any]:
    """A bound phase session takes over ownership WITHOUT resetting the task.

    Unlike `assign_task` this never rewinds the status to `in_progress`: the diff is
    published and the task is mid-walk. It re-stamps the execution identity to the
    phase's runtime (that is what the operator is paying for) while leaving
    `lastImplementedByAgentId` alone, so the implementer stays identifiable.
    """
    phase = task_awaiting_phase_session(task)
    if not phase:
        raise SystemExit(f"Task {task.get('id')} is not awaiting a phase session.")
    runtime = task["awaitingPhaseSession"].get("runtime") or {}
    task.pop("awaitingPhaseSession", None)
    task["ownerAgentId"] = agent_id
    mint_lease(task, agent_id, task.get("role"))
    stamp_task_execution_identity(state, task, model=runtime.get("model"), cli=runtime.get("cli"))
    append_task_activity(
        task,
        "claim",
        agent_id,
        f"{agent_id} claimed the {phase} phase of {task.get('id')} on its bound runtime.",
        {"status": phase, "phase": phase},
    )
    return {"agent": worker_view(state, agent_id), "phase": phase}


def advance_task(
    state: Dict[str, Any],
    task: Dict[str, Any],
    actor: str,
    phase: str,
    outcome: str,
    summary: str,
    *,
    needs_input: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Move a task forward out of `phase`. The ONLY mutation that walks phases.

    Owner-only, and guarded on the phase matching the task's current status so a
    stale call from a resumed session cannot skip a phase. `pass`/`pass_with_fixes`
    step to the next phase (or `done`); `escalate` parks the task in `needs_input`
    while RECORDING the originating phase, so resolving the input returns it to that
    phase rather than to `in_progress`.
    """
    current_status = str(task.get("status") or "")
    clean_phase = str(phase or "").strip()
    if clean_phase not in VALID_TASK_PHASES:
        raise SystemExit(
            f"Invalid phase {clean_phase!r}; expected one of: {', '.join(VALID_TASK_PHASES)}."
        )
    if current_status != clean_phase:
        raise SystemExit(
            f"phase_mismatch: task {task.get('id')} is in {current_status!r}, not {clean_phase!r}. "
            "Re-read the task before advancing."
        )
    if outcome not in VALID_PHASE_OUTCOMES:
        raise SystemExit(f"Invalid outcome {outcome!r}; expected one of: {', '.join(sorted(VALID_PHASE_OUTCOMES))}.")
    owner = str(task.get("ownerAgentId") or "")
    if task_awaiting_phase_session(task):
        # MC-1543: the phase was released to a bound runtime and no session has
        # claimed it yet. A stale implementer (or any non-owner) must not advance
        # past the paid-for review — the bound session claims via `task.claim` first.
        raise SystemExit(
            f"awaiting_phase_session: {task.get('id')} is waiting for its bound "
            f"{task.get('status')} session to claim it; advance is not permitted until then."
        )
    if not owner:
        raise SystemExit(
            f"not_task_owner: {actor} cannot advance unowned task {task.get('id')}. "
            "Only a task's owner advances its phases."
        )
    if owner != actor:
        raise SystemExit(
            f"not_task_owner: {actor} does not own {task.get('id')} ({owner} does). "
            "Only a task's owner advances its phases."
        )
    clean_summary = str(summary or "").strip()
    if not clean_summary:
        raise SystemExit("--summary is required when advancing a phase.")

    now = now_iso()
    if outcome == "escalate":
        if not needs_input or not str(needs_input.get("question") or "").strip():
            raise SystemExit("An `escalate` outcome requires a needs-input question.")
        task["status"] = "needs_input"
        task["completedAt"] = None
        task["needsInput"] = {
            "kind": needs_input.get("kind") or "architect",
            "reason": needs_input.get("reason") or "blocked_other",
            "question": str(needs_input["question"]).strip(),
            "reportedBy": actor,
            "reportedAt": now,
            # Input resolution returns the task to the phase it escalated FROM, not
            # to in_progress. Only Flow-5 human feedback re-opens implementation.
            "originatingStatus": clean_phase,
        }
        if needs_input.get("suggestedResolution"):
            task["needsInput"]["suggestedResolution"] = str(needs_input["suggestedResolution"]).strip()
        comment = create_task_comment(
            state,
            task,
            actor=actor,
            body=clean_summary,
            comment_type="needs_input",
            source="agent",
            data={"phase": clean_phase, "outcome": outcome},
        )
        task.pop("awaitingPhaseSession", None)
        next_status = "needs_input"
        next_phase = None
    else:
        # Strictly forward, and a phase is visited at most once per walk: the next
        # phase is always the one AFTER this phase in the task's list.
        phases = resolve_task_phases(state, task)
        remaining = phases[phases.index(clean_phase) + 1:] if clean_phase in phases else []
        next_phase = remaining[0] if remaining else None
        next_status = next_phase or "done"
        task["status"] = next_status
        task.pop("needsInput", None)
        comment = create_task_comment(
            state,
            task,
            actor=actor,
            body=clean_summary,
            comment_type="implementation_summary",
            source="agent",
            data={"phase": clean_phase, "outcome": outcome},
        )
        if next_status == "done":
            task["completedAt"] = now
            task["ownerAgentId"] = None
            end_lease(task)
            task.pop("awaitingPhaseSession", None)
            from sprintengine_core.tool.artifacts import supersede_stale_gate_placeholder_on_completion
            supersede_stale_gate_placeholder_on_completion(state, task, actor)
        else:
            task["completedAt"] = None
            enter_phase(state, task, next_status, actor)

    append_task_activity(
        task,
        "status_change",
        actor,
        f"{actor} advanced {task.get('id')} out of {clean_phase} with {outcome}.",
        {"status": next_status, "fromStatus": clean_phase, "outcome": outcome, "commentId": comment["id"]},
    )
    return {
        "comment": comment,
        "nextStatus": next_status,
        "nextPhase": next_phase,
        "phase": clean_phase,
        "awaitingPhaseSession": task.get("awaitingPhaseSession"),
    }

def recompute_phase(state: Dict[str, Any]) -> bool:
    sprintengine = state.setdefault("sprintengine", {})
    # A canceled run is terminal: its status is the stored cancel flag, never
    # recomputed from task-completeness. Without this guard a run whose non-done
    # tasks were all moved to `canceled` would recompute to `completed` (the
    # done/canceled rollup below), erasing the cancel decision.
    if sprintengine.get("canceled"):
        return set_if_changed(sprintengine, "status", "canceled")
    tasks = state.get("tasks", [])
    if tasks and all(t.get("status") in {"done", "canceled"} for t in tasks):
        return set_if_changed(sprintengine, "status", "completed")
    if any(t.get("status") in RUN_EXECUTING_TASK_STATUSES for t in tasks):
        return set_if_changed(sprintengine, "status", "executing")
    return set_if_changed(sprintengine, "status", "planned" if tasks else "planning")

def ensure_evidence(task: Dict[str, Any]) -> Dict[str, Any]:
    ev = task.setdefault("evidence", {})
    ev.setdefault("summary", "")
    ev.setdefault("touchedFiles", [])
    ev.setdefault("commandsRan", [])
    ev.setdefault("results", [])
    ev.setdefault("scopeExpansions", [])
    return ev

def task_diff_capture_cwd(state: Dict[str, Any], state_path: Path, task: Dict[str, Any]) -> Path:
    """The checkout a task's diff evidence is read from: the tree its paths live in.

    Worktree mode: the task's own repo worktree, so review evidence for a sibling
    task is the sibling project's diff and not an empty read against the primary
    tree. Non-worktree mode: the workspace, which is the only repo such a run has.
    """
    return worktree_for_task(state, state_path, task) or workspace_root_for_state_path(state_path)

def task_diff_declared_paths(task: Dict[str, Any], extra_paths: Optional[List[str]] = None) -> List[str]:
    evidence = ensure_evidence(task)
    paths: List[str] = []
    paths.extend(evidence.get("touchedFiles", []) if isinstance(evidence.get("touchedFiles"), list) else [])
    paths.extend(extra_paths or [])
    latest = latest_implementation_comment(task)
    if latest and isinstance(latest.get("paths"), list):
        paths.extend(latest["paths"])
    return unique_strings(paths)

def refresh_task_diff_evidence(
    state: Dict[str, Any],
    state_path: Path,
    task: Dict[str, Any],
    actor: str,
    extra_paths: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    paths = task_diff_declared_paths(task, extra_paths)
    diffs = capture_task_diff_evidence(
        task_diff_capture_cwd(state, state_path, task),
        paths,
        actor=actor,
        captured_at=now_iso(),
    )
    ensure_evidence(task)["diffs"] = diffs
    if diffs:
        file_count = len(diffs)
        skipped_count = len([diff for diff in diffs if diff.get("skippedReason")])
        truncated_count = len([diff for diff in diffs if diff.get("truncated")])
        details = [f"{file_count} file{'s' if file_count != 1 else ''}"]
        if skipped_count:
            details.append(f"{skipped_count} skipped")
        if truncated_count:
            details.append(f"{truncated_count} truncated")
        append_task_activity(
            task,
            "evidence",
            actor,
            f"{actor} refreshed diff evidence for {task.get('id')} ({', '.join(details)}).",
        )
    return diffs

def task_is_ready(state: Dict[str, Any], task: Dict[str, Any]) -> bool:
    if task.get("status") != "todo" or task.get("ownerAgentId"):
        return False
    if task.get("needsTriage") is True:
        return False
    for dep_id in task.get("dependsOn", []):
        dep = next((t for t in state.get("tasks", []) if t.get("id") == dep_id), None)
        if dep is None or dep.get("status") != "done":
            return False
    return True

def refresh_materialized_ready_queue(state_path: Path, state: Dict[str, Any]) -> Dict[str, Any]:
    try:
        return folder_store.sync_state_to_store(state_path.parent, state, state_path=state_path)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc

def read_ready_task_ids(state: Dict[str, Any]) -> List[str]:
    tasks = [task for task in state.get("tasks", []) or [] if isinstance(task, dict)]
    try:
        ordered_ids = folder_store.validate_acyclic_task_graph(tasks)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc
    tasks_by_id = {str(task.get("id")): task for task in tasks if task.get("id")}
    return [
        task_id
        for task_id in ordered_ids
        if (task := tasks_by_id.get(task_id)) and task_is_ready(state, task)
    ]

def optional_non_empty_string(record: Dict[str, Any], key: str) -> Optional[str]:
    value = record.get(key)
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None

def normalize_task_source(raw: Any, task_id: str) -> Optional[Dict[str, Any]]:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise SystemExit(f"Task {task_id} source must be an object.")

    source_type = optional_non_empty_string(raw, "type")
    if source_type not in VALID_TASK_SOURCE_TYPES:
        raise SystemExit(
            f"Task {task_id} source.type must be one of: {', '.join(sorted(VALID_TASK_SOURCE_TYPES))}."
        )

    source: Dict[str, Any] = {"type": source_type}
    for key in ("externalId", "externalUrl", "repo", "title", "externalUpdatedAt", "syncedAt"):
        value = optional_non_empty_string(raw, key)
        if value is not None:
            source[key] = value
    if isinstance(raw.get("body"), str):
        source["body"] = raw["body"]

    sync_status = optional_non_empty_string(raw, "syncStatus")
    if sync_status is not None:
        if sync_status not in VALID_TASK_SOURCE_SYNC_STATUSES:
            raise SystemExit(
                f"Task {task_id} source.syncStatus must be one of: {', '.join(sorted(VALID_TASK_SOURCE_SYNC_STATUSES))}."
            )
        source["syncStatus"] = sync_status

    return source

def normalize_needs_input_kind(kind: Optional[str]) -> Optional[str]:
    """Resolve a needs_input kind alias to its canonical wire value.

    `planner` is the vocabulary a general-only run's agents are given (the lane is
    named for the architect but MEANS the run's planner), so accept it on input and
    store the canonical kind. One place applies the alias map; the CLI arg paths and
    the state normalizer both come through here.
    """
    if kind in LEGACY_NEEDS_INPUT_KIND_MAP:
        return LEGACY_NEEDS_INPUT_KIND_MAP[kind][0]
    return kind


def normalize_task_needs_input(raw: Any, task_id: str) -> Optional[Dict[str, Any]]:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise SystemExit(f"Task {task_id} needsInput must be an object.")

    kind = optional_non_empty_string(raw, "kind")
    legacy_default_reason = None
    if kind in LEGACY_NEEDS_INPUT_KIND_MAP:
        kind, legacy_default_reason = LEGACY_NEEDS_INPUT_KIND_MAP[kind]
    if kind not in VALID_NEEDS_INPUT_KINDS:
        raise SystemExit(
            f"Task {task_id} needsInput.kind must be one of: {', '.join(sorted(VALID_NEEDS_INPUT_KINDS))}."
        )

    needs_input: Dict[str, Any] = {"kind": kind}
    reason = optional_non_empty_string(raw, "reason")
    if reason is not None:
        needs_input["reason"] = reason
    elif legacy_default_reason:
        needs_input["reason"] = legacy_default_reason
    elif kind in NEEDS_INPUT_KIND_DEFAULT_REASONS:
        needs_input["reason"] = NEEDS_INPUT_KIND_DEFAULT_REASONS[kind]

    for key in ("question", "suggestedResolution", "reportedBy", "reportedAt", "artifactId"):
        value = optional_non_empty_string(raw, key)
        if value is not None:
            needs_input[key] = value
    return needs_input

def normalize_needs_triage(raw: Any, task_id: str) -> bool:
    if raw is None:
        return False
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, str):
        normalized = raw.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
    raise SystemExit(f"Task {task_id} needsTriage must be a boolean.")

def normalize_difficulty_percent_value(value: Any, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > 100:
        raise SystemExit(f"{field_name} must be an integer from 0 to 100.")
    return value

def normalize_task_difficulty(raw: Any, task_id: str) -> Optional[Dict[str, Any]]:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise SystemExit(f"Task {task_id} difficulty must be an object.")
    difficulty: Dict[str, Any] = {}
    for key in ("architectEstimatePct", "implementerActualPct"):
        if key in raw and raw.get(key) is not None:
            difficulty[key] = normalize_difficulty_percent_value(raw.get(key), f"Task {task_id} difficulty.{key}")
    for key in ("architectEstimateReason", "implementerActualReason"):
        value = optional_non_empty_string(raw, key)
        if value is not None:
            difficulty[key] = value
    assessments = raw.get("reviewerAssessments")
    if assessments is not None:
        if not isinstance(assessments, list):
            raise SystemExit(f"Task {task_id} difficulty.reviewerAssessments must be a list.")
        normalized_assessments: List[Dict[str, Any]] = []
        for index, raw_assessment in enumerate(assessments):
            if not isinstance(raw_assessment, dict):
                raise SystemExit(f"Task {task_id} difficulty.reviewerAssessments[{index}] must be an object.")
            dimension = optional_non_empty_string(raw_assessment, "dimension")
            if dimension not in VALID_DIFFICULTY_REVIEWER_DIMENSIONS:
                raise SystemExit(
                    f"Task {task_id} difficulty.reviewerAssessments[{index}].dimension must be one of: "
                    f"{', '.join(sorted(VALID_DIFFICULTY_REVIEWER_DIMENSIONS))}."
                )
            assessment = {
                "pct": normalize_difficulty_percent_value(
                    raw_assessment.get("pct"),
                    f"Task {task_id} difficulty.reviewerAssessments[{index}].pct",
                ),
                "dimension": dimension,
            }
            for key in ("reason", "reviewerAgentId", "reviewerRole", "phase", "capturedAt"):
                value = optional_non_empty_string(raw_assessment, key)
                if value is not None:
                    assessment[key] = value
            normalized_assessments.append(assessment)
        difficulty["reviewerAssessments"] = normalized_assessments
    return difficulty or None

def normalize_scope_expansion(raw: Any, task_id: str, index: int) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        raise SystemExit(f"Task {task_id} evidence.scopeExpansions entries must be objects.")

    path = str(raw.get("path") or "").strip()
    if not path:
        raise SystemExit(f"Task {task_id} evidence.scopeExpansions[{index}].path cannot be empty.")
    reject_absolute_path_values([path], f"Task {task_id} evidence.scopeExpansions[{index}].path")

    reason = str(raw.get("reason") or "").strip()
    if not reason:
        raise SystemExit(f"Task {task_id} evidence.scopeExpansions[{index}].reason cannot be empty.")

    expansion = {"path": path, "reason": reason}
    risk = str(raw.get("risk") or "").strip()
    if risk:
        expansion["risk"] = risk
    return expansion

def normalize_scope_expansions(raw: Any, task_id: str) -> List[Dict[str, Any]]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise SystemExit(f"Task {task_id} evidence.scopeExpansions must be a list.")
    return [normalize_scope_expansion(entry, task_id, index) for index, entry in enumerate(raw)]

def normalize_diff_evidence(raw: Any, task_id: str) -> List[Dict[str, Any]]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise SystemExit(f"Task {task_id} evidence.diffs must be a list.")
    normalized: List[Dict[str, Any]] = []
    for index, entry in enumerate(raw):
        if not isinstance(entry, dict):
            raise SystemExit(f"Task {task_id} evidence.diffs[{index}] must be an object.")
        path = str(entry.get("path") or "").strip()
        if not path:
            raise SystemExit(f"Task {task_id} evidence.diffs[{index}].path cannot be empty.")
        try:
            folder_store.validate_project_relative_path(path, field=f"Task {task_id} evidence.diffs[{index}].path")
        except ValueError as exc:
            raise SystemExit(str(exc)) from exc
        old_path = str(entry.get("oldPath") or "").strip()
        if old_path:
            try:
                folder_store.validate_project_relative_path(old_path, field=f"Task {task_id} evidence.diffs[{index}].oldPath")
            except ValueError as exc:
                raise SystemExit(str(exc)) from exc
        normalized.append(dict(entry))
    return normalized

def normalize_task(raw: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        raise SystemExit("Each task must be an object.")
    task_id = str(raw.get("id", "")).strip()
    title = str(raw.get("title", "")).strip()
    role = str(raw.get("role", "")).strip()
    if not task_id:
        raise SystemExit("Each task must have a non-empty id.")
    if not title:
        raise SystemExit(f"Task {task_id} must have a non-empty title.")
    role = require_configured_role(role, context=f"Task {task_id}")
    status = str(raw.get("status", "todo")).strip() or "todo"
    if status not in VALID_TASK_STATUSES:
        raise SystemExit(f"Task {task_id} has invalid status {status!r}.")
    ev = raw.get("evidence") if isinstance(raw.get("evidence"), dict) else {}
    owned_paths = [str(i).strip() for i in raw.get("ownedPaths", []) if str(i).strip()]
    touched_files = [str(i).strip() for i in ev.get("touchedFiles", []) if str(i).strip()]
    reject_absolute_path_values(owned_paths, f"Task {task_id} ownedPaths")
    reject_absolute_path_values(touched_files, f"Task {task_id} evidence.touchedFiles")
    task = {
        "id": task_id,
        "title": title,
        "description": str(raw.get("description", "")).strip(),
        "role": role,
        # Which of the run's declared repos this task works in. Shape only here —
        # `normalize_task` has no state to check membership against, so the run's
        # declared set is enforced at creation and claim by ensure_task_repo_declared.
        "repo": folder_store.task_repo(raw),
        "status": status,
        "ownerAgentId": raw.get("ownerAgentId") or None,
        "dependsOn": [str(i).strip() for i in raw.get("dependsOn", []) if str(i).strip()],
        "ownedPaths": owned_paths,
        "acceptanceCriteria": [str(i).strip() for i in raw.get("acceptanceCriteria", []) if str(i).strip()],
        "implementationNotes": [str(i).strip() for i in raw.get("implementationNotes", []) if str(i).strip()],
        "evidence": {
            "summary": str(ev.get("summary", "")).strip(),
            "touchedFiles": touched_files,
            "commandsRan": [str(i).strip() for i in ev.get("commandsRan", []) if str(i).strip()],
            "results": [str(i).strip() for i in ev.get("results", []) if str(i).strip()],
            "scopeExpansions": normalize_scope_expansions(ev.get("scopeExpansions"), task_id),
        },
        "notes": [str(i).strip() for i in raw.get("notes", []) if str(i).strip()],
        "startedAt": raw.get("startedAt") or None,
        "completedAt": raw.get("completedAt") or None,
        "needsTriage": normalize_needs_triage(raw.get("needsTriage"), task_id),
        # Execution identity: the CLI model/CLI that worked this task, stamped at
        # claim (see assign_task). Retained through handoff for attribution and
        # per-task usage metrics — a fact about the work, not lifecycle state.
        "model": optional_non_empty_string(raw, "model"),
        "cli": optional_non_empty_string(raw, "cli"),
    }
    diff_evidence = normalize_diff_evidence(ev.get("diffs"), task_id)
    if diff_evidence:
        task["evidence"]["diffs"] = diff_evidence
    commit_evidence = unique_strings([str(i).strip() for i in ev.get("commits", []) if str(i).strip()])
    if commit_evidence:
        task["evidence"]["commits"] = commit_evidence
    if "productFacing" in raw:
        task["productFacing"] = bool(raw.get("productFacing"))
    if "producesImplementation" in raw:
        task["producesImplementation"] = bool(raw.get("producesImplementation"))
    source = normalize_task_source(raw.get("source"), task_id)
    if source is not None:
        task["source"] = source
    needs_input = normalize_task_needs_input(raw.get("needsInput"), task_id)
    if needs_input is not None:
        task["needsInput"] = needs_input
    difficulty = normalize_task_difficulty(raw.get("difficulty"), task_id)
    if difficulty is not None:
        task["difficulty"] = difficulty
    if isinstance(raw.get("triage"), dict):
        task["triage"] = raw["triage"]
    phases = normalize_task_phases(raw.get("phases"), task_id)
    if phases is not None:
        task["phases"] = phases
    awaiting = raw.get("awaitingPhaseSession")
    if isinstance(awaiting, dict) and str(awaiting.get("phase") or "").strip():
        task["awaitingPhaseSession"] = awaiting
    return task

def parse_phases_arg(raw: Any) -> Optional[List[str]]:
    """Read a `--phases` / `phases` argument into an ordered list, or None.

    `None` (flag absent) inherits the run's `defaultPhases`. MCP passes a native
    array — including `[]` for "no phases". The CLI passes a comma-separated
    string, where `--phases ""` is the same explicit empty list. A bare string is
    NOT spread char-by-char (the house array-field scar tissue).
    """
    if raw is None:
        return None
    if isinstance(raw, list):
        candidates = [str(entry).strip() for entry in raw]
    elif isinstance(raw, str):
        candidates = [part.strip() for part in raw.split(",")]
    else:
        raise SystemExit("--phases must be a comma-separated string or an array of phase names.")
    values = [value for value in candidates if value]
    try:
        return folder_store.normalize_phase_list(values, field="--phases")
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc


def normalize_task_phases(raw: Any, task_id: str) -> Optional[List[str]]:
    """The task's ordered post-implementation phases, or None when unset.

    None means "inherit the run's `defaultPhases`" and is what a task written
    before the field existed reads as. `[]` is an explicit "no phases": publish
    routes straight to `done`.
    """
    if raw is None:
        return None
    try:
        return folder_store.normalize_phase_list(raw, field=f"Task {task_id} phases")
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc


def resolve_task_phases(state: Dict[str, Any], task: Dict[str, Any]) -> List[str]:
    """The phases this task actually walks: its own list, else the run's default."""
    phases = task.get("phases")
    if isinstance(phases, list):
        return [str(phase) for phase in phases]
    return run_default_phases(state)


def assert_phases_within_run_ceiling(state: Dict[str, Any], phases: List[str], task_id: str) -> None:
    """`defaultPhases` is default AND ceiling: a task may trim, never add.

    Rejecting here (rather than silently intersecting) is what makes "this run has
    no review step" an operator guarantee the architect cannot override.
    """
    allowed = run_default_phases(state)
    outside = [phase for phase in phases if phase not in allowed]
    if outside:
        raise SystemExit(
            f"phase_not_configured_for_run: task {task_id} requests phase(s) {', '.join(outside)}, "
            f"but this run's phases are {', '.join(allowed) or '(none)'}. A task may trim phases, never add them."
        )


def reject_absolute_path_values(values: Optional[List[str]], field: str) -> None:
    if not values:
        return
    for value in values:
        try:
            folder_store.validate_project_relative_path(str(value), field=field)
        except ValueError as exc:
            raise SystemExit(str(exc)) from exc

def next_task_id(tasks: List[Dict[str, Any]]) -> str:
    used = {str(t.get("id", "")) for t in tasks if isinstance(t, dict)}
    index = 1
    while f"T{index}" in used:
        index += 1
    return f"T{index}"

def build_task_from_args(args: argparse.Namespace, state: Dict[str, Any]) -> Dict[str, Any]:
    task_id = getattr(args, "task_id", None) or next_task_id(state.get("tasks", []))
    # Role legality is enforced against configuredRoles by ensure_role_in_roster in
    # the plan.add_task handler; a run with zero seated workers still admits tasks
    # for any enabled role, so there is no seated-roster precondition here.
    reject_absolute_path_values(getattr(args, "path", None), "--path")
    raw = {
        "id": task_id,
        "title": args.title,
        "description": getattr(args, "description", "") or "",
        "role": args.role,
        "repo": ensure_task_repo_declared(
            state, getattr(args, "repo", None), context=f"Task {task_id}"
        ),
        "status": "todo",
        "ownerAgentId": None,
        "dependsOn": getattr(args, "depends_on", None) or [],
        "ownedPaths": getattr(args, "path", None) or [],
        "acceptanceCriteria": getattr(args, "acceptance", None) or [],
        "implementationNotes": getattr(args, "note", None) or [],
        "evidence": {"summary": "", "touchedFiles": [], "commandsRan": [], "results": [], "scopeExpansions": []},
        "notes": getattr(args, "task_note", None) or [],
        "startedAt": None,
        "completedAt": None,
    }
    if getattr(args, "product_facing", False) and getattr(args, "not_product_facing", False):
        raise SystemExit("--product-facing and --not-product-facing cannot be used together.")
    if getattr(args, "product_facing", False):
        raw["productFacing"] = True
    elif getattr(args, "not_product_facing", False):
        raw["productFacing"] = False
    if getattr(args, "produces_implementation", False):
        raw["producesImplementation"] = True
    if getattr(args, "needs_triage", False):
        raw["needsTriage"] = True
    phases = parse_phases_arg(getattr(args, "phases", None))
    if phases is not None:
        assert_phases_within_run_ceiling(state, phases, task_id)
        raw["phases"] = phases
    if getattr(args, "difficulty_pct", None) is not None or str(getattr(args, "difficulty_reason", "") or "").strip():
        raw["difficulty"] = {}
        if getattr(args, "difficulty_pct", None) is not None:
            raw["difficulty"]["architectEstimatePct"] = getattr(args, "difficulty_pct")
        if str(getattr(args, "difficulty_reason", "") or "").strip():
            raw["difficulty"]["architectEstimateReason"] = getattr(args, "difficulty_reason")
    task = normalize_task(raw)
    existing_ids = {str(t.get("id")) for t in state.get("tasks", []) if isinstance(t, dict)}
    if task["id"] in existing_ids:
        raise SystemExit(f"Task id already exists: {task['id']}")
    missing = [dep for dep in task["dependsOn"] if dep not in existing_ids]
    if missing:
        raise SystemExit(f"Unknown dependency for {task['id']}: {', '.join(missing)}")
    try:
        folder_store.validate_acyclic_task_graph([*state.get("tasks", []), task])
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc
    assert_no_repo_dependency_cycle([*state.get("tasks", []), task])
    return task

def task_ids(state: Dict[str, Any]) -> set:
    return {str(t.get("id")) for t in state.get("tasks", []) if isinstance(t, dict) and t.get("id")}

def ensure_task_can_be_replanned(task: Dict[str, Any], force: bool = False) -> None:
    if force:
        return
    if task.get("status") != "todo" or task.get("ownerAgentId"):
        raise SystemExit(
            f"Task {task.get('id')} has already started. "
            "Use --force only if you intentionally want to replan active or completed work."
        )

def set_unique_list(task: Dict[str, Any], key: str, values: Optional[List[str]]) -> None:
    if values is None:
        return
    if key in {"ownedPaths", "touchedFiles"}:
        reject_absolute_path_values(values, key)
    task[key] = unique_strings(values)

def add_unique_values(task: Dict[str, Any], key: str, values: List[str]) -> List[str]:
    if key in {"ownedPaths", "touchedFiles"}:
        reject_absolute_path_values(values, key)
    existing = task.setdefault(key, [])
    seen = set(existing)
    added = []
    for value in values:
        item = str(value).strip()
        if not item or item in seen:
            continue
        existing.append(item)
        seen.add(item)
        added.append(item)
    return added

def add_unique_scope_expansions(evidence: Dict[str, Any], expansions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    existing = evidence.setdefault("scopeExpansions", [])
    seen = {
        (
            str(item.get("path") or ""),
            str(item.get("reason") or ""),
            str(item.get("risk") or ""),
        )
        for item in existing
        if isinstance(item, dict)
    }
    added = []
    for expansion in expansions:
        key = (
            str(expansion.get("path") or ""),
            str(expansion.get("reason") or ""),
            str(expansion.get("risk") or ""),
        )
        if key in seen:
            continue
        existing.append(expansion)
        seen.add(key)
        added.append(expansion)
    return added

def remove_values(task: Dict[str, Any], key: str, values: List[str]) -> List[str]:
    targets = {str(value).strip() for value in values if str(value).strip()}
    before = [str(value) for value in task.get(key, [])]
    task[key] = [value for value in before if value not in targets]
    return [value for value in before if value in targets]

def task_dependents(state: Dict[str, Any], task_id: str) -> List[str]:
    return [
        str(task.get("id"))
        for task in state.get("tasks", [])
        if isinstance(task, dict) and task_id in task.get("dependsOn", [])
    ]
