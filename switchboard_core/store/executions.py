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

"""Execution metadata, stop, exit, log, and cleanup helpers."""

def terminate_process(pid: Any, *, timeout_seconds: float = 3.0) -> dict[str, Any]:
    result = {"requested": False, "terminated": False, "escalated": False}
    if not isinstance(pid, int) or pid <= 0:
        return result
    if not process_is_running(pid):
        result["terminated"] = True
        return result

    result["requested"] = True
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            result["escalated"] = True
        else:
            os.killpg(pid, signal.SIGTERM)
    except OSError:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass

    deadline = time.monotonic() + max(0.1, timeout_seconds)
    while time.monotonic() < deadline:
        if not process_is_running(pid):
            result["terminated"] = True
            return result
        time.sleep(0.05)

    if os.name != "nt":
        result["escalated"] = True
        try:
            os.killpg(pid, signal.SIGKILL)
        except OSError:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
        deadline = time.monotonic() + 1.0
        while time.monotonic() < deadline:
            if not process_is_running(pid):
                result["terminated"] = True
                return result
            time.sleep(0.05)

    result["terminated"] = not process_is_running(pid)
    return result


def execution_metadata_path(workspace: Path, execution_id: str) -> Path:
    return execution_dir(workspace, execution_id) / "metadata.json"


def read_execution_metadata(workspace: Path, execution_id: str) -> dict[str, Any]:
    validate_execution_id(execution_id)
    path = execution_metadata_path(workspace, execution_id)
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except json.JSONDecodeError:
        return {}


def validate_execution_id(execution_id: str) -> None:
    if not EXECUTION_ID_RE.match(execution_id):
        raise SwitchboardError("Switchboard execution id is invalid.")


def execution_status(workspace: Path, execution_id: str) -> dict[str, Any]:
    validate_execution_id(execution_id)
    metadata = read_execution_metadata(workspace, execution_id)
    if not metadata:
        raise SwitchboardError("Switchboard execution was not found.")
    return {"ok": True, "execution": metadata}


def execution_stop(workspace: Path, execution_id: str, *, reason: str | None = None) -> dict[str, Any]:
    with locked_runner(workspace):
        return execution_stop_unlocked(workspace, execution_id, reason=reason)


