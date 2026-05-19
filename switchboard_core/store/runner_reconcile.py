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

"""Runner execution reconciliation helpers."""

def reconcile_execution_worktree(workspace: Path, execution: dict[str, Any]) -> dict[str, Any]:
    path_value = execution.get("worktreePath")
    if not isinstance(path_value, str):
        provider_ref = execution.get("providerRef") if isinstance(execution.get("providerRef"), dict) else {}
        path_value = provider_ref.get("worktreePath") if isinstance(provider_ref.get("worktreePath"), str) else None
    if not isinstance(path_value, str):
        return execution
    try:
        path = validate_worktree_path(workspace, Path(path_value))
    except SwitchboardError:
        return {**execution, "worktreeState": "invalid"}
    if execution.get("worktreeState") == "cleaned" and not path.exists():
        return {**execution, "worktreePath": str(path), "worktreeState": "cleaned"}
    next_state = "active" if path.exists() else "missing"
    if next_state == "missing" and execution.get("worktreeState") != "missing":
        append_runner_event(
            workspace,
            "worktree_missing",
            data={"executionId": execution.get("executionId"), "taskId": execution.get("taskId"), "worktreePath": str(path)},
        )
    return {**execution, "worktreePath": str(path), "worktreeState": next_state}


def reconcile_runner_state(
    workspace: Path,
    state: dict[str, Any],
    *,
    app_instance_id: str | None = None,
    live_execution_ids: set[str] | None = None,
) -> dict[str, Any]:
    tasks = {located.task["id"]: located for located in read_all(workspace)[0]}
    reconciled: list[dict[str, Any]] = []
    for execution in state.get("activeExecutions", []):
        kind = execution.get("kind", "switchboard_task")
        if kind in {"watchtower_review", "watchtower_triage"}:
            reconciled_execution = reconcile_watchtower_execution(
                workspace,
                execution,
                app_instance_id=app_instance_id,
                live_execution_ids=live_execution_ids,
            )
            if reconciled_execution.get("status") in {"active", "stopped"}:
                reconciled.append(reconciled_execution)
            continue
        execution = reconcile_execution_worktree(workspace, execution)
        if execution.get("status") in {"abandoned", "stopped"}:
            reconciled.append(execution)
            continue
        task_id = execution.get("taskId")
        located = tasks.get(task_id)
        if located and located.folder_status != execution.get("claimedStatus"):
            completed_at = now_iso()
            completed = {**execution, "status": "completed", "completedAt": completed_at}
            if completed.get("worktreePath") and completed.get("worktreeState") == "active":
                completed["worktreeState"] = "completed"
            update_execution_metadata(workspace, completed, {"status": "completed", "completedAt": completed_at})
            if completed.get("worktreePath"):
                update_task_worktree_state(workspace, completed, str(completed.get("worktreeState") or "completed"))
            append_runner_event(workspace, "task_published", data={"executionId": execution.get("executionId"), "taskId": task_id})
            continue
        provider_ref = execution.get("providerRef") if isinstance(execution.get("providerRef"), dict) else {}
        if execution.get("provider") == "electron-session" and execution.get("status") in {"launching", "active"}:
            execution_id = execution.get("executionId")
            if (
                app_instance_id
                and live_execution_ids is not None
                and isinstance(execution_id, str)
                and execution_id not in live_execution_ids
            ):
                completed_at = now_iso()
                if execution.get("status") == "launching":
                    missing = {**execution, "status": "missing", "completedAt": completed_at}
                    update_execution_metadata(workspace, missing, {"status": "missing", "completedAt": completed_at})
                    mark_task_attempt_completed(workspace, missing, completed_at, None, summary="Terminal launch was not observed by Electron.")
                    clear_task_active_execution_if_matches(workspace, missing)
                    try:
                        requeue_task(workspace, str(task_id), reason="Terminal launch was not observed by Electron.")
                    except SwitchboardError:
                        pass
                    append_runner_event(workspace, "execution_missing", data={"executionId": execution_id, "taskId": task_id})
                    continue
                abandoned = {**execution, "status": "abandoned", "completedAt": completed_at, "exitCode": None}
                update_execution_metadata(workspace, abandoned, {"status": "abandoned", "completedAt": completed_at, "exitCode": None})
                mark_task_attempt_completed(workspace, abandoned, completed_at, None, summary="Electron no longer owns a live terminal for this execution.")
                clear_task_active_execution_if_matches(workspace, abandoned)
                reconciled.append(abandoned)
                append_runner_event(workspace, "task_abandoned", data={"executionId": execution_id, "taskId": task_id})
                continue

            active = {**execution, "status": "active", "lastSeenAt": now_iso()}
            update_execution_metadata(workspace, active, {"status": "active", "lastSeenAt": active["lastSeenAt"]})
            reconciled.append(active)
            continue
        exit_code = read_recorded_exit_code(workspace, execution)
        if exit_code is None:
            exit_code = reap_process_exit(provider_ref.get("pid"))
        running = exit_code is None and process_is_running(provider_ref.get("pid"))
        if running and located:
            active = {**execution, "status": "active", "lastSeenAt": now_iso()}
            update_execution_metadata(workspace, active, {"status": "active", "lastSeenAt": active["lastSeenAt"]})
            reconciled.append(active)
        elif located:
            completed_at = now_iso()
            abandoned = {**execution, "status": "abandoned", "completedAt": completed_at, "exitCode": exit_code}
            if abandoned.get("worktreePath") and abandoned.get("worktreeState") == "active":
                abandoned["worktreeState"] = "abandoned"
            update_execution_metadata(
                workspace,
                abandoned,
                {"status": "abandoned", "completedAt": completed_at, "exitCode": exit_code},
            )
            mark_task_attempt_completed(workspace, abandoned, completed_at, exit_code)
            reconciled.append(abandoned)
            append_runner_event(
                workspace,
                "task_abandoned",
                data={"executionId": execution.get("executionId"), "taskId": task_id, "exitCode": exit_code},
            )
    state["activeExecutions"] = reconciled
    return write_runner_state(workspace, state)


