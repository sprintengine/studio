from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable

from . import pty_session
from .pty_session import PtySession, get_registry


CleanupCallback = Callable[[Path], None]

DEFAULT_TTY_COLS = 120
DEFAULT_TTY_ROWS = 32

_PTY_EOF = b"\x04"


def start_local_process_agent_execution(
    *,
    switchboard_root: Path,
    command: list[str],
    execution_id: str,
    kind: str,
    role: str,
    prompt: str,
    run_workspace: Path,
    metadata: dict[str, Any] | None = None,
    provider_ref_metadata: dict[str, Any] | None = None,
    cleanup_path: Path | None = None,
    cleanup_on_launch_error: CleanupCallback | None = None,
    started_at: str,
) -> dict[str, Any]:
    current_dir = switchboard_root / "executions" / execution_id
    current_dir.mkdir(parents=True, exist_ok=False)
    stdout_path = current_dir / "stdout.log"
    stderr_path = current_dir / "stderr.log"
    prompt_path = current_dir / "prompt.txt"
    exit_path = current_dir / "exit.json"
    metadata_path = current_dir / "metadata.json"
    stdout_path.touch()
    stderr_path.touch()
    prompt_path.write_text(prompt + "\n", encoding="utf-8")

    use_pty = pty_session.pty_mode_enabled()

    if use_pty:
        pid, attachable = _spawn_pty(
            execution_id=execution_id,
            command=command,
            cwd=run_workspace,
            role=role,
            kind=kind,
            prompt=prompt,
            stdout_path=stdout_path,
            exit_path=exit_path,
            cleanup_path=cleanup_path,
            cleanup_on_launch_error=cleanup_on_launch_error,
        )
    else:
        pid = _spawn_wrapper(
            command=command,
            cwd=run_workspace,
            prompt_path=prompt_path,
            stdout_path=stdout_path,
            stderr_path=stderr_path,
            exit_path=exit_path,
            cleanup_path=cleanup_path,
            cleanup_on_launch_error=cleanup_on_launch_error,
        )
        attachable = False

    provider_ref = {
        "pid": pid,
        "executionDir": str(current_dir.relative_to(switchboard_root)),
        "stdoutLog": str(stdout_path.relative_to(switchboard_root)),
        "stderrLog": str(stderr_path.relative_to(switchboard_root)),
        "exitFile": str(exit_path.relative_to(switchboard_root)),
        "cwd": str(run_workspace),
        "attachable": attachable,
    }
    if provider_ref_metadata:
        provider_ref.update(provider_ref_metadata)
    execution = {
        "executionId": execution_id,
        "kind": kind,
        "role": role,
        "provider": "local-process",
        "providerRef": provider_ref,
        "startedAt": started_at,
        "lastSeenAt": started_at,
        "status": "active",
        **(metadata or {}),
    }
    execution_metadata = {
        "schemaVersion": 1,
        **execution,
        "command": command,
        "cwd": str(run_workspace),
        "prompt": prompt,
        "promptFile": str(prompt_path.relative_to(switchboard_root)),
        "pid": pid,
        "exitCode": None,
        "completedAt": None,
        "error": None,
    }
    # Imported lazily because store.py imports runtime.py for the spawn
    # function — a top-level import here would be circular.
    from .store import atomic_write_json

    atomic_write_json(metadata_path, execution_metadata)
    return execution


def _spawn_pty(
    *,
    execution_id: str,
    command: list[str],
    cwd: Path,
    role: str,
    kind: str,
    prompt: str,
    stdout_path: Path,
    exit_path: Path,
    cleanup_path: Path | None,
    cleanup_on_launch_error: CleanupCallback | None,
) -> tuple[int, bool]:
    initial_input = prompt.encode("utf-8") + b"\n" + _PTY_EOF
    try:
        session = PtySession(
            execution_id=execution_id,
            argv=list(command),
            cwd=cwd,
            env=None,
            cols=DEFAULT_TTY_COLS,
            rows=DEFAULT_TTY_ROWS,
            role=role,
            kind=kind,
            stdout_log_path=stdout_path,
            exit_file_path=exit_path,
            initial_input=initial_input,
        )
    except Exception:
        if cleanup_path and cleanup_on_launch_error:
            cleanup_on_launch_error(cleanup_path)
        raise
    get_registry().register(session)
    return session.pid, True


def _spawn_wrapper(
    *,
    command: list[str],
    cwd: Path,
    prompt_path: Path,
    stdout_path: Path,
    stderr_path: Path,
    exit_path: Path,
    cleanup_path: Path | None,
    cleanup_on_launch_error: CleanupCallback | None,
) -> int:
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
            cwd=str(cwd),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=os.name != "nt",
        )
    except Exception:
        if cleanup_path and cleanup_on_launch_error:
            cleanup_on_launch_error(cleanup_path)
        raise
    return process.pid