def execution_stop_unlocked(workspace: Path, execution_id: str, *, reason: str | None = None) -> dict[str, Any]:
    validate_execution_id(execution_id)
    metadata = read_execution_metadata(workspace, execution_id)
    if not metadata:
        raise SwitchboardError("Switchboard execution was not found.")
    if metadata.get("status") in {"completed", "abandoned", "stopped"}:
        return {
            "ok": True,
            "executionId": execution_id,
            "taskId": metadata.get("taskId"),
            "status": metadata.get("status"),
            "terminated": False,
            "worktreeState": metadata.get("worktreeState"),
        }
    provider_ref = metadata.get("providerRef") if isinstance(metadata.get("providerRef"), dict) else {}
    pid = provider_ref.get("pid")
    was_running = process_is_running(pid)
    termination = terminate_process(pid) if was_running else {"requested": False, "terminated": not process_is_running(pid), "escalated": False}
    if was_running and not termination.get("terminated"):
        raise SwitchboardError("Switchboard execution process could not be stopped.")
    stopped_at = now_iso()
    stopped_reason = reason.strip() if isinstance(reason, str) and reason.strip() else "Stopped by user."
    updates: dict[str, Any] = {
        "status": "stopped",
        "completedAt": stopped_at,
        "error": stopped_reason,
    }
    if metadata.get("worktreePath") and metadata.get("worktreeState") == "active":
        updates["worktreeState"] = "stopped"
        updates["providerRef"] = {**provider_ref, "worktreeState": "stopped"}
    stopped = {**metadata, **updates}
    update_execution_metadata(workspace, metadata, updates)
    if stopped.get("kind") in {"watchtower_review", "watchtower_triage"}:
        from ..watchtower import update_watchtower_agent

        run_id = stopped.get("watchtowerRunId")
        agent_id = stopped.get("watchtowerAgentId")
        if isinstance(run_id, str) and isinstance(agent_id, str):
            update_watchtower_agent(workspace, run_id, agent_id, status="canceled", error_message=stopped_reason)
    else:
        mark_task_attempt_completed(workspace, stopped, stopped_at, None, summary=stopped_reason)
        if stopped.get("worktreePath"):
            update_task_worktree_state(workspace, stopped, str(stopped.get("worktreeState") or "stopped"))
        clear_task_active_execution_if_matches(workspace, stopped)
    runner_state = read_runner_state(workspace)
    found = False
    next_executions = []
    for execution in runner_state.get("activeExecutions", []):
        if isinstance(execution, dict) and execution.get("executionId") == execution_id:
            next_executions.append({**execution, **updates})
            found = True
        else:
            next_executions.append(execution)
    if not found:
        next_executions.append(
            {
                "executionId": execution_id,
                "taskId": metadata.get("taskId"),
                "role": metadata.get("role", ""),
                "claimedFrom": metadata.get("claimedFrom", "ready"),
                "claimedStatus": metadata.get("claimedStatus", "in_progress"),
                "provider": metadata.get("provider", "electron-session"),
                "providerRef": provider_ref,
                "startedAt": metadata.get("startedAt", stopped_at),
                "lastSeenAt": metadata.get("lastSeenAt", stopped_at),
                **updates,
            }
        )
    runner_state["activeExecutions"] = next_executions
    write_runner_state(workspace, runner_state)
    append_runner_event(
        workspace,
        "execution_stopped",
        message=stopped_reason,
        data={
            "executionId": execution_id,
            "taskId": metadata.get("taskId"),
            "pid": pid,
            "terminated": termination.get("terminated") is True,
            "escalated": termination.get("escalated") is True,
        },
    )
    return {
        "ok": True,
        "executionId": execution_id,
        "taskId": metadata.get("taskId"),
        "status": "stopped",
        "terminated": termination.get("terminated") is True,
        "worktreeState": stopped.get("worktreeState"),
    }