def reconcile_watchtower_execution(
    workspace: Path,
    execution: dict[str, Any],
    *,
    app_instance_id: str | None = None,
    live_execution_ids: set[str] | None = None,
) -> dict[str, Any]:
    from ..watchtower import update_watchtower_agent

    provider_ref = execution.get("providerRef") if isinstance(execution.get("providerRef"), dict) else {}
    if execution.get("provider") == "electron-session" and execution.get("status") in {"launching", "active"}:
        execution_id = execution.get("executionId")
        if (
            app_instance_id
            and live_execution_ids is not None
            and isinstance(execution_id, str)
            and execution_id not in live_execution_ids
        ):
            completed_at = now_iso()
            status = "missing" if execution.get("status") == "launching" else "abandoned"
            error = "Terminal launch was not observed by Electron." if status == "missing" else "Electron no longer owns a live terminal for this execution."
            completed = {**execution, "status": status, "completedAt": completed_at, "exitCode": None, "error": error}
            update_execution_metadata(workspace, completed, {"status": status, "completedAt": completed_at, "exitCode": None, "error": error})
            run_id = execution.get("watchtowerRunId")
            agent_id = execution.get("watchtowerAgentId")
            if isinstance(run_id, str) and isinstance(agent_id, str):
                update_watchtower_agent(
                    workspace,
                    run_id,
                    agent_id,
                    status="pending" if status == "missing" else "failed",
                    execution_id=None if status == "missing" else execution_id,
                    error_message=None if status == "missing" else error,
                )
            append_runner_event(workspace, "execution_missing" if status == "missing" else "task_abandoned", data={"executionId": execution_id, "kind": execution.get("kind")})
            return completed
        active = {**execution, "status": "active", "lastSeenAt": now_iso()}
        update_execution_metadata(workspace, active, {"status": "active", "lastSeenAt": active["lastSeenAt"]})
        return active
    exit_code = read_recorded_exit_code(workspace, execution)
    if exit_code is None:
        exit_code = reap_process_exit(provider_ref.get("pid"))
    running = exit_code is None and process_is_running(provider_ref.get("pid"))
    if running:
        active = {**execution, "status": "active", "lastSeenAt": now_iso()}
        update_execution_metadata(workspace, active, {"status": "active", "lastSeenAt": active["lastSeenAt"]})
        return active

    completed_at = now_iso()
    status = "completed" if exit_code == 0 else "abandoned"
    error = None if exit_code == 0 else (
        f"Process exited with code {exit_code}."
        if exit_code is not None
        else "Process ended without reporting an exit code."
    )
    completed = {**execution, "status": status, "completedAt": completed_at, "exitCode": exit_code, "error": error}
    update_execution_metadata(
        workspace,
        completed,
        {"status": status, "completedAt": completed_at, "exitCode": exit_code, "error": error},
    )
    run_id = execution.get("watchtowerRunId")
    agent_id = execution.get("watchtowerAgentId")
    if isinstance(run_id, str) and isinstance(agent_id, str):
        update_watchtower_agent(
            workspace,
            run_id,
            agent_id,
            status="completed" if exit_code == 0 else "failed",
            error_message=error,
        )
    append_runner_event(
        workspace,
        "execution_exit",
        data={"executionId": execution.get("executionId"), "kind": execution.get("kind"), "exitCode": exit_code},
    )
    return completed
