from __future__ import annotations

import errno
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

try:
    import fcntl as _fcntl_module
    _msvcrt_module = None
except ImportError:  # Windows
    _fcntl_module = None
    import msvcrt as _msvcrt_module  # type: ignore[import-not-found]

"""Task shape, folder locks, task mutations, and queue transitions."""

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


def normalize_confidence_pct(value: Any, field_name: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > 100:
        raise SwitchboardError(f"{field_name} must be an integer from 0 to 100.")
    return value


def normalize_external_updated_at(value: Any) -> str | None:
    raw = value.strip() if isinstance(value, str) and value.strip() else None
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def normalize_source(
    source: dict[str, Any] | None,
    fallback_type: str,
    *,
    preserve_external_updated_at: bool = False,
) -> dict[str, Any]:
    source = source or {}
    source_type = source.get("type") if source.get("type") in SOURCE_TYPES else fallback_type
    return {
        "type": source_type,
        "externalId": source.get("externalId") if isinstance(source.get("externalId"), str) else None,
        "externalKey": source.get("externalKey") if isinstance(source.get("externalKey"), str) else None,
        "externalUrl": source.get("externalUrl") if isinstance(source.get("externalUrl"), str) else None,
        "externalUpdatedAt": normalize_external_updated_at(source.get("externalUpdatedAt")) if preserve_external_updated_at else None,
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
    creation_confidence_pct: int | None = None,
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
        "creationConfidencePct": creation_confidence_pct,
        "source": source,
        "claim": None,
        "execution": {
            "attempts": [],
            "assessments": [],
            "worktreePath": None,
            "worktreeBranch": None,
            "worktreeState": None,
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
    try:
        normalize_confidence_pct(payload.get("creationConfidencePct"), "creationConfidencePct")
    except SwitchboardError as exc:
        errors.append(str(exc))
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
    elif source.get("externalUpdatedAt") is not None and not isinstance(source.get("externalUpdatedAt"), str):
        errors.append("source.externalUpdatedAt must be a string or null.")
    execution = payload.get("execution")
    if not isinstance(execution, dict):
        errors.append("execution must be an object.")
    else:
        if not isinstance(execution.get("attempts"), list):
            errors.append("execution.attempts must be an array.")
        if "assessments" in execution and not isinstance(execution.get("assessments"), list):
            errors.append("execution.assessments must be an array.")
        if execution.get("worktreePath") is not None and not isinstance(execution.get("worktreePath"), str):
            errors.append("execution.worktreePath must be a string or null.")
        if execution.get("worktreeBranch") is not None and not isinstance(execution.get("worktreeBranch"), str):
            errors.append("execution.worktreeBranch must be a string or null.")
        if execution.get("worktreeState") is not None and not isinstance(execution.get("worktreeState"), str):
            errors.append("execution.worktreeState must be a string or null.")
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
            try:
                normalize_confidence_pct(comment.get("confidencePct"), "comment.confidencePct")
            except SwitchboardError as exc:
                errors.append(str(exc))
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
    creation_confidence_pct: int | None = None,
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
        creation_confidence_pct=normalize_confidence_pct(creation_confidence_pct, "creationConfidencePct"),
    )
    errors = validate_task_shape(task)
    if errors:
        raise SwitchboardError(" ".join(errors))
    status = "inbox" if inbox else "todo"
    with locked_folders(workspace, [status], owner="switchboard-cli"):
        path = task_path(workspace, status, task["id"])
        atomic_write_json(path, task)
        return read_task_file(path, status)


def create_inbox_task_if_source_missing(
    workspace: Path,
    *,
    source_type: str,
    external_id: str,
    title: str,
    description: str = "",
    identifier: str | None = None,
    priority: int | float | None = None,
    labels: list[str] | None = None,
    source: dict[str, Any] | None = None,
    comments: list[dict[str, Any]] | None = None,
    creation_confidence_pct: int | None = None,
) -> LocatedTask | None:
    init_workspace(workspace)
    if source_type not in SOURCE_TYPES:
        raise SwitchboardError(f"Invalid source type: {source_type}")
    if not external_id.strip():
        raise SwitchboardError("source.externalId is required.")
    if not title.strip():
        raise SwitchboardError("title is required.")
    with locked_folders(workspace, ["inbox"], owner="switchboard-cli"):
        tasks, _problems, _locks = read_all(workspace)
        for located in tasks:
            current_source = located.task.get("source") if isinstance(located.task.get("source"), dict) else {}
            if current_source.get("type") == source_type and current_source.get("externalId") == external_id:
                return None
        task = build_task(
            title=title,
            description=description,
            inbox=True,
            identifier=identifier,
            priority=priority,
            labels=labels,
            source_input=source,
            comments=comments,
            creation_confidence_pct=normalize_confidence_pct(creation_confidence_pct, "creationConfidencePct"),
        )
        errors = validate_task_shape(task)
        if errors:
            raise SwitchboardError(" ".join(errors))
        path = task_path(workspace, "inbox", task["id"])
        atomic_write_json(path, task)
        return read_task_file(path, "inbox")


def source_matches_import_identity(source: dict[str, Any], source_type: str, external_id: str | None, external_url: str | None) -> bool:
    if source.get("type") != source_type:
        return False
    if external_id and source.get("externalId") == external_id:
        return True
    return bool(not external_id and external_url and source.get("externalUrl") == external_url)


def find_import_duplicate(
    tasks: list[LocatedTask],
    provider: str,
    identity: str | None,
    url_identity: str | None,
) -> LocatedTask | None:
    for located in tasks:
        source = located.task.get("source") if isinstance(located.task.get("source"), dict) else {}
        if source_matches_import_identity(source, provider, identity, url_identity):
            return located
    return None


EXTERNAL_UPDATED_AT_LABEL = "External updated at:"


def import_comment_body(provider: str) -> str:
    return f"Imported from {provider}."


def parse_legacy_import_external_updated_at(body: Any) -> str | None:
    if not isinstance(body, str):
        return None
    label_index = body.find(EXTERNAL_UPDATED_AT_LABEL)
    if label_index < 0:
        return None
    after_label = body[label_index + len(EXTERNAL_UPDATED_AT_LABEL):].strip()
    raw = after_label.split(maxsplit=1)[0] if after_label else ""
    return raw.rstrip(".)") or None


def comparable_external_updated_at_is_newer(candidate: str, current: str | None) -> bool:
    if not current:
        return True
    if candidate == current:
        return False
    try:
        candidate_time = datetime.fromisoformat(candidate.replace("Z", "+00:00"))
    except ValueError:
        return False
    try:
        current_time = datetime.fromisoformat(current.replace("Z", "+00:00"))
    except ValueError:
        return True
    return candidate_time > current_time


def source_external_updated_at(task: dict[str, Any]) -> str | None:
    source = task.get("source") if isinstance(task.get("source"), dict) else {}
    return normalize_external_updated_at(source.get("externalUpdatedAt"))


def legacy_import_external_updated_at(task: dict[str, Any], provider: str) -> str | None:
    comments = task.get("comments") if isinstance(task.get("comments"), list) else []
    for comment in reversed(comments):
        if not isinstance(comment, dict):
            continue
        author = comment.get("author") if isinstance(comment.get("author"), dict) else {}
        body = comment.get("body")
        if comment.get("kind") != "import":
            continue
        if author.get("type") != "system" or author.get("id") != "switchboard-import":
            continue
        if not isinstance(body, str) or not body.startswith(import_comment_body(provider)):
            continue
        external_updated_at = parse_legacy_import_external_updated_at(body)
        normalized = normalize_external_updated_at(external_updated_at)
        if normalized:
            return normalized
    return None


def current_import_external_updated_at(task: dict[str, Any], provider: str) -> str | None:
    return source_external_updated_at(task) or legacy_import_external_updated_at(task, provider)


def import_source_identity(source: dict[str, Any]) -> tuple[Any, Any, Any]:
    return (source.get("type"), source.get("externalId"), source.get("externalUrl"))


def write_import_update_metadata(located: LocatedTask, provider: str, updated_at: str | None) -> LocatedTask | None:
    comparable_updated_at = normalize_external_updated_at(updated_at)
    if comparable_updated_at is None:
        return None
    if not comparable_external_updated_at_is_newer(
        comparable_updated_at,
        current_import_external_updated_at(located.task, provider),
    ):
        return None
    now = now_iso()
    source = located.task.get("source") if isinstance(located.task.get("source"), dict) else {}
    task = {
        **located.task,
        "source": {
            **source,
            "externalUpdatedAt": comparable_updated_at,
        },
        "updatedAt": now,
    }
    errors = validate_task_shape(task)
    if errors:
        raise SwitchboardError(" ".join(errors))
    atomic_write_json(located.path, task)
    return read_task_file(located.path, located.folder_status)


def import_inbox_task(
    workspace: Path,
    *,
    provider: str,
    external_id: str | None,
    external_key: str | None,
    external_url: str | None,
    title: str,
    identifier: str | None = None,
    description: str = "",
    labels: list[str] | None = None,
    priority: int | float | None = None,
    updated_at: str | None = None,
) -> tuple[LocatedTask | None, str]:
    if provider not in {"github", "jira"}:
        raise SwitchboardError("Import provider must be github or jira.")
    identity = external_id.strip() if isinstance(external_id, str) and external_id.strip() else None
    url_identity = external_url.strip() if isinstance(external_url, str) and external_url.strip() else None
    if not identity and not url_identity:
        raise SwitchboardError("Imported task requires source.externalId or source.externalUrl.")
    if not title.strip():
        raise SwitchboardError("Imported task title is required.")
    now = now_iso()
    tasks, _problems, _locks = read_all(workspace)
    duplicate = find_import_duplicate(tasks, provider, identity, url_identity)
    if duplicate:
        with locked_folders(workspace, [duplicate.folder_status], owner="switchboard-import"):
            located = find_task(workspace, duplicate.task["id"])
            if located.folder_status != duplicate.folder_status:
                return None, "duplicate"
            source = located.task.get("source") if isinstance(located.task.get("source"), dict) else {}
            if source_matches_import_identity(source, provider, identity, url_identity):
                synced = write_import_update_metadata(located, provider, updated_at)
                return (synced, "updated") if synced else (None, "duplicate")

    with locked_folders(workspace, ["inbox"], owner="switchboard-import"):
        tasks, _problems, _locks = read_all(workspace)
        duplicate = find_import_duplicate(tasks, provider, identity, url_identity)
        if duplicate:
            synced = (
                write_import_update_metadata(duplicate, provider, updated_at)
                if duplicate.folder_status == "inbox"
                else None
            )
            return (synced, "updated") if synced else (None, "duplicate")
        source = {
            "type": provider,
            "externalId": identity,
            "externalKey": external_key.strip() if isinstance(external_key, str) and external_key.strip() else None,
            "externalUrl": url_identity,
        }
        external_updated_at = normalize_external_updated_at(updated_at)
        task = build_task(
            title=title,
            description=description,
            inbox=True,
            identifier=identifier if isinstance(identifier, str) and identifier.strip() else source["externalKey"],
            priority=priority,
            labels=labels,
            source_input=source,
            comments=[
                {
                    "id": str(uuid.uuid4()),
                    "author": {"type": "system", "id": "switchboard-import", "name": "Switchboard Import"},
                    "kind": "import",
                    "body": import_comment_body(provider),
                    "createdAt": now,
                }
            ],
        )
        task["source"]["externalUpdatedAt"] = external_updated_at
        errors = validate_task_shape(task)
        if errors:
            raise SwitchboardError(" ".join(errors))
        path = task_path(workspace, "inbox", task["id"])
        atomic_write_json(path, task)
        return read_task_file(path, "inbox"), "created"


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
        if "source" in updates and isinstance(updates["source"], dict):
            current_source = normalize_source(
                located.task.get("source") if isinstance(located.task.get("source"), dict) else None,
                "manual",
                preserve_external_updated_at=True,
            )
            next_source = normalize_source(updates["source"], current_source["type"])
            preserve_external_updated_at = (
                next_source["type"] in {"github", "jira"}
                and import_source_identity(next_source) == import_source_identity(current_source)
            )
            task["source"] = {
                **next_source,
                "externalUpdatedAt": current_source["externalUpdatedAt"] if preserve_external_updated_at else None,
            }
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
    confidence_pct: int | None = None,
) -> LocatedTask:
    if not body.strip():
        raise SwitchboardError("Comment body is required.")
    if kind not in COMMENT_KINDS:
        raise SwitchboardError(f"Invalid comment kind: {kind}")
    normalized_confidence = normalize_confidence_pct(confidence_pct, "confidencePct")
    initial = find_task(workspace, task_id)
    with locked_folders(workspace, [initial.folder_status], owner="switchboard-cli"):
        located = find_task(workspace, task_id)
        if located.folder_status != initial.folder_status:
            raise SwitchboardError("Switchboard task moved before comment could acquire its folder lock.")
        now = now_iso()
        comment = {
            "id": str(uuid.uuid4()),
            "author": {
                "type": author_type,
                "id": author_id,
                "name": author_name,
            },
            "kind": kind,
            "body": body.strip(),
            "createdAt": now,
        }
        if normalized_confidence is not None:
            comment["confidencePct"] = normalized_confidence
        task = {
            **located.task,
            "comments": [
                *located.task["comments"],
                comment,
            ],
            "updatedAt": now,
        }
        atomic_write_json(located.path, task)
        synced = read_task_file(located.path, located.folder_status)
        if github_issue_ref_for_task(synced.task):
            next_task, failure = try_github_sync(
                synced.task,
                lambda: sync_github_lifecycle_comment(
                    workspace,
                    synced.task,
                    event=f"comment-{comment['id']}",
                    body=(
                        f"Switchboard comment from {author_name}:\n\n"
                        f"{body.strip()}"
                    ),
                ),
            )
            if failure:
                atomic_write_json(located.path, next_task)
                synced = read_task_file(located.path, located.folder_status)
        return synced


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
        moved = read_task_file(destination, target)
        if github_issue_ref_for_task(moved.task) and located.folder_status != target:
            def sync_move() -> None:
                if located.folder_status == "in_progress" and target != "in_progress":
                    retire_github_remote_claim(
                        workspace,
                        moved.task,
                        state=target,
                        body=f"Switchboard moved this task from {located.folder_status} to {target}.",
                    )
                sync_github_lifecycle_comment(
                    workspace,
                    moved.task,
                    event=f"status-{target}",
                    state=target,
                    body=f"Switchboard moved this task from {located.folder_status} to {target}.",
                )

            next_task, failure = try_github_sync(moved.task, sync_move)
            if failure:
                atomic_write_json(destination, next_task)
                moved = read_task_file(destination, target)
        return moved


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
        canceled = read_task_file(destination, target)
        if github_issue_ref_for_task(canceled.task):
            cancel_body = (
                f"Switchboard canceled this task."
                + (f"\n\nReason: {reason.strip()}" if reason and reason.strip() else "")
            )
            def sync_cancel() -> None:
                retire_github_remote_claim(workspace, canceled.task, state=target, body=cancel_body)
                sync_github_lifecycle_comment(
                    workspace,
                    canceled.task,
                    event="canceled",
                    state=target,
                    body=cancel_body,
                )

            next_task, failure = try_github_sync(canceled.task, sync_cancel)
            if failure:
                atomic_write_json(destination, next_task)
                canceled = read_task_file(destination, target)
        return canceled


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
        branch_name = located.task.get("branchName") if isinstance(located.task.get("branchName"), str) else None
        if from_status == "ready":
            branch_name = github_issue_branch_for_task(located.task) or branch_name
        if from_status == "ready" and branch_name and github_issue_ref_for_task(located.task):
            prepare_github_remote_claim(workspace, located.task, owner=agent.strip(), branch=branch_name)
        task = {
            **located.task,
            "branchName": branch_name or located.task.get("branchName"),
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


def clear_active_execution_metadata(task: dict[str, Any]) -> dict[str, Any]:
    execution = dict(task.get("execution", {}))
    execution["activeExecutionId"] = None
    execution["activeProvider"] = None
    execution["activeSessionId"] = None
    execution["providerRef"] = None
    return execution


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
