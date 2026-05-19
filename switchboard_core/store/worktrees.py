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

"""Execution worktree and process helpers."""

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


def github_issue_branch(issue_number: int) -> str:
    return f"switchboard/issue-{issue_number}"


def relative_to_switchboard_root(workspace: Path, path: Path) -> str:
    return str(path.resolve().relative_to(switchboard_root(workspace).resolve()))


def validate_worktree_path(workspace: Path, path: Path) -> Path:
    root = worktree_root(workspace).resolve()
    resolved = path.expanduser().resolve()
    if not resolved.is_relative_to(root):
        raise SwitchboardError("Switchboard worktree path is outside the approved worktree root.")
    return resolved


def create_execution_worktree(workspace: Path, task_id: str, execution_id: str, *, branch_name: str | None = None) -> dict[str, str]:
    errors = validate_worktree_capability(workspace)
    if errors:
        raise SwitchboardError(" ".join(errors))
    target = worktree_dir(workspace, execution_id)
    validate_worktree_path(workspace, target)
    if target.exists():
        raise SwitchboardError("Switchboard execution worktree already exists.")
    branch = branch_name.strip() if isinstance(branch_name, str) and branch_name.strip() else branch_for_execution(task_id, execution_id)
    existing_branch = run_git_checked(workspace, ["show-ref", "--verify", "--quiet", f"refs/heads/{branch}"], allow_failure=True)
    existing_remote_branch = run_git_checked(workspace, ["ls-remote", "--heads", "origin", branch], allow_failure=True)
    remote_branch_exists_for_worktree = existing_remote_branch.returncode == 0 and bool(existing_remote_branch.stdout.strip())
    if existing_branch.returncode != 0 and remote_branch_exists_for_worktree:
        run_git_checked(workspace, ["fetch", "origin", f"{branch}:refs/remotes/origin/{branch}"])
    command = ["git", "-C", str(workspace.expanduser().resolve()), "worktree", "add"]
    if existing_branch.returncode == 0:
        command.extend([str(target), branch])
    elif remote_branch_exists_for_worktree:
        command.extend(["-b", branch, str(target), f"origin/{branch}"])
    else:
        command.extend(["-b", branch, str(target), "HEAD"])
    completed = subprocess.run(
        command,
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
    return len([execution for execution in state.get("activeExecutions", []) if execution.get("status") in {"active", "launching"}])
