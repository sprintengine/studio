from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import time
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
RUNNER_PROVIDERS = ("local-process", "codex-app-server")
RUNNER_EVENTS = {
    "start",
    "pause",
    "resume",
    "run",
    "tick",
    "claim",
    "launch",
    "provider_error",
    "provider_execution_untracked",
    "execution_missing",
    "execution_stale",
    "execution_link_failed",
    "execution_exit",
    "task_published",
    "task_abandoned",
    "requeue",
    "worktree_created",
    "worktree_cleaned",
    "worktree_missing",
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
STALE_RUNNER_LOCK_SECONDS = 2 * 60
EXECUTION_ID_RE = re.compile(r"^exec_[A-Za-z0-9_-]+$")


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
    (root / "executions").mkdir(parents=True, exist_ok=True)
    (root / "worktrees").mkdir(parents=True, exist_ok=True)
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


def runner_lock_dir(workspace: Path) -> Path:
    return runner_dir(workspace) / ".runner.lock"


@contextmanager
def locked_runner(workspace: Path) -> Iterator[None]:
    init_workspace(workspace)
    lock_dir = runner_lock_dir(workspace)
    deadline = time.monotonic() + 5
    while True:
        try:
            lock_dir.mkdir()
            break
        except FileExistsError as exc:
            try:
                age = datetime.now(timezone.utc).timestamp() - lock_dir.stat().st_mtime
            except OSError:
                age = 0
            if age > STALE_RUNNER_LOCK_SECONDS:
                try:
                    lock_dir.rmdir()
                    continue
                except OSError:
                    pass
            if time.monotonic() >= deadline:
                raise SwitchboardError("Switchboard runner is locked by another process.") from exc
            time.sleep(0.05)
    try:
        yield
    finally:
        try:
            lock_dir.rmdir()
        except OSError:
            pass


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
        "provider": "local-process",
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
    state["provider"] = payload.get("provider") if payload.get("provider") in RUNNER_PROVIDERS else "local-process"
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
    return {
        "ok": True,
        "workspaceRoot": state.get("workspaceRoot"),
        "enabled": state.get("enabled") is True,
        "running": state.get("enabled") is True and state.get("paused") is False,
        "paused": state.get("paused") is not False,
        "provider": state.get("provider", "local-process"),
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
    provider: str = "local-process",
    cli: str = "codex",
    queues: list[str] | None = None,
    max_concurrency: int = 1,
) -> dict[str, Any]:
    with locked_runner(workspace):
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

    while active_execution_count(state) < state["maxConcurrency"]:
        launched = runner_claim_and_launch(workspace, state)
        if not launched:
            break
        state = reconcile_runner_state(workspace, read_runner_state(workspace))

    state = write_runner_state(workspace, state)
    append_runner_event(workspace, "tick", data={"activeExecutions": active_execution_count(state)})
    return runner_public_payload(state)


def execution_root(workspace: Path) -> Path:
    return switchboard_root(workspace) / "executions"


def execution_dir(workspace: Path, execution_id: str) -> Path:
    return execution_root(workspace) / execution_id


def worktree_root(workspace: Path) -> Path:
    return switchboard_root(workspace) / "worktrees"


def worktree_dir(workspace: Path, execution_id: str) -> Path:
    validate_execution_id(execution_id)
    return worktree_root(workspace) / execution_id


def role_for_queue(queue: str) -> str:
    return {"ready": "developer", "testing": "tester", "review": "reviewer"}[queue]


def claimed_status_for_queue(queue: str) -> str:
    return CLAIM_TRANSITIONS[queue]


def next_publish_for_queue(queue: str) -> str:
    return {"ready": "testing", "testing": "review", "review": "done"}[queue]


def build_runner_prompt(*, workspace: Path, task_id: str, queue: str, execution_id: str, run_workspace: Path | None = None) -> str:
    role = role_for_queue(queue)
    workspace_for_agent = (run_workspace or workspace).expanduser().resolve()
    return "\n".join(
        [
            f"You are the Switchboard {role} agent for task {task_id}.",
            "",
            f"Workspace: {workspace_for_agent}",
            f"Switchboard root workspace: {workspace.expanduser().resolve()}",
            f"Execution ID: {execution_id}",
            f"Claimed queue: {queue}",
            "",
            "Rules:",
            "- Do not edit Switchboard task JSON files or Lock files directly.",
            "- Use the local Switchboard CLI for task activity.",
            f"- Inspect the task with: scripts/switchboard show --workspace {workspace.expanduser().resolve()} {task_id}",
            f"- Add progress notes with: scripts/switchboard comment --workspace {workspace.expanduser().resolve()} {task_id} --body \"...\" --author \"{role}\"",
            f"- Publish only when required evidence is complete: scripts/switchboard publish --workspace {workspace.expanduser().resolve()} {task_id} --to {next_publish_for_queue(queue)}",
            "- If blocked or unable to proceed, add a comment and stop without moving the task.",
        ]
    )


def runner_command_for(state: dict[str, Any]) -> list[str] | None:
    override = os.environ.get("SWITCHBOARD_LOCAL_PROCESS_COMMAND") or os.environ.get("SWITCHBOARD_RUNNER_COMMAND")
    if override and override.strip():
        return shlex.split(override)
    cli = str(state.get("cli") or "codex")
    resolved = shutil.which(cli)
    return [resolved] if resolved else None


def validate_runner_capability(workspace: Path, state: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if state["provider"] != "local-process":
        return [f"{state['provider']} execution provider is defined but not implemented yet."]
    workspace_root = workspace.expanduser().resolve()
    if not workspace_root.is_dir():
        errors.append("workspace root must exist and be a directory.")
    command = runner_command_for(state)
    if not command:
        errors.append(f"Runner CLI executable was not found: {state.get('cli', 'codex')}")
    root = execution_root(workspace)
    try:
        root.mkdir(parents=True, exist_ok=True)
        probe = root / f".capability.{os.getpid()}.tmp"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
    except OSError as exc:
        errors.append(f"execution root is not writable: {exc}")
    return errors


def validate_worktree_capability(workspace: Path) -> list[str]:
    errors: list[str] = []
    workspace_root = workspace.expanduser().resolve()
    if not shutil.which("git"):
        errors.append("git executable was not found for Switchboard worktree allocation.")
        return errors
    completed = subprocess.run(
        ["git", "-C", str(workspace_root), "rev-parse", "--is-inside-work-tree"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if completed.returncode != 0 or completed.stdout.strip() != "true":
        errors.append("workspace must be inside a git worktree for implementation worktree allocation.")
    root = worktree_root(workspace)
    try:
        root.mkdir(parents=True, exist_ok=True)
        probe = root / f".capability.{os.getpid()}.tmp"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
    except OSError as exc:
        errors.append(f"worktree root is not writable: {exc}")
    return errors


def has_claim_candidate(workspace: Path, queue: str) -> bool:
    tasks, _problems, _locks = read_all(workspace)
    return any(located.folder_status == queue for located in tasks)


def sanitized_branch_component(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-._")
    return normalized or "task"


def branch_for_execution(task_id: str, execution_id: str) -> str:
    return f"switchboard/{sanitized_branch_component(task_id)[:12]}/{sanitized_branch_component(execution_id)[:18]}"


def relative_to_switchboard_root(workspace: Path, path: Path) -> str:
    return str(path.resolve().relative_to(switchboard_root(workspace).resolve()))


def validate_worktree_path(workspace: Path, path: Path) -> Path:
    root = worktree_root(workspace).resolve()
    resolved = path.expanduser().resolve()
    if not resolved.is_relative_to(root):
        raise SwitchboardError("Switchboard worktree path is outside the approved worktree root.")
    return resolved


def create_execution_worktree(workspace: Path, task_id: str, execution_id: str) -> dict[str, str]:
    errors = validate_worktree_capability(workspace)
    if errors:
        raise SwitchboardError(" ".join(errors))
    target = worktree_dir(workspace, execution_id)
    validate_worktree_path(workspace, target)
    if target.exists():
        raise SwitchboardError("Switchboard execution worktree already exists.")
    branch = branch_for_execution(task_id, execution_id)
    completed = subprocess.run(
        ["git", "-C", str(workspace.expanduser().resolve()), "worktree", "add", "-b", branch, str(target), "HEAD"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise SwitchboardError(f"Could not create Switchboard worktree: {completed.stderr.strip() or completed.stdout.strip()}")
    append_runner_event(
        workspace,
        "worktree_created",
        data={"taskId": task_id, "executionId": execution_id, "worktreePath": str(target), "worktreeBranch": branch},
    )
    return {
        "worktreePath": str(target),
        "worktreeBranch": branch,
        "worktreeState": "active",
        "worktreeRelativePath": relative_to_switchboard_root(workspace, target),
    }


def remove_worktree_path(workspace: Path, path: Path, *, force: bool = False) -> None:
    target = validate_worktree_path(workspace, path)
    if not target.exists():
        return
    command = ["git", "-C", str(workspace.expanduser().resolve()), "worktree", "remove"]
    if force:
        command.append("--force")
    command.append(str(target))
    completed = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False)
    if completed.returncode != 0:
        raise SwitchboardError(f"Could not remove Switchboard worktree: {completed.stderr.strip() or completed.stdout.strip()}")


def worktree_is_dirty(path: Path) -> bool:
    completed = subprocess.run(
        ["git", "-C", str(path), "status", "--porcelain"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        return True
    return bool(completed.stdout.strip())


def process_is_running(pid: Any) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def reap_process_exit(pid: Any) -> int | None:
    if not isinstance(pid, int) or pid <= 0 or os.name == "nt":
        return None
    try:
        waited_pid, status = os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        return None
    except OSError:
        return None
    if waited_pid == 0:
        return None
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    if os.WIFSIGNALED(status):
        return -os.WTERMSIG(status)
    return None


def active_execution_count(state: dict[str, Any]) -> int:
    return len([execution for execution in state.get("activeExecutions", []) if execution.get("status") == "active"])


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


def reconcile_runner_state(workspace: Path, state: dict[str, Any]) -> dict[str, Any]:
    tasks = {located.task["id"]: located for located in read_all(workspace)[0]}
    reconciled: list[dict[str, Any]] = []
    for execution in state.get("activeExecutions", []):
        execution = reconcile_execution_worktree(workspace, execution)
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


def runner_claim_and_launch(workspace: Path, state: dict[str, Any]) -> bool:
    capability_errors = validate_runner_capability(workspace, state)
    if capability_errors:
        message = " ".join(capability_errors)
        state["lastError"] = message
        write_runner_state(workspace, state)
        append_runner_event(workspace, "provider_error", message=message, data={"provider": state["provider"]})
        return False
    command = runner_command_for(state)
    if not command:
        raise SwitchboardError("Runner command disappeared after capability check.")

    for queue in state["queues"]:
        if not has_claim_candidate(workspace, queue):
            continue
        if queue == "ready":
            worktree_errors = validate_worktree_capability(workspace)
            if worktree_errors:
                message = " ".join(worktree_errors)
                state["lastError"] = message
                write_runner_state(workspace, state)
                append_runner_event(workspace, "provider_error", message=message, data={"provider": state["provider"], "queue": queue})
                return False
        role = role_for_queue(queue)
        located = claim_task(workspace, from_status=queue, agent=f"switchboard-{role}")
        if located is None:
            continue
        append_runner_event(workspace, "claim", data={"taskId": located.task["id"], "from": queue})
        execution_id = f"exec_{uuid.uuid4().hex}"
        try:
            execution = start_local_process_execution(workspace, state, located, queue, command, execution_id)
        except Exception as exc:
            requeue_task(workspace, located.task["id"], reason=f"Switchboard runner could not launch local-process: {exc}")
            state["lastError"] = str(exc)
            write_runner_state(workspace, state)
            append_runner_event(workspace, "provider_error", message=str(exc), data={"taskId": located.task["id"], "executionId": execution_id})
            return False
        state["activeExecutions"].append(execution)
        state["lastError"] = None
        write_runner_state(workspace, state)
        append_runner_event(workspace, "launch", data={"taskId": located.task["id"], "executionId": execution_id, "provider": "local-process"})
        return True
    return False


def start_local_process_execution(
    workspace: Path,
    state: dict[str, Any],
    located: LocatedTask,
    queue: str,
    command: list[str],
    execution_id: str,
) -> dict[str, Any]:
    current_dir = execution_dir(workspace, execution_id)
    current_dir.mkdir(parents=True, exist_ok=False)
    stdout_path = current_dir / "stdout.log"
    stderr_path = current_dir / "stderr.log"
    prompt_path = current_dir / "prompt.txt"
    exit_path = current_dir / "exit.json"
    stdout_path.touch()
    stderr_path.touch()
    worktree: dict[str, str] | None = create_execution_worktree(workspace, located.task["id"], execution_id) if queue == "ready" else None
    run_workspace = Path(worktree["worktreePath"]) if worktree else workspace.expanduser().resolve()
    prompt = build_runner_prompt(
        workspace=workspace,
        task_id=located.task["id"],
        queue=queue,
        execution_id=execution_id,
        run_workspace=run_workspace,
    )
    prompt_path.write_text(prompt + "\n", encoding="utf-8")
    wrapper = (
        "import json, pathlib, subprocess, sys\n"
        "command=json.loads(sys.argv[1])\n"
        "prompt=pathlib.Path(sys.argv[2]).read_text(encoding='utf-8')\n"
        "stdout_path=pathlib.Path(sys.argv[3])\n"
        "stderr_path=pathlib.Path(sys.argv[4])\n"
        "exit_path=pathlib.Path(sys.argv[5])\n"
        "with stdout_path.open('ab') as stdout, stderr_path.open('ab') as stderr:\n"
        "    completed=subprocess.run(command, input=prompt, text=True, stdout=stdout, stderr=stderr)\n"
        "exit_path.write_text(json.dumps({'exitCode': completed.returncode}), encoding='utf-8')\n"
        "sys.exit(completed.returncode)\n"
    )
    try:
        process = subprocess.Popen(
            [sys.executable, "-c", wrapper, json.dumps(command), str(prompt_path), str(stdout_path), str(stderr_path), str(exit_path)],
            cwd=str(run_workspace),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=os.name != "nt",
        )
    except Exception:
        if worktree:
            try:
                remove_worktree_path(workspace, Path(worktree["worktreePath"]), force=True)
            except SwitchboardError:
                pass
        raise

    provider_ref = {
        "pid": process.pid,
        "executionDir": str(current_dir.relative_to(switchboard_root(workspace))),
        "stdoutLog": str(stdout_path.relative_to(switchboard_root(workspace))),
        "stderrLog": str(stderr_path.relative_to(switchboard_root(workspace))),
        "exitFile": str(exit_path.relative_to(switchboard_root(workspace))),
        "cwd": str(run_workspace),
    }
    if worktree:
        provider_ref.update({key: worktree[key] for key in ("worktreePath", "worktreeBranch", "worktreeRelativePath", "worktreeState")})
    started_at = now_iso()
    execution = {
        "executionId": execution_id,
        "taskId": located.task["id"],
        "role": role_for_queue(queue),
        "claimedFrom": queue,
        "claimedStatus": claimed_status_for_queue(queue),
        "provider": "local-process",
        "providerRef": provider_ref,
        "startedAt": started_at,
        "lastSeenAt": started_at,
        "status": "active",
    }
    if worktree:
        execution.update(worktree)
    metadata = {
        "schemaVersion": 1,
        **execution,
        "command": command,
        "cwd": str(run_workspace),
        "prompt": prompt,
        "promptFile": str(prompt_path.relative_to(switchboard_root(workspace))),
        "pid": process.pid,
        "exitCode": None,
        "completedAt": None,
        "error": None,
    }
    atomic_write_json(current_dir / "metadata.json", metadata)
    try:
        link_runner_execution_to_task(workspace, located.task["id"], execution)
    except Exception as exc:
        terminate_process(process.pid)
        if worktree:
            try:
                remove_worktree_path(workspace, Path(worktree["worktreePath"]), force=True)
            except SwitchboardError:
                pass
        update_execution_metadata(
            workspace,
            execution,
            {
                "status": "launch_failed",
                "completedAt": now_iso(),
                "error": f"Task execution link failed: {exc}",
                "worktreeState": "cleaned" if worktree else None,
            },
        )
        raise
    return execution


def terminate_process(pid: Any) -> None:
    if not isinstance(pid, int) or pid <= 0:
        return
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        else:
            os.killpg(pid, signal.SIGTERM)
    except OSError:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass


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


def mark_task_attempt_completed(workspace: Path, execution: dict[str, Any], completed_at: str, exit_code: int | None) -> None:
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
                    "summary": f"Process exited with code {exit_code}.",
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


def runner_run(workspace: Path, *, once: bool = False) -> dict[str, Any]:
    if once:
        return runner_tick(workspace)
    from .server import serve

    return serve(workspace)


def runner_run_loop(workspace: Path, *, interval_seconds: float = 5.0, stop_event: Any | None = None) -> None:
    interval_override = os.environ.get("SWITCHBOARD_RUNNER_INTERVAL_SECONDS")
    if interval_override:
        try:
            interval_seconds = max(0.1, float(interval_override))
        except ValueError:
            pass
    append_runner_event(workspace, "run", data={"intervalSeconds": interval_seconds})
    while stop_event is None or not stop_event.is_set():
        try:
            with locked_runner(workspace):
                runner_tick_unlocked(workspace)
        except SwitchboardError:
            pass
        time.sleep(interval_seconds)


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
        )
        errors = validate_task_shape(task)
        if errors:
            raise SwitchboardError(" ".join(errors))
        path = task_path(workspace, "inbox", task["id"])
        atomic_write_json(path, task)
        return read_task_file(path, "inbox")


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
            "claim": None,
            "execution": clear_active_execution_metadata(located.task),
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
            "execution": clear_active_execution_metadata(located.task),
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
