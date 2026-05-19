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

"""Workspace paths, CLI shim materialization, and initialization."""

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


def multicode_cli_bin_dir() -> Path:
    configured = os.environ.get("MULTICODE_CLI_BIN")
    if configured and configured.strip():
        return Path(configured).expanduser().resolve()
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return (Path(base) / "Multicode" / "bin").resolve()
    return (Path.home() / ".multicode" / "bin").resolve()


def switchboard_bin_dir(workspace: Path) -> Path:
    return switchboard_root(workspace) / "bin"


def _module_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _script_path(name: str) -> Path:
    return _module_root() / "scripts" / name


def _switchboard_wrapper_path(*, windows: bool = False) -> Path:
    env_name = "MULTICODE_SWITCHBOARD_CLI_CMD" if windows else "MULTICODE_SWITCHBOARD_CLI"
    configured = os.environ.get(env_name)
    if configured and configured.strip():
        return Path(configured).expanduser().resolve()
    installed = multicode_cli_bin_dir() / ("switchboard.cmd" if windows else "switchboard")
    if installed.exists():
        return installed
    return _script_path("switchboard.cmd" if windows else "switchboard").resolve()


def _write_text_if_changed(path: Path, text: str, *, mode: int | None = None) -> None:
    if not path.exists() or path.read_text(encoding="utf-8") != text:
        path.write_text(text, encoding="utf-8")
    if mode is not None:
        path.chmod(mode)


def ensure_switchboard_cli_shims(workspace: Path) -> dict[str, str]:
    bin_dir = switchboard_bin_dir(workspace)
    bin_dir.mkdir(parents=True, exist_ok=True)
    posix_target = _switchboard_wrapper_path(windows=False)
    cmd_target = _switchboard_wrapper_path(windows=True)
    posix = bin_dir / "switchboard"
    cmd = bin_dir / "switchboard.cmd"
    posix_body = "\n".join(
        [
            "#!/usr/bin/env bash",
            "set -euo pipefail",
            f"exec {shlex.quote(str(posix_target))} \"$@\"",
            "",
        ]
    )
    cmd_body = "\n".join(
        [
            "@echo off",
            f"\"{cmd_target}\" %*",
            "",
        ]
    )
    _write_text_if_changed(posix, posix_body, mode=0o755)
    _write_text_if_changed(cmd, cmd_body)
    return {
        "binDir": str(bin_dir),
        "switchboard": str(posix),
        "switchboardCmd": str(cmd),
    }


def agent_cli_env(workspace: Path) -> dict[str, str]:
    shims = ensure_switchboard_cli_shims(workspace)
    path_entries = [shims["binDir"], str(multicode_cli_bin_dir())]
    path_key = "Path" if os.name == "nt" else "PATH"
    existing_path = os.environ.get(path_key) or os.environ.get("PATH", "")
    if existing_path:
        path_entries.append(existing_path)
    return {
        path_key: os.pathsep.join(path_entries),
        "MULTICODE_SWITCHBOARD_WORKSPACE": str(workspace.expanduser().resolve()),
    }


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
    cli_shims = ensure_switchboard_cli_shims(workspace)
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
        "cli": cli_shims,
    }
