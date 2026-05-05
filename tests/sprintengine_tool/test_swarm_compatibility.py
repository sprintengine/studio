from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import scripts.sprintengine_tool as sprint_cli
import sprintengine_core.tool as sprint_tool


REPO_ROOT = Path(__file__).resolve().parents[2]
SPRINT_TOOL = REPO_ROOT / "scripts" / "sprintengine_tool.py"


def write_state(state_path: Path) -> None:
    state_path.parent.mkdir(parents=True)
    state_path.write_text(
        json.dumps(
            {
                "swarm": {
                    "name": "compat",
                    "goal": "Verify Sprint Engine compatibility facade",
                    "status": "executing",
                },
                "tasks": [
                    {
                        "id": "T1",
                        "title": "Compatible claim",
                        "description": "Compatible claim",
                        "role": "developer",
                        "status": "todo",
                        "ownerAgentId": None,
                        "dependsOn": [],
                        "ownedPaths": ["sprintengine_core/tool.py"],
                        "acceptanceCriteria": [],
                        "implementationNotes": [],
                        "evidence": {
                            "summary": "",
                            "touchedFiles": [],
                            "commandsRan": [],
                            "results": [],
                        },
                        "notes": [],
                        "startedAt": None,
                        "completedAt": None,
                    }
                ],
                "agents": {},
                "events": [],
                "artifacts": [],
                "roles": {},
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def run_swarm(state_path: Path, *args: str) -> dict:
    completed = subprocess.run(
        [sys.executable, str(SPRINT_TOOL), "--state", str(state_path), *args],
        cwd=REPO_ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    return json.loads(completed.stdout)


def test_sprintengine_cli_imports_sprint_engine_tool() -> None:
    assert sprint_cli.direct_tool is sprint_tool


def test_swarm_commands_preserve_lifecycle_shape_through_sprint_engine_facade(
    tmp_path: Path,
) -> None:
    state_path = tmp_path / "swarm" / "compat" / "state.yaml"
    write_state(state_path)

    claimed = run_swarm(
        state_path,
        "task",
        "next",
        "--role",
        "developer",
        "--id",
        "developer-a",
    )
    assert claimed["ok"] is True
    assert claimed["claimed"] is True
    assert claimed["task"]["id"] == "T1"
    assert claimed["task"]["ownerAgentId"] == "developer-a"
    assert "tool" not in claimed

    logged = run_swarm(
        state_path,
        "task",
        "log",
        "--task-id",
        "T1",
        "--id",
        "developer-a",
        "--summary",
        "Logged through Sprint Engine compatibility facade",
        "--file",
        "sprintengine_core/tool.py",
        "--command",
        "python scripts/sprintengine_tool.py task next",
        "--result",
        "Passed",
    )
    assert logged["ok"] is True
    assert logged["task"]["evidence"]["touchedFiles"] == ["sprintengine_core/tool.py"]

    done = run_swarm(
        state_path,
        "task",
        "status",
        "--task-id",
        "T1",
        "--status",
        "done",
        "--id",
        "developer-a",
    )
    assert done["ok"] is True
    assert done["task"]["status"] == "done"
    state = json.loads(state_path.read_text(encoding="utf-8"))
    assert state["agents"]["developer-a"]["status"] == "idle"