def execution_record_session_exit(workspace: Path, execution_id: str, *, exit_code: int) -> dict[str, Any]:
    with locked_runner(workspace):
        validate_execution_id(execution_id)
        metadata = read_execution_metadata(workspace, execution_id)
        if not metadata:
            raise SwitchboardError("Switchboard execution was not found.")
        if metadata.get("provider") != "electron-session":
            return {"ok": True, "execution": metadata}
        if metadata.get("status") in {"completed", "abandoned", "stopped"}:
            return {"ok": True, "execution": metadata}

        if metadata.get("kind") in {"watchtower_review", "watchtower_triage"}:
            from ..watchtower import update_watchtower_agent

            completed_at = now_iso()
            status = "completed" if exit_code == 0 else "abandoned"
            error = None if exit_code == 0 else f"Terminal exited with code {exit_code}."
            updates = {
                "status": status,
                "completedAt": completed_at,
                "exitCode": exit_code,
                "error": error,
            }
            completed = {**metadata, **updates}
            update_execution_metadata(workspace, metadata, updates)
            run_id = metadata.get("watchtowerRunId")
            agent_id = metadata.get("watchtowerAgentId")
            if isinstance(run_id, str) and isinstance(agent_id, str):
                update_watchtower_agent(
                    workspace,
                    run_id,
                    agent_id,
                    status="completed" if exit_code == 0 else "failed",
                    error_message=error,
                )
            state = read_runner_state(workspace)
            state["activeExecutions"] = [
                {**execution, **updates}
                if isinstance(execution, dict) and execution.get("executionId") == execution_id
                else execution
                for execution in state.get("activeExecutions", [])
            ]
            write_runner_state(workspace, state)
            append_runner_event(
                workspace,
                "execution_exit",
                data={"executionId": execution_id, "kind": metadata.get("kind"), "exitCode": exit_code, "status": status},
            )
            return {"ok": True, "execution": completed}

        completed_at = now_iso()
        task_id = metadata.get("taskId")
        try:
            located = find_task(workspace, task_id) if isinstance(task_id, str) else None
        except SwitchboardError:
            located = None
        claimed_status = metadata.get("claimedStatus")
        published = bool(located and located.folder_status != claimed_status)
        status = "completed" if published else "abandoned"
        error = None if exit_code == 0 else f"Terminal exited with code {exit_code}."
        worktree_state = metadata.get("worktreeState")
        if metadata.get("worktreePath") and worktree_state == "active":
            worktree_state = "completed" if published else "abandoned"

        updates = {
            "status": status,
            "completedAt": completed_at,
            "exitCode": exit_code,
            "error": error,
            "worktreeState": worktree_state,
        }
        completed = {**metadata, **updates}
        update_execution_metadata(workspace, metadata, updates)
        if isinstance(task_id, str):
            mark_task_attempt_completed(workspace, completed, completed_at, exit_code)
            if metadata.get("worktreePath"):
                update_task_worktree_state(workspace, completed, str(worktree_state or status))
            if not published:
                clear_task_active_execution_if_matches(workspace, completed)

        state = read_runner_state(workspace)
        state["activeExecutions"] = [
            {**execution, **updates}
            if isinstance(execution, dict) and execution.get("executionId") == execution_id
            else execution
            for execution in state.get("activeExecutions", [])
        ]
        write_runner_state(workspace, state)
        append_runner_event(
            workspace,
            "execution_exit",
            data={"executionId": execution_id, "kind": metadata.get("kind"), "exitCode": exit_code, "status": status},
        )
        return {"ok": True, "execution": completed}


def execution_logs(workspace: Path, execution_id: str, *, stream: str, tail: int = 200) -> dict[str, Any]:
    validate_execution_id(execution_id)
    if stream not in {"stdout", "stderr"}:
        raise SwitchboardError("Execution log stream must be stdout or stderr.")
    metadata = read_execution_metadata(workspace, execution_id)
    if not metadata:
        raise SwitchboardError("Switchboard execution was not found.")
    provider_ref = metadata.get("providerRef") if isinstance(metadata.get("providerRef"), dict) else {}
    log_key = "stdoutLog" if stream == "stdout" else "stderrLog"
    relative_log = provider_ref.get(log_key)
    if not isinstance(relative_log, str):
        raise SwitchboardError("Execution log path is missing.")
    root = switchboard_root(workspace).resolve()
    log_path = (root / relative_log).resolve()
    if not log_path.is_relative_to(root):
        raise SwitchboardError("Execution log path is invalid.")
    tail = max(1, min(5000, tail))
    return {"ok": True, "executionId": execution_id, "stream": stream, "lines": tail_log_lines(log_path, tail)}


def execution_worktree_cleanup(workspace: Path, execution_id: str, *, force: bool = False) -> dict[str, Any]:
    with locked_runner(workspace):
        return execution_worktree_cleanup_unlocked(workspace, execution_id, force=force)


