"""Append-only audit event primitives for sprintengine operations."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


AUDIT_SCHEMA_VERSION = 1
AUDIT_LOG_NAME = "audit-events.jsonl"


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def path_is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def state_digest(state_path: Path) -> str:
    if not state_path.exists():
        return ""
    return hashlib.sha256(state_path.read_bytes()).hexdigest()


def audit_log_path(state_path: Path) -> Path:
    team_dir = state_path.parent.resolve()
    metrics_dir = (team_dir / "metrics").resolve()
    if not path_is_relative_to(metrics_dir, team_dir):
        raise ValueError(f"Audit metrics directory must stay under active Sprint Engine team folder: {team_dir}")
    return metrics_dir / AUDIT_LOG_NAME


def build_audit_event(
    *,
    operation_name: str,
    actor: str,
    result: str,
    duration_ms: int,
    state_path: Path | None = None,
    team_slug: str | None = None,
    task_id: str | None = None,
    artifact_id: str | None = None,
    backend_mode: str = "direct-core",
    error: BaseException | type[BaseException] | str | None = None,
) -> dict[str, Any]:
    if not operation_name.strip():
        raise ValueError("operation_name is required.")
    if not actor.strip():
        raise ValueError("actor is required.")
    if result not in {"success", "failure"}:
        raise ValueError("result must be 'success' or 'failure'.")
    if duration_ms < 0:
        raise ValueError("duration_ms cannot be negative.")

    event: dict[str, Any] = {
        "schema_version": AUDIT_SCHEMA_VERSION,
        "recorded_at": now_iso(),
        "operation_name": operation_name.strip(),
        "actor": actor.strip(),
        "result": result,
        "duration_ms": duration_ms,
        "backend_mode": backend_mode,
    }
    if state_path is not None:
        event["team_slug"] = team_slug or state_path.parent.name
        event["state_digest"] = state_digest(state_path)
    elif team_slug:
        event["team_slug"] = team_slug
    if task_id:
        event["task_id"] = task_id
    if artifact_id:
        event["artifact_id"] = artifact_id
    error_class = _error_class(error)
    if error_class:
        event["error_class"] = error_class
    return event


def append_audit_event(state_path: Path, event: dict[str, Any]) -> Path:
    output_path = audit_log_path(state_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, sort_keys=True) + "\n")
    return output_path


def record_audit_event(state_path: Path, **kwargs: Any) -> dict[str, Any]:
    event = build_audit_event(state_path=state_path, **kwargs)
    append_audit_event(state_path, event)
    return event


def _error_class(error: BaseException | type[BaseException] | str | None) -> str:
    if error is None:
        return ""
    if isinstance(error, str):
        return error.strip()
    if isinstance(error, type):
        return error.__name__
    return error.__class__.__name__
