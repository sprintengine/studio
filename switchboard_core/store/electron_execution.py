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

"""Electron session execution preparation."""

def prepare_electron_session_execution(
    workspace: Path,
    state: dict[str, Any],
    *,
    app_instance_id: str | None = None,
    workspace_id: str | None = None,
    reconcile: bool = True,
) -> dict[str, Any]:
    if reconcile:
        state = reconcile_runner_state(workspace, state)
    if not state["enabled"] or state["paused"]:
        return {"ok": True, "prepared": False, "message": "Runner is paused or disabled.", "runner": runner_public_payload(state)}
    if active_execution_count(state) >= state["maxConcurrency"]:
        return {"ok": True, "prepared": False, "message": "Runner concurrency is full.", "runner": runner_public_payload(state)}

    capability_command = runner_command_for(state)
    if not capability_command:
        message = f"Runner CLI executable was not found: {state.get('cli', 'codex')}"
        state["lastError"] = message
        write_runner_state(workspace, state)
        return {"ok": False, "message": message, "runner": runner_public_payload(state)}

    for queue in state["queues"]:
        if not has_claim_candidate(workspace, queue):
            continue
        if queue == "ready":
            worktree_errors = validate_worktree_capability(workspace)
            if worktree_errors:
                message = " ".join(worktree_errors)
                state["lastError"] = message
                write_runner_state(workspace, state)
                return {"ok": False, "message": message, "runner": runner_public_payload(state)}

        role = role_for_queue(queue)
        located = claim_task(workspace, from_status=queue, agent=f"switchboard-{role}")
        if located is None:
            continue

        execution_id = f"exec_{uuid.uuid4().hex}"
        worktree: dict[str, str] | None = None
        try:
            worktree = create_execution_worktree(
                workspace,
                located.task["id"],
                execution_id,
                branch_name=located.task.get("branchName") if isinstance(located.task.get("branchName"), str) else None,
            ) if queue == "ready" else None
            if worktree and github_issue_ref_for_task(located.task):
                push_github_coordination_branch(Path(worktree["worktreePath"]), worktree["worktreeBranch"])
            run_workspace = Path(worktree["worktreePath"]) if worktree else workspace.expanduser().resolve()
            prompt = build_runner_prompt(
                workspace=workspace,
                task_id=located.task["id"],
                queue=queue,
                execution_id=execution_id,
                run_workspace=run_workspace,
            )
            materialized = materialize_runner_command(state, execution_id=execution_id, prompt=prompt)
            if not materialized:
                raise SwitchboardError(
                    f"Runner CLI executable disappeared after capability check: {state.get('cli', 'codex')}"
                )
            command = materialized["command"]
            started_at = now_iso()
            execution_dir(workspace, execution_id).mkdir(parents=True, exist_ok=False)
            prompt_path = execution_dir(workspace, execution_id) / "prompt.txt"
            prompt_path.write_text(prompt + "\n", encoding="utf-8")
            env = agent_cli_env(workspace)
            provider_ref = {
                "cwd": str(run_workspace),
                "sessionId": execution_id,
                "attachable": True,
                **(worktree or {}),
            }
            execution = {
                "executionId": execution_id,
                "kind": "switchboard_task",
                "system": "switchboard",
                "workId": located.task["id"],
                "role": role,
                "provider": "electron-session",
                "providerRef": provider_ref,
                "startedAt": started_at,
                "lastSeenAt": started_at,
                "launchStartedAt": started_at,
                "ownerAppInstanceId": app_instance_id,
                "workspaceId": workspace_id,
                "sessionId": execution_id,
                "status": "launching",
                "taskId": located.task["id"],
                "claimedFrom": queue,
                "claimedStatus": claimed_status_for_queue(queue),
                **(worktree or {}),
            }
            atomic_write_json(
                execution_metadata_path(workspace, execution_id),
                {
                    "schemaVersion": 1,
                    **execution,
                    "command": command,
                    "cwd": str(run_workspace),
                    "prompt": prompt,
                    "promptFile": relative_to_switchboard_root(workspace, prompt_path),
                    "exitCode": None,
                    "completedAt": None,
                    "error": None,
                },
            )
            link_runner_execution_to_task(workspace, located.task["id"], execution)
        except Exception:
            if worktree:
                try:
                    remove_worktree_path(workspace, Path(worktree["worktreePath"]), force=True)
                except SwitchboardError:
                    pass
            try:
                requeue_task(workspace, located.task["id"], reason="Switchboard runner could not prepare the execution after claiming the task.")
            except SwitchboardError:
                pass
            raise

        state["activeExecutions"].append(execution)
        state["lastError"] = None
        state = write_runner_state(workspace, state)
        append_runner_event(
            workspace,
            "launch",
            data={"taskId": located.task["id"], "executionId": execution_id, "provider": "electron-session"},
        )
        return {
            "ok": True,
            "prepared": True,
            "execution": execution,
            "descriptor": {
                "executionId": execution_id,
                "system": "switchboard",
                "workId": located.task["id"],
                "role": role,
                "displayName": located.task.get("title") or f"Switchboard {role}",
                "command": command,
                "cwd": str(run_workspace),
                "env": env,
                "prompt": prompt,
                "cli": state.get("cli", "codex"),
                "injection": materialized["injection"],
                "completion": materialized["completion"],
            },
            "runner": runner_public_payload(state),
        }

    return {"ok": True, "prepared": False, "message": "No eligible task.", "runner": runner_public_payload(state)}