def execution_worktree_cleanup_unlocked(workspace: Path, execution_id: str, *, force: bool = False) -> dict[str, Any]:
    validate_execution_id(execution_id)
    metadata = read_execution_metadata(workspace, execution_id)
    if not metadata:
        raise SwitchboardError("Switchboard execution was not found.")
    provider_ref = metadata.get("providerRef") if isinstance(metadata.get("providerRef"), dict) else {}
    if metadata.get("status") == "active" and process_is_running(provider_ref.get("pid")):
        raise SwitchboardError("Switchboard execution is still active; stop or abandon it before cleaning its worktree.")
    task_id = metadata.get("taskId")
    if not isinstance(task_id, str):
        raise SwitchboardError("Switchboard execution has no owning task.")
    try:
        located = find_task(workspace, task_id)
    except SwitchboardError as exc:
        raise SwitchboardError("Switchboard execution owning task was not found.") from exc
    if located.folder_status not in {"done", "canceled"}:
        raise SwitchboardError("Switchboard worktree cleanup is only allowed for done or canceled tasks.")
    path_value = metadata.get("worktreePath")
    if not isinstance(path_value, str):
        path_value = provider_ref.get("worktreePath") if isinstance(provider_ref.get("worktreePath"), str) else None
    if not isinstance(path_value, str):
        raise SwitchboardError("Switchboard execution has no worktree.")
    path = validate_worktree_path(workspace, Path(path_value))
    existed = path.exists()
    if existed and worktree_is_dirty(path) and not force:
        raise SwitchboardError("Switchboard worktree has dirty or unmerged changes; pass --force to remove it.")
    if existed:
        remove_worktree_path(workspace, path, force=force)
    cleaned_at = now_iso()
    next_state = "cleaned" if existed else "missing"
    update_execution_metadata(
        workspace,
        metadata,
        {
            "worktreeState": next_state,
            "worktreeCleanedAt": cleaned_at if existed else None,
            "providerRef": {**provider_ref, "worktreeState": next_state},
        },
    )
    update_task_worktree_state(workspace, metadata, next_state)
    runner_state = read_runner_state(workspace)
    runner_state["activeExecutions"] = [
        {
            **execution,
            "worktreeState": next_state,
            "providerRef": {
                **(execution.get("providerRef") if isinstance(execution.get("providerRef"), dict) else {}),
                "worktreeState": next_state,
            },
        }
        if isinstance(execution, dict) and execution.get("executionId") == execution_id
        else execution
        for execution in runner_state.get("activeExecutions", [])
    ]
    write_runner_state(workspace, runner_state)
    append_runner_event(
        workspace,
        "worktree_cleaned" if existed else "worktree_missing",
        data={"executionId": execution_id, "taskId": metadata.get("taskId"), "worktreePath": str(path), "forced": force},
    )
    return {
        "ok": True,
        "executionId": execution_id,
        "worktreePath": str(path),
        "state": next_state,
        "forced": force,
    }


def tail_log_lines(path: Path, max_lines: int) -> list[str]:
    if not path.exists():
        return []
    chunk_size = 8192
    chunks: list[bytes] = []
    newline_count = 0
    with path.open("rb") as handle:
        handle.seek(0, os.SEEK_END)
        position = handle.tell()
        while position > 0 and newline_count <= max_lines:
            read_size = min(chunk_size, position)
            position -= read_size
            handle.seek(position)
            chunk = handle.read(read_size)
            chunks.append(chunk)
            newline_count += chunk.count(b"\n")
    data = b"".join(reversed(chunks))
    return data.decode("utf-8", errors="replace").splitlines()[-max_lines:]


def read_recorded_exit_code(workspace: Path, execution: dict[str, Any]) -> int | None:
    provider_ref = execution.get("providerRef") if isinstance(execution.get("providerRef"), dict) else {}
    exit_file = provider_ref.get("exitFile")
    if not isinstance(exit_file, str):
        return None
    path = switchboard_root(workspace) / exit_file
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    exit_code = payload.get("exitCode") if isinstance(payload, dict) else None
    return exit_code if isinstance(exit_code, int) else None


def update_execution_metadata(workspace: Path, execution: dict[str, Any], updates: dict[str, Any]) -> None:
    execution_id = execution.get("executionId")
    if not isinstance(execution_id, str):
        return
    metadata = {**read_execution_metadata(workspace, execution_id), **execution, **updates}
    atomic_write_json(execution_metadata_path(workspace, execution_id), metadata)


