"""Artifact path, metadata, and review-state helpers."""
from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
from typing import Any, Dict, List, Optional

from sprintengine_core.tool.common import path_is_relative_to, unique_strings
from sprintengine_core.tool.constants import *  # noqa: F403,F401
from sprintengine_core.tool.paths import MULTICODE_DIR_NAME, SPRINTENGINE_DIR_NAME, now_iso
from sprintengine_core.tool.state import *  # noqa: F403,F401
from sprintengine_core.tool.task_reviews import assert_task_can_complete

def repository_root_for_state(state_path: Path) -> Path:
    starts = [Path.cwd().resolve(), state_path.parent.resolve()]
    seen = set()
    for start in starts:
        for candidate in [start, *start.parents]:
            key = str(candidate)
            if key in seen:
                continue
            seen.add(key)
            if (candidate / ".git").exists():
                return candidate
    if state_path.parent.parent.name == SPRINTENGINE_DIR_NAME and state_path.parent.parent.parent.name == MULTICODE_DIR_NAME:
        return state_path.parent.parent.parent.parent.resolve()
    if state_path.parent.parent.name == SPRINTENGINE_DIR_NAME:
        return state_path.parent.parent.parent.resolve()
    return state_path.parent.resolve()

def artifact_absolute_path(state_path: Path, value: str) -> Path:
    raw = Path(value)
    if raw.is_absolute():
        return raw.resolve()

    team_dir = state_path.parent.resolve()
    repo_root = repository_root_for_state(state_path)
    candidates = [(repo_root / raw).resolve(), (team_dir / raw).resolve()]
    for candidate in candidates:
        if path_is_relative_to(candidate, team_dir):
            return candidate
    return candidates[0]

def project_relative_display_path(state_path: Path, path: Path) -> str:
    absolute = path.resolve()
    repo_root = repository_root_for_state(state_path)
    if path_is_relative_to(absolute, repo_root):
        return absolute.relative_to(repo_root).as_posix()
    return path.as_posix()

def normalize_artifact_path(state_path: Path, value: str, require_file: bool = False) -> Dict[str, Any]:
    raw = str(value).strip()
    if not raw:
        raise SystemExit("Artifact path cannot be empty.")
    if Path(raw).is_absolute():
        raise SystemExit(
            "Artifact path must be project-root-relative, not absolute: "
            f"{raw}"
        )

    team_dir = state_path.parent.resolve()
    repo_root = repository_root_for_state(state_path)
    absolute = artifact_absolute_path(state_path, raw)
    if not path_is_relative_to(absolute, team_dir):
        raise SystemExit(
            "Artifact path must stay under the active Sprint Engine team folder: "
            f"{team_dir}"
        )
    if absolute.exists() and not absolute.is_file():
        raise SystemExit(f"Artifact path must be a file, not a directory: {absolute}")
    if require_file and not absolute.is_file():
        raise SystemExit(f"Artifact file not found: {absolute}")

    if path_is_relative_to(absolute, repo_root):
        stored = absolute.relative_to(repo_root).as_posix()
    else:
        stored = absolute.relative_to(team_dir).as_posix()
    return {"path": stored, "absolutePath": absolute}

def file_fingerprint(path: Path) -> Optional[str]:
    if not path.is_file():
        return None
    return hashlib.sha256(path.read_bytes()).hexdigest()

def next_artifact_id(artifacts: List[Dict[str, Any]]) -> str:
    used = {str(a.get("id", "")) for a in artifacts if isinstance(a, dict)}
    index = 1
    while f"A{index}" in used:
        index += 1
    return f"A{index}"

def find_artifact(state: Dict[str, Any], artifact_id: str) -> Dict[str, Any]:
    for artifact in state.get("artifacts", []):
        if isinstance(artifact, dict) and artifact.get("id") == artifact_id:
            return artifact
    raise SystemExit(f"Artifact not found: {artifact_id}")

