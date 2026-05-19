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

"""Git and GitHub CLI helpers for Switchboard worktrees."""

def run_git_checked(cwd: Path, args: list[str], *, allow_failure: bool = False) -> subprocess.CompletedProcess[str]:
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    try:
        completed = subprocess.run(
            ["git", "-C", str(cwd), *args],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
            env=env,
            timeout=60,
        )
    except subprocess.TimeoutExpired as exc:
        raise SwitchboardError(f"Git command timed out after 60s: git {' '.join(args)}") from exc
    if completed.returncode != 0 and not allow_failure:
        raise SwitchboardError(f"Git command failed: git {' '.join(args)}: {completed.stderr.strip() or completed.stdout.strip()}")
    return completed


def compact_commit_subject(value: str) -> str:
    compact = " ".join(value.strip().split())
    return compact[:72] if compact else "Switchboard implementation"


def current_git_branch(worktree: Path, fallback: str | None = None) -> str:
    completed = run_git_checked(worktree, ["branch", "--show-current"])
    branch = completed.stdout.strip()
    if branch:
        return branch
    if fallback and fallback.strip():
        return fallback.strip()
    raise SwitchboardError("Switchboard worktree is not on a named branch.")


def default_pr_base_branch(workspace: Path) -> str:
    completed = run_git_checked(workspace, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], allow_failure=True)
    ref = completed.stdout.strip()
    if ref.startswith("origin/") and len(ref) > len("origin/"):
        return ref[len("origin/"):]
    completed = run_git_checked(workspace, ["branch", "--show-current"], allow_failure=True)
    branch = completed.stdout.strip()
    return branch or "main"


def commit_worktree_changes_if_needed(worktree: Path, task: dict[str, Any], execution_id: str) -> bool:
    status = run_git_checked(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout
    if not status:
        return False
    run_git_checked(worktree, ["add", "-A"])
    staged = run_git_checked(worktree, ["diff", "--cached", "--quiet"], allow_failure=True)
    if staged.returncode == 0:
        return False
    title = str(task.get("title") or task.get("identifier") or task.get("id") or "Switchboard implementation")
    task_id = str(task.get("id") or "")
    message = compact_commit_subject(f"Switchboard: {title}")
    body = "\n".join([f"Task: {task_id}", f"Execution: {execution_id}"]).strip()
    run_git_checked(worktree, ["commit", "-m", message, "-m", body])
    return True


def parse_url_from_output(output: str) -> str | None:
    match = re.search(r"https?://\S+", output)
    return match.group(0).rstrip(".,)") if match else None


def run_gh_checked(cwd: Path, args: list[str], *, allow_failure: bool = False) -> subprocess.CompletedProcess[str]:
    gh = shutil.which("gh")
    if not gh:
        raise SwitchboardError("GitHub CLI executable 'gh' was not found; cannot create a pull request.")
    env = {**os.environ, "GH_PROMPT_DISABLED": "1", "GIT_TERMINAL_PROMPT": "0"}
    try:
        completed = subprocess.run(
            [gh, *args],
            cwd=str(cwd),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
            env=env,
            timeout=60,
        )
    except subprocess.TimeoutExpired as exc:
        raise SwitchboardError(f"GitHub PR command timed out after 60s: gh {' '.join(args)}") from exc
    if completed.returncode != 0 and not allow_failure:
        raise SwitchboardError(f"GitHub PR command failed: gh {' '.join(args)}: {completed.stderr.strip() or completed.stdout.strip()}")
    return completed


def require_gh() -> None:
    if not shutil.which("gh"):
        raise SwitchboardError("GitHub CLI executable 'gh' was not found; cannot create a pull request.")
