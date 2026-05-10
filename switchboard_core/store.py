from __future__ import annotations

import json
import os
import re
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator


TASK_STATUSES = (
    "planning",
    "todo",
    "ready",
    "in_progress",
    "testing",
    "testing_in_progress",
    "review",
    "review_in_progress",
    "done",
    "canceled",
)
FOLDER_STATUSES = ("inbox", *TASK_STATUSES)
CLAIMABLE_STATUSES = ("ready", "testing", "review")
PUBLISH_TARGETS = ("testing", "review", "done")
RUNNER_PROVIDERS = ("desktop-terminal", "headless-process", "codex-app-server")
RUNNER_EVENTS = {
    "start",
    "pause",
    "resume",
    "tick",
    "claim",
    "launch",
    "provider_error",
    "provider_execution_untracked",
    "execution_missing",
    "execution_stale",
    "execution_link_failed",
    "task_published",
    "task_abandoned",
    "requeue",
}
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

MOVE_TRANSITIONS: dict[str, set[str]] = {
    "planning": {"todo", "canceled"},
    "todo": {"planning", "ready", "canceled"},
    "ready": {"todo", "in_progress", "canceled"},
    "in_progress": {"ready", "testing", "canceled"},
    "testing": {"in_progress", "testing_in_progress", "canceled"},
    "testing_in_progress": {"testing", "review", "canceled"},
    "review": {"testing", "review_in_progress", "canceled"},
    "review_in_progress": {"review", "done", "canceled"},
    "done": {"review", "canceled"},
    "canceled": set(),
}
CLAIM_TRANSITIONS = {
    "ready": "in_progress",
    "testing": "testing_in_progress",
    "review": "review_in_progress",
}
PUBLISH_TRANSITIONS = {
    "in_progress": "testing",
    "testing_in_progress": "review",
    "review_in_progress": "done",
}
REQUEUE_TRANSITIONS = {
    "in_progress": "ready",
    "testing_in_progress": "testing",
    "review_in_progress": "review",
}
SOURCE_TYPES = {"manual", "watchtower", "github", "jira", "campaign", "sprintengine"}
COMMENT_KINDS = {"comment", "status_change", "claim", "evidence", "import"}
AUTHOR_TYPES = {"user", "agent", "system"}
STALE_LOCK_SECONDS = 5 * 60


class SwitchboardError(Exception):
    """Operator-facing CLI error."""


@dataclass(frozen=True)
class LocatedTask:
    task: dict[str, Any]
    folder_status: str
    path: Path
    warnings: list[str]


@dataclass(frozen=True)
class FolderLock:
    folder: Path
    lock_dir: Path
    lock_file: Path


@dataclass(frozen=True)
class LockStatus:
    folder_status: str
    path: Path
    locked: bool
    stale: bool
    owner: str | None
    session_id: str | None
    created_at: str | None
    heartbeat_at: str | None
    age_seconds: float | None


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def switchboard_root(workspace: Path) -> Path:
    workspace_root = workspace.expanduser().resolve()
    return workspace_root / ".multi-code" / "switchboard"


def folder_relative_path(status: str) -> Path:
    if status == "inbox":
        return Path("inbox")
    if status in TASK_STATUSES:
        return Path("tasks") / status
    raise SwitchboardError(f"Invalid Switchboard status: {status}")


def folder_path(workspace: Path, status: str) -> Path:
    return switchboard_root(workspace) / folder_relative_path(status)


def task_path(workspace: Path, status: str, task_id: str) -> Path:
    validate_task_id(task_id)
    return folder_path(workspace, status) / f"{task_id}.json"


def validate_task_id(task_id: str) -> None:
    if not UUID_RE.match(task_id):
        raise SwitchboardError("Switchboard task id must be a UUID.")


def init_workspace(workspace: Path) -> dict[str, Any]:
    root = switchboard_root(workspace)
    root.mkdir(parents=True, exist_ok=True)
    (root / "artifacts").mkdir(parents=True, exist_ok=True)
    (root / "watchtower-runs").mkdir(parents=True, exist_ok=True)
    runner = root / "runner"
    runner.mkdir(parents=True, exist_ok=True)
    events = runner / "events.jsonl"
    if not events.exists():
        events.write_text("", encoding="utf-8")
    folders: list[str] = []
    for status in FOLDER_STATUSES:
        current = folder_path(workspace, status)
        current.mkdir(parents=True, exist_ok=True)
        lock_file = current / "Lock"
        if not lock_file.exists():
            lock_file.write_text(json.dumps({"locked": False}, indent=2) + "\n", encoding="utf-8")
        folders.append(str(current))
    return {
        "ok": True,
        "workspaceRoot": str(workspace.expanduser().resolve()),
        "switchboardRoot": str(root),
        "folders": folders,
    }


def runner_dir(workspace: Path) -> Path:
    return switchboard_root(workspace) / "runner"


def runner_state_path(workspace: Path) -> Path:
    return runner_dir(workspace) / "state.json"


def runner_events_path(workspace: Path) -> Path:
    return runner_dir(workspace) / "events.jsonl"