def artifacts_for_task(state: Dict[str, Any], task_id: str) -> List[Dict[str, Any]]:
    return [
        artifact
        for artifact in state.get("artifacts", [])
        if isinstance(artifact, dict) and artifact.get("taskId") == task_id
    ]

def blocking_artifacts_for_task(state: Dict[str, Any], task_id: str) -> List[Dict[str, Any]]:
    return [
        artifact
        for artifact in artifacts_for_task(state, task_id)
        if artifact.get("status", "draft") in APPROVAL_BLOCKING_ARTIFACT_STATUSES
    ]

def ensure_artifact_history(artifact: Dict[str, Any]) -> List[Dict[str, Any]]:
    history = artifact.setdefault("reviewHistory", [])
    if not isinstance(history, list):
        artifact["reviewHistory"] = []
    return artifact["reviewHistory"]

def append_artifact_history(
    artifact: Dict[str, Any],
    action: str,
    actor: str,
    note: Optional[str] = None,
) -> Dict[str, Any]:
    entry = {"action": action, "actor": actor, "timestamp": now_iso()}
    if note:
        entry["note"] = note
    ensure_artifact_history(artifact).append(entry)
    return entry

def build_artifact_from_args(args: argparse.Namespace, state: Dict[str, Any], state_path: Path) -> Dict[str, Any]:
    # The CLI enforces kind via argparse choices, but the MCP server builds the
    # namespace directly, so the contract must also be enforced here: an
    # unknown kind silently breaks artifact review and auto-approval downstream.
    kind = str(getattr(args, "kind", "") or "").strip()
    if kind not in VALID_ARTIFACT_KINDS:
        raise SystemExit(
            f"Invalid artifact kind: {kind or '(empty)'}. "
            f"Valid kinds: {', '.join(sorted(VALID_ARTIFACT_KINDS))}."
        )
    task = find_task(state, args.task_id)
    artifact_id = args.artifact_id or next_artifact_id(state.setdefault("artifacts", []))
    if any(isinstance(a, dict) and a.get("id") == artifact_id for a in state.get("artifacts", [])):
        raise SystemExit(f"Artifact id already exists: {artifact_id}")

    path_info = normalize_artifact_path(state_path, args.path)
    absolute_path = path_info["absolutePath"]
    created_by = args.created_by or task.get("ownerAgentId") or args.actor
    now = now_iso()
    return {
        "id": artifact_id,
        "kind": kind,
        "title": args.title.strip(),
        "path": path_info["path"],
        "status": "draft",
        "createdBy": created_by,
        "taskId": args.task_id,
        "fingerprint": file_fingerprint(absolute_path),
        "reviewHistory": [{"action": "created", "actor": args.actor, "timestamp": now}],
        "recommendedTasks": unique_strings(args.recommended_task or []),
        "createdAt": now,
        "updatedAt": now,
    }

def stamp_implementer_from_owner(task: Dict[str, Any]) -> None:
    """Record the departing owner as the task's implementer before an owner clear.

    The publish and advance done-writers stamp `lastImplementedByAgentId` from
    their actor; the artifact-approval and input-resolution writers complete a
    task on the USER's action, so the truthful implementer is the owner being
    cleared. Without the stamp the projection's worker derivation (store.py)
    forgets the worker entirely. No-op when the task was never claimed — an
    ownerless done gate genuinely has no implementer.
    """
    owner = str(task.get("ownerAgentId") or "").strip()
    if owner:
        task["lastImplementedByAgentId"] = owner

