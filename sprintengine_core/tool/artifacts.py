"""Artifact path, metadata, and review-state helpers."""
from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
from typing import Any, Dict, List, Optional

from sprintengine_core.tool.common import path_is_relative_to, unique_strings
from sprintengine_core.tool.constants import *  # noqa: F403,F401
from sprintengine_core.tool.gates import open_required_quality_gates
from sprintengine_core.tool.paths import MULTICODE_DIR_NAME, SPRINTENGINE_DIR_NAME, now_iso
from sprintengine_core.tool.state import *  # noqa: F403,F401

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
        "kind": args.kind,
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

def mark_task_needs_input_for_artifact(state: Dict[str, Any], task: Dict[str, Any], artifact: Optional[Dict[str, Any]] = None) -> None:
    task["status"] = "needs_input"
    task["completedAt"] = None
    artifact_id = str(artifact.get("id") or "").strip() if isinstance(artifact, dict) else ""
    artifact_title = str(artifact.get("title") or "").strip() if isinstance(artifact, dict) else ""
    task["needsInput"] = {
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
    owner_id = task.get("ownerAgentId")
    if owner_id:
        agent = ensure_agent(state, owner_id, task.get("role"))
        agent["status"] = "needs_input"
        agent["currentTaskId"] = task.get("id")
    append_task_activity(
        task,
        "needs_input",
        str((artifact or {}).get("createdBy") or task.get("ownerAgentId") or task.get("role") or "agent"),
        task["needsInput"]["question"],
        {"artifactId": artifact_id},
    )

def mark_task_done_if_artifacts_approved(state: Dict[str, Any], task: Dict[str, Any]) -> bool:
    linked_artifacts = blocking_artifacts_for_task(state, str(task.get("id")))
    if not linked_artifacts or any(a.get("status") != "approved" for a in linked_artifacts):
        return False
    if open_required_quality_gates(task):
        return False

    task["status"] = "done"
    task.pop("needsInput", None)
    task["completedAt"] = now_iso()
    append_task_activity(task, "status_change", str(task.get("ownerAgentId") or task.get("role") or "agent"), f"Task {task.get('id')} completed after artifact approval.", {"status": "done"})
    cleared = clear_task_refs(state, str(task.get("id")))
    owner_id = task.get("ownerAgentId")
    if owner_id:
        set_agent_idle(ensure_agent(state, owner_id, task.get("role")))
    for agent_id in cleared:
        if agent_id != owner_id:
            set_agent_idle(ensure_agent(state, agent_id))
    return True

def resolve_task_input(
    state: Dict[str, Any],
    task: Dict[str, Any],
    actor: str,
    resolution: str,
    complete: bool = False,
) -> Dict[str, Any]:
    if task.get("status") != "needs_input":
        raise SystemExit("Only needs_input tasks can be resolved.")
    owner_id = str(task.get("ownerAgentId") or "").strip()
    if not complete and not owner_id:
        raise SystemExit("Cannot resume a needs_input task without an owner. Use --complete or release the task.")
    now = now_iso()
    needs_input = task.get("needsInput") if isinstance(task.get("needsInput"), dict) else {}
    needs_input = dict(needs_input)
    needs_input.update({
        "resolvedBy": actor,
        "resolvedAt": now,
        "resolution": resolution,
        "resumeRequestedAt": now,
    })
    task["needsInput"] = needs_input
    task.setdefault("notes", []).append(f"INPUT RESOLVED by {actor}: {resolution}")
    append_task_activity(task, "needs_input", actor, f"Input resolved: {resolution}", {"status": "done" if complete else "in_progress"})

    if complete:
        task["status"] = "done"
        task["completedAt"] = now
        if owner_id:
            set_agent_idle(ensure_agent(state, owner_id, task.get("role")))
        clear_task_refs(state, str(task.get("id")))
        return {"status": "done", "ownerAgentId": owner_id or None}

    task["status"] = "in_progress"
    task["completedAt"] = None
    if not task.get("startedAt"):
        task["startedAt"] = now
    if owner_id:
        agent = ensure_agent(state, owner_id, task.get("role"))
        agent["status"] = "running"
        agent["currentTaskId"] = task.get("id")
    return {"status": "in_progress", "ownerAgentId": owner_id or None}

def release_task_from_owner(state: Dict[str, Any], task: Dict[str, Any], actor: str, reason: str) -> Dict[str, Any]:
    if task.get("status") not in ACTIVE_TASK_STATUSES:
        raise SystemExit("Only in_progress or needs_input tasks can be released.")
    previous_owner_id = str(task.get("ownerAgentId") or "").strip()
    if previous_owner_id:
        set_agent_idle(ensure_agent(state, previous_owner_id, task.get("role")))
    clear_task_refs(state, str(task.get("id")))
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
    owner = state.get("agents", {}).get(owner_id) if owner_id else None
    owner_still_active = (
        bool(owner_id)
        and isinstance(owner, dict)
        and owner.get("currentTaskId") == task.get("id")
        and owner.get("status") in {"running", "needs_input"}
    )

    if owner_still_active:
        task["status"] = "in_progress"
        task.pop("needsInput", None)
        agent = ensure_agent(state, str(owner_id), task.get("role"))
        agent["status"] = "running"
        agent["currentTaskId"] = task.get("id")
        append_task_activity(task, "status_change", str(owner_id), "Task reopened for artifact changes.", {"status": "in_progress"})
        return "in_progress"

    clear_task_refs(state, str(task.get("id")))
    task["ownerAgentId"] = None
    task["status"] = "todo"
    task.pop("needsInput", None)
    append_task_activity(task, "status_change", str(task.get("role") or "agent"), "Task reopened for artifact changes.", {"status": "todo"})
    return "todo"