def normalize_runner_queues(queues: list[str] | None) -> list[str]:
    selected = queues if queues else list(CLAIMABLE_STATUSES)
    normalized: list[str] = []
    for queue in selected:
        if queue in CLAIMABLE_STATUSES and queue not in normalized:
            normalized.append(queue)
    return normalized or list(CLAIMABLE_STATUSES)


def normalize_runner_concurrency(value: Any) -> int:
    if not isinstance(value, int):
        return 1
    return max(1, min(8, value))


def default_runner_state(workspace: Path) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "enabled": False,
        "paused": True,
        "workspaceRoot": str(workspace.expanduser().resolve()),
        "provider": "desktop-terminal",
        "cli": "codex",
        "queues": list(CLAIMABLE_STATUSES),
        "maxConcurrency": 1,
        "activeExecutions": [],
        "lastError": None,
        "updatedAt": now_iso(),
    }


def normalize_runner_state(workspace: Path, payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return default_runner_state(workspace)
    state = default_runner_state(workspace)
    state["enabled"] = payload.get("enabled") is True
    state["paused"] = payload.get("paused") is not False
    state["workspaceRoot"] = str(Path(payload.get("workspaceRoot") or workspace).expanduser().resolve())
    state["provider"] = payload.get("provider") if payload.get("provider") in RUNNER_PROVIDERS else "desktop-terminal"
    state["cli"] = payload.get("cli") if payload.get("cli") in {"codex", "claude"} else "codex"
    state["queues"] = normalize_runner_queues(payload.get("queues") if isinstance(payload.get("queues"), list) else None)
    state["maxConcurrency"] = normalize_runner_concurrency(payload.get("maxConcurrency"))
    state["activeExecutions"] = [
        execution
        for execution in payload.get("activeExecutions", [])
        if isinstance(execution, dict)
        and isinstance(execution.get("executionId"), str)
        and isinstance(execution.get("taskId"), str)
    ] if isinstance(payload.get("activeExecutions"), list) else []
    state["lastError"] = payload.get("lastError") if isinstance(payload.get("lastError"), str) else None
    state["updatedAt"] = payload.get("updatedAt") if isinstance(payload.get("updatedAt"), str) else now_iso()
    return state


def read_runner_state(workspace: Path) -> dict[str, Any]:
    init_workspace(workspace)
    path = runner_state_path(workspace)
    if not path.exists():
        return default_runner_state(workspace)
    try:
        return normalize_runner_state(workspace, json.loads(path.read_text(encoding="utf-8")))
    except json.JSONDecodeError as exc:
        raise SwitchboardError(f"Invalid Switchboard runner state JSON: {exc.msg}") from exc


def write_runner_state(workspace: Path, state: dict[str, Any]) -> dict[str, Any]:
    init_workspace(workspace)
    state = normalize_runner_state(workspace, {**state, "updatedAt": now_iso()})
    atomic_write_json(runner_state_path(workspace), state)
    return state


def append_runner_event(workspace: Path, event_type: str, *, message: str | None = None, data: dict[str, Any] | None = None) -> None:
    init_workspace(workspace)
    if event_type not in RUNNER_EVENTS:
        raise SwitchboardError(f"Invalid runner event type: {event_type}")
    event: dict[str, Any] = {
        "type": event_type,
        "workspaceRoot": str(workspace.expanduser().resolve()),
        "at": now_iso(),
    }
    if message:
        event["message"] = message
    if data:
        event["data"] = data
    with runner_events_path(workspace).open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event) + "\n")


def runner_public_payload(state: dict[str, Any]) -> dict[str, Any]:
    active_sessions = []
    for execution in state.get("activeExecutions", []):
        provider_ref = execution.get("providerRef") if isinstance(execution.get("providerRef"), dict) else {}
        if execution.get("provider") == "desktop-terminal" and isinstance(provider_ref.get("sessionId"), str):
            active_sessions.append(
                {
                    "taskId": execution.get("taskId"),
                    "queue": execution.get("claimedFrom"),
                    "sessionId": provider_ref["sessionId"],
                    "agentId": f"switchboard-{execution.get('role', 'agent')}",
                    "startedAt": execution.get("startedAt"),
                }
            )
    return {
        "ok": True,
        "workspaceRoot": state.get("workspaceRoot"),
        "enabled": state.get("enabled") is True,
        "running": state.get("enabled") is True and state.get("paused") is False,
        "paused": state.get("paused") is not False,
        "provider": state.get("provider", "desktop-terminal"),
        "cli": state.get("cli", "codex"),
        "maxConcurrency": state.get("maxConcurrency", 1),
        "queues": state.get("queues", list(CLAIMABLE_STATUSES)),
        "activeExecutions": state.get("activeExecutions", []),
        "activeSessions": active_sessions,
        "lastError": state.get("lastError"),
        "updatedAt": state.get("updatedAt"),
    }