def mark_task_needs_input_for_artifact(state: Dict[str, Any], task: Dict[str, Any], artifact: Optional[Dict[str, Any]] = None) -> None:
    task["status"] = "needs_input"
    task["completedAt"] = None
    artifact_id = str(artifact.get("id") or "").strip() if isinstance(artifact, dict) else ""
    artifact_title = str(artifact.get("title") or "").strip() if isinstance(artifact, dict) else ""
    task["needsInput"] = {
        # The planner-routed lane (PLANNER_ROUTED_NEEDS_INPUT_KINDS), not a literal
        # architect: triage resolves the actor with `resolve_planning_role`, so this
        # reaches the general in a general-only run. The wire value stays `architect`
        # because the renderer and every run.yaml on disk read it.
        "kind": "architect",
        "reason": "artifact_review",
        **({"artifactId": artifact_id} if artifact_id else {}),
        "question": (
            f"Artifact {artifact_id} ({artifact_title}) is ready for review."
            if artifact_id and artifact_title
            else "A linked artifact is ready for review."
        ),
        "suggestedResolution": "Review the artifact, adjudicate recommended follow-up tasks, then approve/request changes or resolve the blocked task.",
        "reportedBy": str((artifact or {}).get("createdBy") or task.get("ownerAgentId") or task.get("role") or "agent"),
        "reportedAt": now_iso(),
    }
    append_task_activity(
        task,
        "needs_input",
        str((artifact or {}).get("createdBy") or task.get("ownerAgentId") or task.get("role") or "agent"),
        task["needsInput"]["question"],
        {"artifactId": artifact_id},
    )

def mark_task_done_if_artifacts_approved(state: Dict[str, Any], task: Dict[str, Any]) -> bool:
    from sprintengine_core.tool.integration_proof import is_proof_task

    if is_proof_task(task):
        # Integration-proof artifacts are evidence, not a generic approval
        # gate. Only proof.record or the app-only human gesture may complete
        # the canonical proof task.
        return False
    linked_artifacts = blocking_artifacts_for_task(state, str(task.get("id")))
    if not linked_artifacts or any(a.get("status") != "approved" for a in linked_artifacts):
        return False

    assert_task_can_complete(state, task)
    task["status"] = "done"
    task.pop("needsInput", None)
    task["completedAt"] = now_iso()
    append_task_activity(task, "status_change", str(task.get("ownerAgentId") or task.get("role") or "agent"), f"Task {task.get('id')} completed after artifact approval.", {"status": "done"})
    # A done task holds no owner. One of five independent task->done writers; each
    # must clear it, because there is no single choke point to hook.
    # Stamp the implementer BEFORE clearing: the projection derives done-task
    # workers only from lastImplementedByAgentId (store.py), so dropping the
    # owner unstamped erases the worker while its terminal may still be live.
    # A live terminal with no worker record is a ghost seat: the supervisor can
    # neither wake it (no runtime record) nor replace it (running id blocks the
    # pool spawn) — for a planner that starves every later task of the role.
    stamp_implementer_from_owner(task)
    task["ownerAgentId"] = None
    return True