def mark_task_attempt_completed(
    workspace: Path,
    execution: dict[str, Any],
    completed_at: str,
    exit_code: int | None,
    *,
    summary: str | None = None,
) -> None:
    task_id = execution.get("taskId")
    if not isinstance(task_id, str):
        return
    try:
        located = find_task(workspace, task_id)
    except SwitchboardError:
        return
    execution_state = dict(located.task.get("execution", {}))
    attempts = []
    for attempt in execution_state.get("attempts", []):
        if isinstance(attempt, dict) and attempt.get("id") == execution.get("executionId"):
            attempts.append(
                {
                    **attempt,
                    "completedAt": completed_at,
                    "summary": summary or f"Process exited with code {exit_code}.",
                    "worktreePath": execution.get("worktreePath", attempt.get("worktreePath")),
                    "worktreeBranch": execution.get("worktreeBranch", attempt.get("worktreeBranch")),
                    "worktreeState": execution.get("worktreeState", attempt.get("worktreeState")),
                }
            )
        else:
            attempts.append(attempt)
    update_task(workspace, task_id, {"execution": {**execution_state, "attempts": attempts}})


def update_task_worktree_state(workspace: Path, execution: dict[str, Any], worktree_state: str) -> None:
    task_id = execution.get("taskId")
    execution_id = execution.get("executionId")
    if not isinstance(task_id, str) or not isinstance(execution_id, str):
        return
    try:
        located = find_task(workspace, task_id)
    except SwitchboardError:
        return
    execution_state = dict(located.task.get("execution", {}))
    attempts = []
    for attempt in execution_state.get("attempts", []):
        if isinstance(attempt, dict) and attempt.get("id") == execution_id:
            attempts.append({**attempt, "worktreeState": worktree_state})
        else:
            attempts.append(attempt)
    next_execution = {**execution_state, "attempts": attempts}
    if execution_state.get("activeExecutionId") == execution_id or execution_state.get("worktreePath") == execution.get("worktreePath"):
        next_execution["worktreeState"] = worktree_state
    update_task(workspace, task_id, {"execution": next_execution})


def clear_task_active_execution_if_matches(workspace: Path, execution: dict[str, Any]) -> None:
    task_id = execution.get("taskId")
    execution_id = execution.get("executionId")
    if not isinstance(task_id, str) or not isinstance(execution_id, str):
        return
    try:
        located = find_task(workspace, task_id)
    except SwitchboardError:
        return
    execution_state = dict(located.task.get("execution", {}))
    if execution_state.get("activeExecutionId") != execution_id:
        return
    update_task(
        workspace,
        task_id,
        {
            "execution": {
                **execution_state,
                "activeExecutionId": None,
                "activeProvider": None,
                "activeSessionId": None,
                "providerRef": None,
            }
        },
    )


def link_runner_execution_to_task(workspace: Path, task_id: str, execution: dict[str, Any]) -> None:
    located = find_task(workspace, task_id)
    execution_state = dict(located.task.get("execution", {}))
    attempts = list(execution_state.get("attempts", []))
    attempts.append(
        {
            "id": execution["executionId"],
            "agentId": f"switchboard-{execution['role']}",
            "startedAt": execution["startedAt"],
            "summary": f"Started by Switchboard runner via {execution['provider']}.",
            "worktreePath": execution.get("worktreePath"),
            "worktreeBranch": execution.get("worktreeBranch"),
            "worktreeState": execution.get("worktreeState"),
        }
    )
    worktree_updates = {}
    if execution.get("worktreePath"):
        worktree_updates = {
            "worktreePath": execution.get("worktreePath"),
            "worktreeBranch": execution.get("worktreeBranch"),
            "worktreeState": execution.get("worktreeState"),
        }
    update_task(
        workspace,
        task_id,
        {
            "execution": {
                **execution_state,
                **worktree_updates,
                "attempts": attempts,
                "activeExecutionId": execution["executionId"],
                "activeProvider": execution["provider"],
                "activeSessionId": None,
                "providerRef": execution["providerRef"],
            }
        },
    )
