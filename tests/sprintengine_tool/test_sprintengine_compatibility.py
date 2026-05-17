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
                "sprintengine": {
                    "name": "compat",
                    "goal": "Verify Sprint Engine compatibility facade",
                    "status": "executing",
                    "qualityPolicy": {"enabled": False},
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


def test_task_normalization_accepts_optional_source_and_dispatch() -> None:
    normalized = sprint_tool.normalize_task(
        {
            "id": "T1",
            "title": "Imported GitHub issue",
            "description": "Implement the issue",
            "role": "developer",
            "status": "todo",
            "source": {
                "type": "github",
                "externalId": "123",
                "externalUrl": "https://github.com/example/repo/issues/123",
                "repo": "example/repo",
                "title": "Remote issue title",
                "body": "Remote issue body",
                "externalUpdatedAt": "2026-05-07T12:00:00Z",
                "syncedAt": "2026-05-07T12:01:00Z",
                "syncStatus": "clean",
            },
            "dispatch": {
                "mode": "manual",
                "status": "todo",
                "triagedBy": "none",
            },
        }
    )

    assert normalized["source"] == {
        "type": "github",
        "externalId": "123",
        "externalUrl": "https://github.com/example/repo/issues/123",
        "repo": "example/repo",
        "title": "Remote issue title",
        "body": "Remote issue body",
        "externalUpdatedAt": "2026-05-07T12:00:00Z",
        "syncedAt": "2026-05-07T12:01:00Z",
        "syncStatus": "clean",
    }
    assert normalized["dispatch"] == {
        "mode": "manual",
        "status": "todo",
        "triagedBy": "none",
    }


def test_task_normalization_omits_missing_source_and_dispatch() -> None:
    normalized = sprint_tool.normalize_task(
        {
            "id": "T1",
            "title": "Local task",
            "description": "Existing local task",
            "role": "developer",
            "status": "todo",
        }
    )

    assert "source" not in normalized
    assert "dispatch" not in normalized


def test_swarm_commands_preserve_lifecycle_shape_through_sprint_engine_facade(
    tmp_path: Path,
) -> None:
    state_path = tmp_path / ".multi-code" / "sprintengine" / "compat" / "state.yaml"
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


def test_optional_source_and_dispatch_survive_compatibility_lifecycle(
    tmp_path: Path,
) -> None:
    state_path = tmp_path / ".multi-code" / "sprintengine" / "compat-metadata" / "state.yaml"
    write_state(state_path)
    state = json.loads(state_path.read_text(encoding="utf-8"))
    state["tasks"][0]["source"] = {
        "type": "github",
        "externalId": "123",
        "externalUrl": "https://github.com/example/repo/issues/123",
        "repo": "example/repo",
        "title": "Remote issue title",
        "body": "Remote issue body",
        "externalUpdatedAt": "2026-05-07T12:00:00Z",
        "syncedAt": "2026-05-07T12:01:00Z",
        "syncStatus": "clean",
    }
    state["tasks"][0]["dispatch"] = {
        "mode": "dependency",
        "status": "ready",
        "triagedBy": "user",
        "readyAt": "2026-05-07T12:05:00Z",
    }
    state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")

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
    assert claimed["task"]["source"]["type"] == "github"
    assert claimed["task"]["dispatch"]["mode"] == "dependency"

    state = json.loads(state_path.read_text(encoding="utf-8"))
    assert state["tasks"][0]["source"]["externalId"] == "123"
    assert state["tasks"][0]["source"]["body"] == "Remote issue body"
    assert state["tasks"][0]["dispatch"]["readyAt"] == "2026-05-07T12:05:00Z"
