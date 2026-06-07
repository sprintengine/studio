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

"""Runner state normalization, persistence, events, and lifecycle controls."""

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
        "provider": "electron-session",
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
    state["provider"] = payload.get("provider") if payload.get("provider") in RUNNER_PROVIDERS else "electron-session"
    state["cli"] = payload.get("cli") if payload.get("cli") in {"codex", "claude-code"} else "codex"
    state["queues"] = normalize_runner_queues(payload.get("queues") if isinstance(payload.get("queues"), list) else None)
    state["maxConcurrency"] = normalize_runner_concurrency(payload.get("maxConcurrency"))
    state["activeExecutions"] = normalize_runner_executions(payload.get("activeExecutions"))
    state["lastError"] = payload.get("lastError") if isinstance(payload.get("lastError"), str) else None
    state["updatedAt"] = payload.get("updatedAt") if isinstance(payload.get("updatedAt"), str) else now_iso()
    return state


def normalize_runner_execution(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict) or not isinstance(value.get("executionId"), str):
        return None
    kind = value.get("kind") if isinstance(value.get("kind"), str) else "switchboard_task"
    if kind == "switchboard_task" and not isinstance(value.get("taskId"), str):
        return None
    return {**value, "kind": kind}


def normalize_runner_executions(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    executions: list[dict[str, Any]] = []
    for item in value:
        normalized = normalize_runner_execution(item)
        if normalized is not None:
            executions.append(normalized)
    return executions


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


def switchboard_metrics_dir(workspace: Path) -> Path:
    return switchboard_root(workspace) / "metrics"


def agent_feedback_metrics_path(workspace: Path) -> Path:
    return switchboard_metrics_dir(workspace) / "agent-feedback.jsonl"


def append_agent_feedback_record(workspace: Path, record: dict[str, Any]) -> str:
    path = agent_feedback_metrics_path(workspace)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True) + "\n")
    return relative_to_switchboard_root(workspace, path)


def runner_public_payload(state: dict[str, Any]) -> dict[str, Any]:
    return {
        "ok": True,
        "workspaceRoot": state.get("workspaceRoot"),
        "enabled": state.get("enabled") is True,
        "running": state.get("enabled") is True and state.get("paused") is False,
        "paused": state.get("paused") is not False,
        "provider": state.get("provider", "electron-session"),
        "cli": state.get("cli", "codex"),
        "maxConcurrency": state.get("maxConcurrency", 1),
        "queues": state.get("queues", list(CLAIMABLE_STATUSES)),
        "activeExecutions": state.get("activeExecutions", []),
        "lastError": state.get("lastError"),
        "updatedAt": state.get("updatedAt"),
    }


def runner_start(
    workspace: Path,
    *,
    provider: str = "electron-session",
    cli: str = "codex",
    queues: list[str] | None = None,
    max_concurrency: int = 1,
) -> dict[str, Any]:
    with locked_runner(workspace):
        if provider not in RUNNER_PROVIDERS:
            raise SwitchboardError(f"Invalid runner provider: {provider}")
        if cli not in {"codex", "claude-code"}:
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
    with locked_runner(workspace):
        state = read_runner_state(workspace)
        state["enabled"] = True
        state["paused"] = True
        state = write_runner_state(workspace, state)
        append_runner_event(workspace, "pause")
        return runner_public_payload(state)


def runner_resume(workspace: Path) -> dict[str, Any]:
    with locked_runner(workspace):
        state = read_runner_state(workspace)
        state["enabled"] = True
        state["paused"] = False
        state = write_runner_state(workspace, state)
        append_runner_event(workspace, "resume")
        return runner_public_payload(state)


def runner_stop(workspace: Path) -> dict[str, Any]:
    with locked_runner(workspace):
        state = reconcile_runner_state(workspace, read_runner_state(workspace))
        state["enabled"] = False
        state["paused"] = True
        state["lastError"] = None
        state = write_runner_state(workspace, state)
        append_runner_event(workspace, "stop")
        return runner_public_payload(state)


def runner_status(workspace: Path) -> dict[str, Any]:
    with locked_runner(workspace):
        return runner_public_payload(reconcile_runner_state(workspace, read_runner_state(workspace)))


def runner_tick(workspace: Path) -> dict[str, Any]:
    with locked_runner(workspace):
        return runner_tick_unlocked(workspace)


def runner_tick_unlocked(workspace: Path) -> dict[str, Any]:
    state = reconcile_runner_state(workspace, read_runner_state(workspace))
    if not state["enabled"] or state["paused"]:
        append_runner_event(workspace, "tick", data={"skipped": "paused" if state["paused"] else "disabled"})
        return runner_public_payload(write_runner_state(workspace, state))

    state = write_runner_state(workspace, state)
    append_runner_event(workspace, "tick", data={"activeExecutions": active_execution_count(state)})
    return runner_public_payload(state)


def runner_runtime_tick(
    workspace: Path,
    *,
    app_instance_id: str,
    workspace_id: str | None = None,
    live_execution_ids: list[str] | None = None,
) -> dict[str, Any]:
    from ..watchtower_runner import prepare_pending_watchtower_executions_unlocked

    live_ids = {value for value in (live_execution_ids or []) if isinstance(value, str)}
    descriptors: list[dict[str, Any]] = []
    with locked_runner(workspace):
        state = reconcile_runner_state(
            workspace,
            read_runner_state(workspace),
            app_instance_id=app_instance_id,
            live_execution_ids=live_ids,
        )
        if not state["enabled"] or state["paused"]:
            append_runner_event(workspace, "tick", data={"skipped": "paused" if state["paused"] else "disabled"})
            return {"ok": True, "descriptors": descriptors, "runner": runner_public_payload(write_runner_state(workspace, state))}

        state, watchtower_descriptors = prepare_pending_watchtower_executions_unlocked(
            workspace,
            state,
            app_instance_id=app_instance_id,
            workspace_id=workspace_id,
        )
        descriptors.extend(watchtower_descriptors)

        while active_execution_count(state) < state["maxConcurrency"]:
            prepared = prepare_electron_session_execution(
                workspace,
                state,
                app_instance_id=app_instance_id,
                workspace_id=workspace_id,
                reconcile=False,
            )
            state = read_runner_state(workspace)
            if not prepared.get("ok") or not prepared.get("prepared"):
                break
            descriptor = prepared.get("descriptor")
            if isinstance(descriptor, dict):
                descriptors.append(descriptor)

        state = write_runner_state(workspace, state)
        append_runner_event(
            workspace,
            "tick",
            data={"activeExecutions": active_execution_count(state), "descriptors": len(descriptors)},
        )
        return {"ok": True, "descriptors": descriptors, "runner": runner_public_payload(state)}
