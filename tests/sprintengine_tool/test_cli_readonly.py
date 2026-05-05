from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import yaml


REPO_ROOT = Path(__file__).resolve().parents[2]
SPRINTENGINE_TOOL = REPO_ROOT / "scripts" / "sprintengine_tool.py"


def write_swarm_state(repo_root: Path, team_slug: str) -> Path:
    state_path = repo_root / "swarm" / team_slug / "state.yaml"
    state_path.parent.mkdir(parents=True)
    state_path.write_text(
        yaml.safe_dump(
            {
                "schemaVersion": 3,
                "swarm": {
                    "name": team_slug,
                    "goal": "Verify read-only CLI",
                    "status": "executing",
                    "updatedAt": "2026-05-04T19:40:00Z",
                },
                "tasks": [
                    {
                        "id": "T1",
                        "title": "Done task",
                        "description": "Done task",
                        "role": "developer",
                        "status": "done",
                        "ownerAgentId": "developer-a",
                        "dependsOn": [],
                        "ownedPaths": ["sprintengine_core/cli.py"],
                        "acceptanceCriteria": ["CLI exposes tasks"],
                        "implementationNotes": [],
                        "evidence": {
                            "summary": "Implemented CLI",
                            "touchedFiles": ["sprintengine_core/cli.py"],
                            "commandsRan": [
                                ".venv/Scripts/python.exe -m pytest tests/sprintengine_tool/test_cli_readonly.py"
                            ],
                            "results": ["Passed"],
                        },
                        "notes": [],
                        "startedAt": "2026-05-04T19:00:00Z",
                        "completedAt": "2026-05-04T19:10:00Z",
                    },
                    {
                        "id": "T2",
                        "title": "Ready task",
                        "description": "Ready task",
                        "role": "tester",
                        "status": "todo",
                        "ownerAgentId": None,
                        "dependsOn": ["T1"],
                        "ownedPaths": ["tests/sprintengine_tool/test_cli_readonly.py"],
                        "acceptanceCriteria": ["Ready task appears in status"],
                        "implementationNotes": [],
                        "evidence": {
                            "summary": "",
                            "touchedFiles": [],
                            "commandsRan": [],
                            "results": [],
                        },
                        "notes": [],
                    },
                ],
                "agents": {
                    "developer-a": {
                        "role": "developer",
                        "status": "done",
                        "currentTaskId": None,
                    }
                },
                "events": [
                    {
                        "id": "EVT-001",
                        "timestamp": "2026-05-04T19:00:00Z",
                        "type": "task_completed",
                        "actor": "developer-a",
                        "message": "developer-a completed T1.",
                        "taskId": "T1",
                    }
                ],
                "artifacts": [
                    {
                        "id": "A1",
                        "kind": "requirements",
                        "title": "Requirements",
                        "path": f"swarm/{team_slug}/requirements.md",
                        "status": "approved",
                        "createdBy": "product-a",
                        "taskId": "T0",
                        "reviewHistory": [],
                        "recommendedTasks": [],
                        "approvedBy": "user",
                    }
                ],
                "roles": {},
            },
            sort_keys=False,
        ),
        encoding="utf-8",
    )
    return state_path


def run_cli(repo_root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SPRINTENGINE_TOOL), "--repo-root", str(repo_root), *args],
        cwd=REPO_ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def parse_success(completed: subprocess.CompletedProcess[str]) -> dict[str, Any]:
    assert completed.returncode == 0, completed.stderr
    assert completed.stderr == ""
    payload = json.loads(completed.stdout)
    assert isinstance(payload, dict)
    return payload


def test_run_commands_return_deterministic_json(tmp_path: Path) -> None:
    state_path = write_swarm_state(tmp_path, "alpha")
    before_bytes = state_path.read_bytes()
    before_stat = state_path.stat()

    first_list = run_cli(tmp_path, "run", "list")
    second_list = run_cli(tmp_path, "run", "list")
    status = parse_success(run_cli(tmp_path, "run", "status", "sprint:alpha"))
    inspected = parse_success(run_cli(tmp_path, "run", "inspect", "sprint:alpha"))

    assert first_list.stdout == second_list.stdout
    runs = parse_success(first_list)
    assert runs["runs"][0]["id"] == "sprint:alpha"
    assert status["status"]["readyTaskIds"] == ["T2"]
    assert inspected["state"]["run"]["source"]["path"] == "swarm/alpha/state.yaml"
    assert state_path.read_bytes() == before_bytes
    assert state_path.stat().st_mtime_ns == before_stat.st_mtime_ns


def test_task_artifact_and_report_commands_expose_run_objects(tmp_path: Path) -> None:
    write_swarm_state(tmp_path, "alpha")

    tasks = parse_success(run_cli(tmp_path, "task", "list", "--run", "sprint:alpha"))
    artifacts = parse_success(
        run_cli(tmp_path, "artifact", "list", "--run", "sprint:alpha")
    )
    report = parse_success(
        run_cli(tmp_path, "report", "export", "--run", "sprint:alpha", "--format", "json")
    )

    assert [task["id"] for task in tasks["tasks"]] == ["T1", "T2"]
    assert artifacts["artifacts"][0]["id"] == "A1"
    assert report["format"] == "json"
    assert report["report"]["run"]["id"] == "sprint:alpha"
    assert report["report"]["agents"][0]["id"] == "developer-a"
    assert report["report"]["events"][0]["id"] == "EVT-001"
    assert report["report"]["evidenceSummaries"] == [
        {
            "taskId": "T1",
            "summary": "Implemented CLI",
            "touchedFiles": ["sprintengine_core/cli.py"],
            "commandsRan": [
                ".venv/Scripts/python.exe -m pytest tests/sprintengine_tool/test_cli_readonly.py"
            ],
            "results": ["Passed"],
        }
    ]
    assert report["report"]["source"]["path"] == "swarm/alpha/state.yaml"


def test_unsupported_write_like_commands_return_clear_nonzero_error(
    tmp_path: Path,
) -> None:
    write_swarm_state(tmp_path, "alpha")

    completed = run_cli(
        tmp_path,
        "task",
        "claim",
        "--run",
        "sprint:alpha",
        "--id",
        "developer-a",
    )

    assert completed.returncode == 2
    assert completed.stdout == ""
    assert "read/status/report commands only" in completed.stderr
    assert "mutation commands are intentionally unavailable" in completed.stderr


def test_run_status_rejects_traversal_run_id_without_path_leak(
    tmp_path: Path,
) -> None:
    repo_root = tmp_path / "repo"
    outside_state = tmp_path / "escape" / "state.yaml"
    outside_state.parent.mkdir(parents=True)
    outside_state.write_text(
        yaml.safe_dump(
            {
                "schemaVersion": 3,
                "swarm": {
                    "name": "escape",
                    "goal": "Should not load",
                    "status": "executing",
                },
                "tasks": [],
                "agents": {},
                "events": [],
                "artifacts": [],
            },
            sort_keys=False,
        ),
        encoding="utf-8",
    )

    completed = run_cli(repo_root, "run", "status", "sprint:../../escape")

    assert completed.returncode == 2
    assert completed.stdout == ""
    assert "Invalid Sprint Engine run id" in completed.stderr
    assert str(outside_state) not in completed.stderr
    assert str(tmp_path) not in completed.stderr
