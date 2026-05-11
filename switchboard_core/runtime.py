from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable


CleanupCallback = Callable[[Path], None]


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    tmp_path.replace(path)


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
    stdout_path.touch()
    stderr_path.touch()
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
        if cleanup_path and cleanup_on_launch_error:
            cleanup_on_launch_error(cleanup_path)
        raise

    provider_ref = {
        "pid": process.pid,
        "executionDir": str(current_dir.relative_to(switchboard_root)),
        "stdoutLog": str(stdout_path.relative_to(switchboard_root)),
        "stderrLog": str(stderr_path.relative_to(switchboard_root)),
        "exitFile": str(exit_path.relative_to(switchboard_root)),
        "cwd": str(run_workspace),
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
        "pid": process.pid,
        "exitCode": None,
        "completedAt": None,
        "error": None,
    }
    atomic_write_json(current_dir / "metadata.json", execution_metadata)
    return execution