def runner_start(
    workspace: Path,
    *,
    provider: str = "desktop-terminal",
    cli: str = "codex",
    queues: list[str] | None = None,
    max_concurrency: int = 1,
) -> dict[str, Any]:
    if provider not in RUNNER_PROVIDERS:
        raise SwitchboardError(f"Invalid runner provider: {provider}")
    if cli not in {"codex", "claude"}:
        raise SwitchboardError(f"Invalid runner cli: {cli}")
    state = read_runner_state(workspace)
    state.update(
        {
            "enabled": True,
            "paused": False,
            "provider": provider,
            "cli": cli,
            "queues": normalize_runner_queues(queues),
            "maxConcurrency": normalize_runner_concurrency(max_concurrency),
            "lastError": None,
        }
    )
    state = write_runner_state(workspace, state)
    append_runner_event(
        workspace,
        "start",
        data={"provider": provider, "cli": cli, "queues": state["queues"], "maxConcurrency": state["maxConcurrency"]},
    )
    return runner_public_payload(state)


def runner_pause(workspace: Path) -> dict[str, Any]:
    state = read_runner_state(workspace)
    state["enabled"] = True
    state["paused"] = True
    state = write_runner_state(workspace, state)
    append_runner_event(workspace, "pause")
    return runner_public_payload(state)


def runner_resume(workspace: Path) -> dict[str, Any]:
    state = read_runner_state(workspace)
    state["enabled"] = True
    state["paused"] = False
    state = write_runner_state(workspace, state)
    append_runner_event(workspace, "resume")
    return runner_public_payload(state)


def runner_status(workspace: Path) -> dict[str, Any]:
    return runner_public_payload(read_runner_state(workspace))


def runner_tick(workspace: Path) -> dict[str, Any]:
    state = read_runner_state(workspace)
    if not state["enabled"] or state["paused"]:
        append_runner_event(workspace, "tick", data={"skipped": "paused" if state["paused"] else "disabled"})
        return runner_public_payload(write_runner_state(workspace, state))
    if state["provider"] == "desktop-terminal":
        message = "desktop-terminal runner tick requires the Electron terminal/session manager; no task was claimed."
        state["lastError"] = message
        state = write_runner_state(workspace, state)
        append_runner_event(workspace, "provider_error", message=message, data={"provider": state["provider"]})
        append_runner_event(workspace, "tick", data={"claimed": 0})
        return runner_public_payload(state)
    message = f"{state['provider']} execution provider is defined but not implemented yet."
    state["lastError"] = message
    state = write_runner_state(workspace, state)
    append_runner_event(workspace, "provider_error", message=message, data={"provider": state["provider"]})
    append_runner_event(workspace, "tick", data={"claimed": 0})
    return runner_public_payload(state)


def lock_status_for(workspace: Path, status: str) -> LockStatus:
    current = folder_path(workspace, status)
    lock_file = current / "Lock"
    metadata = lock_metadata(lock_file)
    locked = bool(metadata and metadata.get("locked") is True)
    heartbeat_at = metadata.get("heartbeatAt") if metadata and isinstance(metadata.get("heartbeatAt"), str) else None
    created_at = metadata.get("createdAt") if metadata and isinstance(metadata.get("createdAt"), str) else None
    timestamp = heartbeat_at or created_at
    age_seconds: float | None = None
    if timestamp:
        try:
            parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
            age_seconds = max(0.0, (datetime.now(timezone.utc) - parsed).total_seconds())
        except ValueError:
            age_seconds = None
    return LockStatus(
        folder_status=status,
        path=lock_file,
        locked=locked or (current / ".Lock.lock").exists(),
        stale=lock_is_stale(metadata) if metadata else False,
        owner=metadata.get("owner") if metadata and isinstance(metadata.get("owner"), str) else None,
        session_id=metadata.get("sessionId") if metadata and isinstance(metadata.get("sessionId"), str) else None,
        created_at=created_at,
        heartbeat_at=heartbeat_at,
        age_seconds=age_seconds,
    )


def lock_status_payload(status: LockStatus) -> dict[str, Any]:
    return {
        "folderStatus": status.folder_status,
        "path": str(status.path),
        "locked": status.locked,
        "stale": status.stale,
        "owner": status.owner,
        "sessionId": status.session_id,
        "createdAt": status.created_at,
        "heartbeatAt": status.heartbeat_at,
        "ageSeconds": status.age_seconds,
    }


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.parent / f".{path.name}.{os.getpid()}.{datetime.now(timezone.utc).timestamp():.6f}.tmp"
    tmp_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp_path, path)


def normalize_labels(labels: list[str] | None) -> list[str]:
    seen: dict[str, None] = {}
    for value in labels or []:
        label = str(value).strip().lower()
        if label:
            seen[label] = None
    return list(seen.keys())


def normalize_source(source: dict[str, Any] | None, fallback_type: str) -> dict[str, Any]:
    source = source or {}
    source_type = source.get("type") if source.get("type") in SOURCE_TYPES else fallback_type
    return {
        "type": source_type,
        "externalId": source.get("externalId") if isinstance(source.get("externalId"), str) else None,
        "externalKey": source.get("externalKey") if isinstance(source.get("externalKey"), str) else None,
        "externalUrl": source.get("externalUrl") if isinstance(source.get("externalUrl"), str) else None,
    }


def task_summary(task: dict[str, Any], folder_status: str | None = None) -> dict[str, Any]:
    return {
        "id": task["id"],
        "identifier": task["identifier"],
        "title": task["title"],
        "state": folder_status or task["state"],
        "priority": task.get("priority"),
        "labels": task.get("labels", []),
        "source": task.get("source", {}),
        "commentCount": len(task.get("comments", [])),
    }