def find_reusable_artifact(
    state: Dict[str, Any],
    state_path: Path,
    task_id: str,
    kind: str,
    resolved_path: Path,
    exclude_id: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Return an existing non-superseded artifact for the same task and kind that
    resolves to the same absolute file, so registration can reuse it instead of
    creating a second artifact that would deadlock auto-approval. A duplicate
    resolving to a genuinely different file is not a match."""
    for artifact in state.get("artifacts", []):
        if not isinstance(artifact, dict):
            continue
        if exclude_id and artifact.get("id") == exclude_id:
            continue
        if artifact.get("taskId") != task_id or artifact.get("kind") != kind:
            continue
        if artifact.get("status") == "superseded":
            continue
        candidate_path = str(artifact.get("path") or "")
        if not candidate_path:
            continue
        if artifact_absolute_path(state_path, candidate_path) == resolved_path:
            return artifact
    return None

def supersede_duplicate_artifacts(
    state: Dict[str, Any],
    surviving_artifact: Dict[str, Any],
    state_path: Path,
    actor: str,
) -> List[str]:
    """Supersede stale non-approved, non-superseded duplicates that share the
    surviving artifact's task, kind, and resolved absolute file. Invoked when an
    artifact transitions to ready_for_review or approved so a stale placeholder
    cannot keep blocking auto-approval. Approved siblings are never superseded,
    and a duplicate resolving to a genuinely different file is left untouched."""
    task_id = str(surviving_artifact.get("taskId") or "")
    kind = str(surviving_artifact.get("kind") or "")
    path = str(surviving_artifact.get("path") or "")
    if not task_id or not kind or not path:
        return []

    surviving_path = artifact_absolute_path(state_path, path)
    superseded_ids: List[str] = []
    for artifact in state.get("artifacts", []):
        if not isinstance(artifact, dict):
            continue
        if artifact.get("id") == surviving_artifact.get("id"):
            continue
        if artifact.get("taskId") != task_id or artifact.get("kind") != kind:
            continue
        if artifact.get("status") in {"approved", "superseded"}:
            continue
        if artifact.get("status", "draft") not in APPROVAL_BLOCKING_ARTIFACT_STATUSES:
            continue
        candidate_path = str(artifact.get("path") or "")
        if not candidate_path:
            continue
        if artifact_absolute_path(state_path, candidate_path) != surviving_path:
            continue

        artifact["status"] = "superseded"
        artifact["updatedAt"] = now_iso()
        append_artifact_history(
            artifact,
            "superseded",
            actor,
            f"Superseded by duplicate artifact {surviving_artifact.get('id')} ({surviving_artifact.get('status')}).",
        )
        superseded_ids.append(str(artifact.get("id") or ""))
    return superseded_ids

# Kinds of the plan/product approval-gate placeholder artifact seeded as `draft`
# by ensure_plan_approval_gate / ensure_product_intake_gate. The placeholder only
# becomes `approved` when its file is published and approved; if the gate task is
# instead marked done directly, the placeholder is never actioned.
GATE_PLACEHOLDER_ARTIFACT_KINDS = {"architect_plan", "requirements"}

def supersede_stale_gate_placeholder_on_completion(
    state: Dict[str, Any],
    task: Dict[str, Any],
    actor: str,
) -> List[str]:
    """Self-heal the plan/product approval gate: when its gate task reaches `done`,
    a placeholder artifact seeded as `draft` at run creation and never published or
    approved must not survive as a live `draft`. Supersede those draft placeholders
    so no artifact stays `draft` while its task is `done`, mirroring
    supersede_duplicate_artifacts. Only the never-actioned `draft` placeholder is
    resolved; an `approved`, `superseded`, or in-review placeholder is left as is."""
    if task.get("status") != "done":
        return []
    task_id = str(task.get("id") or "")
    if not task_id:
        return []
    superseded_ids: List[str] = []
    for artifact in artifacts_for_task(state, task_id):
        if artifact.get("kind") not in GATE_PLACEHOLDER_ARTIFACT_KINDS:
            continue
        if artifact.get("status") != "draft":
            continue
        artifact["status"] = "superseded"
        artifact["updatedAt"] = now_iso()
        append_artifact_history(
            artifact,
            "superseded",
            actor,
            f"Superseded unpublished placeholder when gate task {task_id} completed.",
        )
        superseded_ids.append(str(artifact.get("id") or ""))
    return superseded_ids

def resolve_task_input(
    state: Dict[str, Any],
    task: Dict[str, Any],
    actor: str,
    resolution: str,
    complete: bool = False,
) -> Dict[str, Any]:
    """Unblock a needs_input task and hand it back to its owner.

    A mid-phase `escalate` recorded the phase it escalated FROM
    (`needsInput.originatingStatus`), so resolution returns the task to THAT phase,
    not to `in_progress` — the owner resumes reviewing, it does not re-implement.
    Anything else resumes implementation.
    """
    if task.get("status") != "needs_input":
        raise SystemExit("Only needs_input tasks can be resolved.")
    if complete:
        from sprintengine_core.tool.integration_proof import is_proof_task

        if is_proof_task(task):
            raise SystemExit("integration_proof_uses_proof_record: ordinary input resolution cannot complete a proof task.")
    owner_id = str(task.get("ownerAgentId") or "").strip()
    if not complete and not owner_id:
        raise SystemExit("Cannot resume a needs_input task without an owner. Use --complete or release the task.")
    now = now_iso()
    needs_input = task.get("needsInput") if isinstance(task.get("needsInput"), dict) else {}
    needs_input = dict(needs_input)
    originating_status = str(needs_input.get("originatingStatus") or "").strip()
    resume_status = originating_status if originating_status in VALID_TASK_PHASES else "in_progress"
    needs_input.update({
        "resolvedBy": actor,
        "resolvedAt": now,
        "resolution": resolution,
        "resumeRequestedAt": now,
    })
    task["needsInput"] = needs_input
    task.setdefault("notes", []).append(f"INPUT RESOLVED by {actor}: {resolution}")
    append_task_activity(task, "needs_input", actor, f"Input resolved: {resolution}", {"status": "done" if complete else resume_status})

    if complete:
        assert_task_can_complete(state, task)
        task["status"] = "done"
        task["completedAt"] = now
        supersede_stale_gate_placeholder_on_completion(state, task, actor)
        # A done task holds no owner (see mark_task_done_if_artifacts_approved,
        # including why the implementer stamp must precede the clear).
        stamp_implementer_from_owner(task)
        task["ownerAgentId"] = None
        return {"status": "done", "ownerAgentId": owner_id or None, "resumePhase": None}

    task["status"] = resume_status
    task["completedAt"] = None
    if not task.get("startedAt"):
        task["startedAt"] = now
    return {
        "status": resume_status,
        "ownerAgentId": owner_id or None,
        "resumePhase": resume_status if resume_status != "in_progress" else None,
    }

def release_task_from_owner(state: Dict[str, Any], task: Dict[str, Any], actor: str, reason: str) -> Dict[str, Any]:
    """Architect override: take a task off its owner and return it to the queue.

    Allowed from any owned status, including `review` — an owner stuck mid-phase is
    exactly what this exists for. The task restarts from `todo`: a fresh owner claims
    it, re-implements or confirms, and re-enters the walk at its next publish.
    """
    if task.get("status") not in ACTIVE_TASK_STATUSES:
        raise SystemExit(
            f"Only owned tasks ({', '.join(sorted(ACTIVE_TASK_STATUSES))}) can be released."
        )
    previous_owner_id = str(task.get("ownerAgentId") or "").strip()
    task["ownerAgentId"] = None
    task["status"] = "todo"
    task["startedAt"] = None
    task["completedAt"] = None
    task.pop("needsInput", None)
    task.setdefault("notes", []).append(f"RELEASED by {actor}: {reason}")
    append_task_activity(task, "status_change", actor, f"Task released: {reason}", {"status": "todo"})
    return {"previousOwnerAgentId": previous_owner_id or None, "status": "todo"}

def reopen_task_for_artifact_changes(state: Dict[str, Any], task: Dict[str, Any]) -> str:
    task["completedAt"] = None
    owner_id = task.get("ownerAgentId")
    # Lease authority (MC-1591): the owner is still bound when the task holds an
    # active lease it owns — an active status still owned by owner_id — rather than
    # the deleted agents-map mirror pointer. ownerAgentId is the lease's
    # denormalized owner, cleared when the task leaves an active status.
    owner_still_active = bool(owner_id) and str(task.get("status") or "") in ACTIVE_TASK_STATUSES

    if owner_still_active:
        task["status"] = "in_progress"
        task.pop("needsInput", None)
        append_task_activity(task, "status_change", str(owner_id), "Task reopened for artifact changes.", {"status": "in_progress"})
        return "in_progress"

    task["ownerAgentId"] = None
    task["status"] = "todo"
    task.pop("needsInput", None)
    append_task_activity(task, "status_change", str(task.get("role") or "agent"), "Task reopened for artifact changes.", {"status": "todo"})
    return "todo"