def build_task(
    *,
    title: str,
    description: str,
    inbox: bool,
    identifier: str | None = None,
    priority: int | float | None = None,
    labels: list[str] | None = None,
    source_input: dict[str, Any] | None = None,
    comments: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    task_id = str(uuid.uuid4())
    created_at = now_iso()
    source = normalize_source(source_input, "watchtower" if inbox else "manual")
    return {
        "schemaVersion": 1,
        "id": task_id,
        "identifier": identifier.strip() if isinstance(identifier, str) and identifier.strip() else f"SB-{task_id[:8]}",
        "title": title.strip(),
        "description": description,
        "priority": priority if isinstance(priority, (int, float)) else None,
        "state": "todo",
        "branchName": None,
        "url": source["externalUrl"],
        "labels": normalize_labels(labels),
        "blockedBy": [],
        "source": source,
        "claim": None,
        "execution": {
            "attempts": [],
            "worktreePath": None,
            "activeExecutionId": None,
            "activeProvider": None,
            "activeSessionId": None,
        },
        "evidence": {
            "summary": "",
            "artifacts": [],
            "commandsRun": [],
            "touchedFiles": [],
        },
        "comments": comments if isinstance(comments, list) else [],
        "createdAt": created_at,
        "updatedAt": created_at,
    }


def validate_task_shape(payload: Any) -> list[str]:
    errors: list[str] = []
    if not isinstance(payload, dict):
        return ["Task file must contain a JSON object."]
    if payload.get("schemaVersion") != 1:
        errors.append("schemaVersion must be 1.")
    task_id = payload.get("id")
    if not isinstance(task_id, str) or not UUID_RE.match(task_id):
        errors.append("id must be a UUID.")
    if not isinstance(payload.get("identifier"), str) or not payload.get("identifier", "").strip():
        errors.append("identifier is required.")
    if not isinstance(payload.get("title"), str) or not payload.get("title", "").strip():
        errors.append("title is required.")
    if not isinstance(payload.get("description"), str):
        errors.append("description must be a string.")
    if payload.get("priority") is not None and not isinstance(payload.get("priority"), (int, float)):
        errors.append("priority must be a number or null.")
    if payload.get("state") not in TASK_STATUSES:
        errors.append("state must be a valid task status.")
    if payload.get("branchName") is not None and not isinstance(payload.get("branchName"), str):
        errors.append("branchName must be a string or null.")
    if payload.get("url") is not None and not isinstance(payload.get("url"), str):
        errors.append("url must be a string or null.")
    if not isinstance(payload.get("labels"), list) or not all(isinstance(item, str) for item in payload.get("labels", [])):
        errors.append("labels must be a string array.")
    if not isinstance(payload.get("blockedBy"), list) or not all(isinstance(item, str) for item in payload.get("blockedBy", [])):
        errors.append("blockedBy must be a string array.")
    source = payload.get("source")
    if not isinstance(source, dict):
        errors.append("source must be an object.")
    elif source.get("type") not in SOURCE_TYPES:
        errors.append("source.type must be valid.")
    execution = payload.get("execution")
    if not isinstance(execution, dict):
        errors.append("execution must be an object.")
    else:
        if not isinstance(execution.get("attempts"), list):
            errors.append("execution.attempts must be an array.")
        if execution.get("worktreePath") is not None and not isinstance(execution.get("worktreePath"), str):
            errors.append("execution.worktreePath must be a string or null.")
        if execution.get("activeExecutionId") is not None and not isinstance(execution.get("activeExecutionId"), str):
            errors.append("execution.activeExecutionId must be a string or null.")
        if execution.get("activeProvider") is not None and execution.get("activeProvider") not in RUNNER_PROVIDERS:
            errors.append("execution.activeProvider must be a valid provider or null.")
        if execution.get("activeSessionId") is not None and not isinstance(execution.get("activeSessionId"), str):
            errors.append("execution.activeSessionId must be a string or null.")
        if execution.get("providerRef") is not None and not isinstance(execution.get("providerRef"), dict):
            errors.append("execution.providerRef must be an object or null.")
    evidence = payload.get("evidence")
    if not isinstance(evidence, dict):
        errors.append("evidence must be an object.")
    else:
        if not isinstance(evidence.get("summary"), str):
            errors.append("evidence.summary must be a string.")
        for field in ("artifacts", "commandsRun", "touchedFiles"):
            if not isinstance(evidence.get(field), list) or not all(isinstance(item, str) for item in evidence.get(field, [])):
                errors.append(f"evidence.{field} must be a string array.")
    comments = payload.get("comments")
    if not isinstance(comments, list):
        errors.append("comments must be an array.")
    else:
        for comment in comments:
            if not isinstance(comment, dict):
                errors.append("comments must contain objects.")
                break
            if not isinstance(comment.get("id"), str) or not comment.get("id"):
                errors.append("comment.id is required.")
            if comment.get("kind") not in COMMENT_KINDS:
                errors.append("comment.kind must be valid.")
            if not isinstance(comment.get("body"), str):
                errors.append("comment.body must be a string.")
            if not isinstance(comment.get("createdAt"), str) or not comment.get("createdAt"):
                errors.append("comment.createdAt is required.")
            author = comment.get("author")
            if not isinstance(author, dict):
                errors.append("comment.author must be an object.")
            elif author.get("type") not in AUTHOR_TYPES:
                errors.append("comment.author.type must be valid.")
    if not isinstance(payload.get("createdAt"), str) or not payload.get("createdAt"):
        errors.append("createdAt is required.")
    if not isinstance(payload.get("updatedAt"), str) or not payload.get("updatedAt"):
        errors.append("updatedAt is required.")
    return errors


def read_task_file(path: Path, folder_status: str) -> LocatedTask:
    file_name = path.name
    if file_name.startswith("task_"):
        raise SwitchboardError("Switchboard task filenames must not use the task_ prefix.")
    if path.suffix != ".json":
        raise SwitchboardError("Switchboard task filename must use a .json extension.")
    task_id = path.stem
    validate_task_id(task_id)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SwitchboardError(f"Invalid task JSON: {exc.msg}") from exc
    errors = validate_task_shape(payload)
    if errors:
        raise SwitchboardError(" ".join(errors))
    if payload["id"] != task_id:
        raise SwitchboardError("Task id must match filename stem.")
    warnings: list[str] = []
    if folder_status != "inbox" and payload["state"] != folder_status:
        warnings.append(f"Task state {payload['state']} disagrees with folder {folder_status}; folder status is authoritative.")
        payload = {**payload, "state": folder_status}
    return LocatedTask(task=payload, folder_status=folder_status, path=path, warnings=warnings)


def read_all(workspace: Path) -> tuple[list[LocatedTask], list[dict[str, Any]], list[dict[str, Any]]]:
    init_workspace(workspace)
    tasks: list[LocatedTask] = []
    problems: list[dict[str, Any]] = []
    locks = [lock_status_payload(lock_status_for(workspace, status)) for status in FOLDER_STATUSES]
    for status in FOLDER_STATUSES:
        current = folder_path(workspace, status)
        for entry in sorted(current.iterdir()):
            if entry.name == "Lock" or not entry.name.endswith(".json") or not entry.is_file():
                continue
            try:
                tasks.append(read_task_file(entry, status))
            except SwitchboardError as exc:
                problems.append({"path": str(entry), "folderStatus": status, "message": str(exc)})
    return tasks, problems, locks


def find_task(workspace: Path, task_id: str) -> LocatedTask:
    validate_task_id(task_id)
    for status in FOLDER_STATUSES:
        candidate = task_path(workspace, status, task_id)
        if candidate.exists():
            return read_task_file(candidate, status)
    raise SwitchboardError("Switchboard task was not found.")


def create_task(
    workspace: Path,
    *,
    title: str,
    description: str = "",
    inbox: bool = False,
    identifier: str | None = None,
    priority: int | float | None = None,
    labels: list[str] | None = None,
    source: dict[str, Any] | None = None,
    comments: list[dict[str, Any]] | None = None,
) -> LocatedTask:
    init_workspace(workspace)
    if not title.strip():
        raise SwitchboardError("title is required.")
    task = build_task(
        title=title,
        description=description,
        inbox=inbox,
        identifier=identifier,
        priority=priority,
        labels=labels,
        source_input=source,
        comments=comments,
    )
    errors = validate_task_shape(task)
    if errors:
        raise SwitchboardError(" ".join(errors))
    status = "inbox" if inbox else "todo"
    with locked_folders(workspace, [status], owner="switchboard-cli"):
        path = task_path(workspace, status, task["id"])
        atomic_write_json(path, task)
        return read_task_file(path, status)


def update_task(workspace: Path, task_id: str, updates: dict[str, Any]) -> LocatedTask:
    if not isinstance(updates, dict):
        raise SwitchboardError("updates must be an object.")
    initial = find_task(workspace, task_id)
    with locked_folders(workspace, [initial.folder_status], owner="switchboard-cli"):
        located = find_task(workspace, task_id)
        if located.folder_status != initial.folder_status:
            raise SwitchboardError("Switchboard task moved before update could acquire its folder lock.")
        if "state" in updates and updates["state"] != located.task["state"]:
            raise SwitchboardError("Use move to change Switchboard task status.")
        task = {
            **located.task,
            **updates,
            "id": located.task["id"],
            "schemaVersion": 1,
            "createdAt": located.task["createdAt"],
            "updatedAt": now_iso(),
            "state": located.task["state"] if located.folder_status == "inbox" else located.folder_status,
        }
        if "labels" in updates:
            task["labels"] = normalize_labels(updates["labels"])
        if "blockedBy" in updates:
            task["blockedBy"] = [str(item).strip() for item in updates["blockedBy"] if str(item).strip()] if isinstance(updates["blockedBy"], list) else []
        errors = validate_task_shape(task)
        if errors:
            raise SwitchboardError(" ".join(errors))
        atomic_write_json(located.path, task)
        return read_task_file(located.path, located.folder_status)


def add_comment(
    workspace: Path,
    task_id: str,
    *,
    body: str,
    author_name: str = "User",
    kind: str = "comment",
    author_type: str = "user",
    author_id: str | None = None,
) -> LocatedTask:
    if not body.strip():
        raise SwitchboardError("Comment body is required.")
    if kind not in COMMENT_KINDS:
        raise SwitchboardError(f"Invalid comment kind: {kind}")
    initial = find_task(workspace, task_id)
    with locked_folders(workspace, [initial.folder_status], owner="switchboard-cli"):
        located = find_task(workspace, task_id)
        if located.folder_status != initial.folder_status:
            raise SwitchboardError("Switchboard task moved before comment could acquire its folder lock.")
        now = now_iso()
        task = {
            **located.task,
            "comments": [
                *located.task["comments"],
                {
                    "id": str(uuid.uuid4()),
                    "author": {
                        "type": author_type,
                        "id": author_id,
                        "name": author_name,
                    },
                    "kind": kind,
                    "body": body.strip(),
                    "createdAt": now,
                },
            ],
            "updatedAt": now,
        }
        atomic_write_json(located.path, task)
        return read_task_file(located.path, located.folder_status)


def lock_metadata(lock_file: Path) -> dict[str, Any] | None:
    try:
        payload = json.loads(lock_file.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def lock_is_stale(metadata: dict[str, Any] | None) -> bool:
    if not metadata:
        return False
    timestamp = metadata.get("heartbeatAt") or metadata.get("createdAt")
    if not isinstance(timestamp, str):
        return False
    try:
        parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError:
        return False
    return (datetime.now(timezone.utc) - parsed).total_seconds() > STALE_LOCK_SECONDS


def acquire_lock(folder: Path, *, owner: str, session_id: str | None = None) -> FolderLock:
    folder.mkdir(parents=True, exist_ok=True)
    lock_dir = folder / ".Lock.lock"
    lock_file = folder / "Lock"
    try:
        lock_dir.mkdir()
    except FileExistsError as exc:
        metadata = lock_metadata(lock_file)
        if lock_is_stale(metadata):
            owner_text = metadata.get("owner", "unknown") if metadata else "unknown"
            raise SwitchboardError(f"Switchboard folder lock is stale in {folder} (owner: {owner_text}). Recovery is required.")
        owner_text = metadata.get("owner", "unknown") if metadata else "unknown"
        raise SwitchboardError(f"Switchboard folder is locked: {folder} (owner: {owner_text}).") from exc
    now = now_iso()
    lock_file.write_text(
        json.dumps(
            {
                "locked": True,
                "owner": owner,
                "sessionId": session_id,
                "createdAt": now,
                "heartbeatAt": now,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return FolderLock(folder=folder, lock_dir=lock_dir, lock_file=lock_file)


def release_lock(lock: FolderLock) -> None:
    if lock.lock_dir.exists():
        lock.lock_dir.rmdir()
    lock.lock_file.write_text(json.dumps({"locked": False}, indent=2) + "\n", encoding="utf-8")


def recover_lock(workspace: Path, status: str) -> dict[str, Any]:
    if status not in FOLDER_STATUSES:
        raise SwitchboardError(f"Invalid Switchboard folder status: {status}")
    init_workspace(workspace)
    current = folder_path(workspace, status)
    lock_file = current / "Lock"
    metadata = lock_metadata(lock_file)
    lock_dir = current / ".Lock.lock"
    if not lock_dir.exists() and not (metadata and metadata.get("locked") is True):
        return {"ok": True, "recovered": False, "lock": lock_status_payload(lock_status_for(workspace, status))}
    if not lock_is_stale(metadata):
        owner_text = metadata.get("owner", "unknown") if metadata else "unknown"
        raise SwitchboardError(f"Switchboard folder lock is not stale: {status} (owner: {owner_text}).")
    if lock_dir.exists():
        lock_dir.rmdir()
    lock_file.write_text(json.dumps({"locked": False}, indent=2) + "\n", encoding="utf-8")
    return {"ok": True, "recovered": True, "lock": lock_status_payload(lock_status_for(workspace, status))}


@contextmanager
def locked_folders(workspace: Path, statuses: list[str], *, owner: str) -> Iterator[None]:
    locks: list[FolderLock] = []
    unique_statuses = sorted(set(statuses), key=lambda status: str(folder_path(workspace, status)))
    try:
        for status in unique_statuses:
            locks.append(acquire_lock(folder_path(workspace, status), owner=owner))
        yield
    finally:
        for lock in reversed(locks):
            release_lock(lock)


def destination_status_for_move(from_status: str, to_status: str) -> str:
    if to_status not in TASK_STATUSES:
        raise SwitchboardError(f"Invalid destination status: {to_status}")
    if from_status == "inbox":
        if to_status == "todo" or to_status == "canceled":
            return to_status
        raise SwitchboardError(f"Cannot move Switchboard task from inbox to {to_status}.")
    if to_status == from_status:
        return to_status
    if to_status in MOVE_TRANSITIONS.get(from_status, set()):
        return to_status
    raise SwitchboardError(f"Cannot move Switchboard task from {from_status} to {to_status}.")


def move_task(workspace: Path, task_id: str, to_status: str, *, owner: str = "switchboard-cli") -> LocatedTask:
    init_workspace(workspace)
    located = find_task(workspace, task_id)
    target = destination_status_for_move(located.folder_status, to_status)
    with locked_folders(workspace, [located.folder_status, target], owner=owner):
        located = find_task(workspace, task_id)
        target = destination_status_for_move(located.folder_status, to_status)
        now = now_iso()
        task = {
            **located.task,
            "state": target,
            "updatedAt": now,
            "comments": located.task["comments"]
            if located.folder_status == target
            else [
                *located.task["comments"],
                {
                    "id": str(uuid.uuid4()),
                    "author": {"type": "system", "id": "switchboard", "name": "Switchboard"},
                    "kind": "status_change",
                    "body": f"Moved from {located.folder_status} to {target}.",
                    "createdAt": now,
                },
            ],
        }
        destination = task_path(workspace, target, task_id)
        if destination.exists() and destination != located.path:
            raise SwitchboardError("A Switchboard task already exists in the destination folder.")
        atomic_write_json(located.path, task)
        if destination != located.path:
            os.replace(located.path, destination)
        return read_task_file(destination, target)


def promote_task(workspace: Path, task_id: str) -> LocatedTask:
    located = find_task(workspace, task_id)
    if located.folder_status != "inbox":
        raise SwitchboardError("Only inbox tasks can be promoted.")
    return move_task(workspace, task_id, "todo")


def cancel_task(workspace: Path, task_id: str, *, reason: str | None = None) -> LocatedTask:
    init_workspace(workspace)
    located = find_task(workspace, task_id)
    target = "canceled"
    destination_status_for_move(located.folder_status, target)
    with locked_folders(workspace, [located.folder_status, target], owner="switchboard-cli"):
        located = find_task(workspace, task_id)
        destination_status_for_move(located.folder_status, target)
        now = now_iso()
        comments = list(located.task["comments"])
        if reason and reason.strip():
            comments.append(
                {
                    "id": str(uuid.uuid4()),
                    "author": {"type": "system", "id": "switchboard-cli", "name": "Switchboard CLI"},
                    "kind": "comment",
                    "body": reason.strip(),
                    "createdAt": now,
                }
            )
        comments.append(
            {
                "id": str(uuid.uuid4()),
                "author": {"type": "system", "id": "switchboard", "name": "Switchboard"},
                "kind": "status_change",
                "body": f"Moved from {located.folder_status} to {target}.",
                "createdAt": now,
            }
        )
        task = {
            **located.task,
            "state": target,
            "updatedAt": now,
            "comments": comments,
        }
        destination = task_path(workspace, target, task_id)
        if destination.exists() and destination != located.path:
            raise SwitchboardError("A Switchboard task already exists in the destination folder.")
        atomic_write_json(located.path, task)
        if destination != located.path:
            os.replace(located.path, destination)
        return read_task_file(destination, target)


def claim_task(workspace: Path, *, from_status: str, agent: str) -> LocatedTask | None:
    if from_status not in CLAIMABLE_STATUSES:
        raise SwitchboardError("--from must be one of ready, testing, or review.")
    if not agent.strip():
        raise SwitchboardError("--agent is required.")
    init_workspace(workspace)
    with locked_folders(workspace, [from_status, CLAIM_TRANSITIONS[from_status]], owner=agent):
        tasks, _problems, _locks = read_all(workspace)
        candidates = sorted(
            [task for task in tasks if task.folder_status == from_status],
            key=lambda located: str(located.task.get("createdAt", "")),
        )
        if not candidates:
            return None
        located = candidates[0]
        now = now_iso()
        task = {
            **located.task,
            "claim": {
                "owner": agent.strip(),
                "sessionId": None,
                "claimedAt": now,
            },
            "updatedAt": now,
            "comments": [
                *located.task["comments"],
                {
                    "id": str(uuid.uuid4()),
                    "author": {"type": "system", "id": "switchboard", "name": "Switchboard"},
                    "kind": "claim",
                    "body": f"Claimed by {agent.strip()}.",
                    "createdAt": now,
                },
            ],
        }
        atomic_write_json(located.path, task)
        destination = task_path(workspace, CLAIM_TRANSITIONS[from_status], task["id"])
        os.replace(located.path, destination)
        return read_task_file(destination, CLAIM_TRANSITIONS[from_status])


def merged_evidence(
    task: dict[str, Any],
    *,
    summary: str | None = None,
    artifacts: list[str] | None = None,
    commands_run: list[str] | None = None,
    touched_files: list[str] | None = None,
) -> dict[str, Any]:
    evidence = dict(task.get("evidence", {}))
    if summary is not None and summary.strip():
        evidence["summary"] = summary.strip()
    if artifacts:
        evidence["artifacts"] = [*evidence.get("artifacts", []), *[item for item in artifacts if item]]
    if commands_run:
        evidence["commandsRun"] = [*evidence.get("commandsRun", []), *[item for item in commands_run if item]]
    if touched_files:
        evidence["touchedFiles"] = [*evidence.get("touchedFiles", []), *[item for item in touched_files if item]]
    return evidence


def validate_publish(task: dict[str, Any], from_status: str, to_status: str, evidence_override: dict[str, Any] | None = None) -> None:
    expected = PUBLISH_TRANSITIONS.get(from_status)
    if expected != to_status:
        raise SwitchboardError(f"Cannot publish a task from {from_status} to {to_status}.")
    evidence = evidence_override or task.get("evidence", {})
    comments = task.get("comments", [])
    errors: list[str] = []
    summary = evidence.get("summary") if isinstance(evidence.get("summary"), str) else ""
    if from_status == "in_progress":
        if not task.get("claim"):
            errors.append("claim metadata is required before publishing implementation work.")
        if not task.get("execution", {}).get("attempts"):
            errors.append("at least one execution attempt is required before publishing.")
        if not summary.strip():
            errors.append("evidence summary or explicit no-code-change explanation is required.")
        if not evidence.get("touchedFiles"):
            errors.append("touched files or explicit no-file-change evidence is required.")
        if not evidence.get("commandsRun"):
            errors.append("commands run or explicit not-run evidence is required.")
        if not comments:
            errors.append("at least one activity comment is required before publishing.")
    if from_status == "testing_in_progress":
        if not summary.strip():
            errors.append("test pass/fail summary is required before publishing to review.")
        if not evidence.get("commandsRun"):
            errors.append("test commands or manual checks are required before publishing.")
        if not comments:
            errors.append("test result comment or evidence entry is required before publishing.")
    if from_status == "review_in_progress":
        if not summary.strip():
            errors.append("review verdict and residual risk summary are required before publishing to done.")
        if not comments:
            errors.append("approval comment or evidence entry is required before publishing.")
    if errors:
        raise SwitchboardError(" ".join(errors))


def publish_task(
    workspace: Path,
    task_id: str,
    *,
    to_status: str,
    summary: str | None = None,
    artifacts: list[str] | None = None,
    commands_run: list[str] | None = None,
    touched_files: list[str] | None = None,
    comment: str | None = None,
) -> LocatedTask:
    if to_status not in PUBLISH_TARGETS:
        raise SwitchboardError("--to must be one of testing, review, or done.")
    init_workspace(workspace)
    located = find_task(workspace, task_id)
    if located.folder_status == "inbox":
        raise SwitchboardError("Inbox tasks cannot be published.")
    with locked_folders(workspace, [located.folder_status, to_status], owner="switchboard-cli"):
        located = find_task(workspace, task_id)
        next_evidence = merged_evidence(
            located.task,
            summary=summary,
            artifacts=artifacts,
            commands_run=commands_run,
            touched_files=touched_files,
        )
        validate_publish(located.task, located.folder_status, to_status, next_evidence)
        now = now_iso()
        comments = list(located.task["comments"])
        if comment and comment.strip():
            comments.append(
                {
                    "id": str(uuid.uuid4()),
                    "author": {"type": "system", "id": "switchboard-cli", "name": "Switchboard CLI"},
                    "kind": "evidence",
                    "body": comment.strip(),
                    "createdAt": now,
                }
            )
        comments.append(
            {
                "id": str(uuid.uuid4()),
                "author": {"type": "system", "id": "switchboard", "name": "Switchboard"},
                "kind": "status_change",
                "body": f"Published from {located.folder_status} to {to_status}.",
                "createdAt": now,
            }
        )
        task = {
            **located.task,
            "state": to_status,
            "evidence": next_evidence,
            "updatedAt": now,
            "comments": comments,
        }
        destination = task_path(workspace, to_status, task_id)
        if destination.exists() and destination != located.path:
            raise SwitchboardError("A Switchboard task already exists in the destination folder.")
        atomic_write_json(located.path, task)
        os.replace(located.path, destination)
        return read_task_file(destination, to_status)


def requeue_task(workspace: Path, task_id: str, *, reason: str | None = None) -> LocatedTask:
    init_workspace(workspace)
    located = find_task(workspace, task_id)
    target = REQUEUE_TRANSITIONS.get(located.folder_status)
    if not target:
        raise SwitchboardError(f"Cannot requeue a task from {located.folder_status}.")
    with locked_folders(workspace, [located.folder_status, target], owner="switchboard-cli"):
        located = find_task(workspace, task_id)
        target = REQUEUE_TRANSITIONS.get(located.folder_status)
        if not target:
            raise SwitchboardError(f"Cannot requeue a task from {located.folder_status}.")
        now = now_iso()
        comments = list(located.task["comments"])
        comments.append(
            {
                "id": str(uuid.uuid4()),
                "author": {"type": "system", "id": "switchboard", "name": "Switchboard"},
                "kind": "status_change",
                "body": f"Requeued from {located.folder_status} to {target}."
                + (f" Reason: {reason.strip()}" if reason and reason.strip() else ""),
                "createdAt": now,
            }
        )
        task = {
            **located.task,
            "state": target,
            "claim": None,
            "updatedAt": now,
            "comments": comments,
        }
        destination = task_path(workspace, target, task_id)
        if destination.exists() and destination != located.path:
            raise SwitchboardError("A Switchboard task already exists in the destination folder.")
        atomic_write_json(located.path, task)
        os.replace(located.path, destination)
        return read_task_file(destination, target)


def record_for_output(located: LocatedTask) -> dict[str, Any]:
    return {
        "task": located.task,
        "location": {"folderStatus": located.folder_status, "path": str(located.path)},
        "warnings": located.warnings,
    }
