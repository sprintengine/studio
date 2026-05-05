from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import yaml

from sprintengine_core.storage import (
    SprintEngineStorageError,
    find_state_file,
    get_run_status,
    inspect_run,
    list_runs,
    load_run,
)


def write_swarm_state(repo_root: Path, team_slug: str, state: dict[str, Any]) -> Path:
    state_path = repo_root / "swarm" / team_slug / "state.yaml"
    state_path.parent.mkdir(parents=True)
    state_path.write_text(yaml.safe_dump(state, sort_keys=False), encoding="utf-8")
    return state_path


def write_state_file(state_path: Path, state: dict[str, Any]) -> Path:
    state_path.parent.mkdir(parents=True)
    state_path.write_text(yaml.safe_dump(state, sort_keys=False), encoding="utf-8")
    return state_path


def minimal_swarm_state(team_slug: str) -> dict[str, Any]:
    return {
        "schemaVersion": 3,
        "swarm": {
            "name": team_slug,
            "goal": "Build read-only storage",
            "status": "executing",
            "updatedAt": "2026-05-04T19:40:00Z",
        },
        "tasks": [
            {
                "id": "T1",
                "title": "Done dependency",
                "description": "Completed prerequisite",
                "role": "developer",
                "status": "done",
                "ownerAgentId": "developer-1",
                "dependsOn": [],
                "ownedPaths": ["sprintengine_core/schema.py"],
                "acceptanceCriteria": ["Dependency is complete"],
                "implementationNotes": [],
                "evidence": {
                    "summary": "Finished dependency",
                    "touchedFiles": ["sprintengine_core/schema.py"],
                    "commandsRan": [".venv/Scripts/python.exe -m pytest"],
                    "results": ["Passed"],
                },
                "notes": ["Reviewed plan"],
                "learnedFacts": ["Swarm state remains the backing store"],
                "blockers": [],
                "startedAt": "2026-05-04T19:00:00Z",
                "completedAt": "2026-05-04T19:10:00Z",
            },
            {
                "id": "T2",
                "title": "Ready task",
                "description": "Can be claimed",
                "role": "developer",
                "status": "todo",
                "ownerAgentId": None,
                "dependsOn": ["T1"],
                "ownedPaths": ["sprintengine_core/storage.py"],
                "acceptanceCriteria": ["Task is ready when T1 is done"],
                "implementationNotes": ["Keep reads side-effect free"],
                "evidence": {
                    "summary": "",
                    "touchedFiles": [],
                    "commandsRan": [],
                    "results": [],
                },
                "notes": [],
                "blockers": [
                    {
                        "id": "B1",
                        "summary": "Example resolved blocker",
                        "createdAt": "2026-05-04T18:00:00Z",
                        "resolvedAt": "2026-05-04T18:30:00Z",
                    }
                ],
            },
        ],
        "agents": {
            "developer-1": {
                "role": "developer",
                "status": "done",
                "currentTaskId": None,
            }
        },
        "events": [
            {
                "id": "EVT-001",
                "timestamp": "2026-05-04T19:00:00Z",
                "type": "task_claimed",
                "actor": "developer-1",
                "message": "developer-1 claimed T1.",
            }
        ],
        "artifacts": [
            {
                "id": "A1",
                "kind": "requirements",
                "title": "Requirements",
                "path": f"swarm/{team_slug}/requirements.md",
                "status": "approved",
                "createdBy": "product-1",
                "taskId": "T0",
                "reviewHistory": [
                    {
                        "action": "approved",
                        "actor": "user",
                        "timestamp": "2026-05-04T18:55:00Z",
                    }
                ],
                "recommendedTasks": [],
                "approvedBy": "user",
            }
        ],
        "roles": {},
    }


def test_list_runs_discovers_swarm_team_states_as_sprint_run_ids(tmp_path: Path) -> None:
    write_swarm_state(tmp_path, "alpha", minimal_swarm_state("alpha"))
    write_swarm_state(tmp_path, "beta", minimal_swarm_state("beta"))
    ignored = tmp_path / "swarm" / "not-a-run" / "state.yaml"
    ignored.parent.mkdir(parents=True)
    ignored.write_text("tasks: []\n", encoding="utf-8")

    runs = list_runs(tmp_path)

    assert [run.id for run in runs] == ["sprint:alpha", "sprint:beta"]
    assert [run.name for run in runs] == ["alpha", "beta"]
    assert runs[0].source is not None
    assert runs[0].source.to_dict() == {
        "format": "swarm-state",
        "path": "swarm/alpha/state.yaml",
        "keyPath": "swarm",
    }


def test_load_run_maps_current_swarm_state_into_canonical_schema(tmp_path: Path) -> None:
    write_swarm_state(tmp_path, "alpha", minimal_swarm_state("alpha"))

    state = load_run("sprint:alpha", tmp_path)

    assert state.schema_version == 3
    assert state.run.to_dict() == {
        "id": "sprint:alpha",
        "name": "alpha",
        "goal": "Build read-only storage",
        "status": "executing",
        "updatedAt": "2026-05-04T19:40:00Z",
        "source": {
            "format": "swarm-state",
            "path": "swarm/alpha/state.yaml",
            "keyPath": "swarm",
        },
    }
    assert [task.id for task in state.tasks] == ["T1", "T2"]
    assert state.tasks[0].evidence.touched_files == ["sprintengine_core/schema.py"]
    assert state.tasks[0].learned_facts == ["Swarm state remains the backing store"]
    assert state.tasks[1].blockers[0].summary == "Example resolved blocker"
    assert state.artifacts[0].review_history[0].action == "approved"
    assert state.agents[0].id == "developer-1"
    assert state.events[0].type == "task_claimed"
    assert [role.id for role in state.specialist_roles] == [
        "architect",
        "product",
        "developer",
        "frontend",
        "tester",
        "security",
        "code_reviewer",
        "performance",
        "devops",
    ]
    assert state.source is not None
    assert state.source.path == "swarm/alpha/state.yaml"


def test_status_and_inspect_load_run_without_rewriting_state_file(tmp_path: Path) -> None:
    state_path = write_swarm_state(tmp_path, "alpha", minimal_swarm_state("alpha"))
    before_bytes = state_path.read_bytes()
    before_stat = state_path.stat()

    inspected = inspect_run("sprint:alpha", tmp_path)
    status = get_run_status("sprint:alpha", tmp_path)

    after_stat = state_path.stat()
    assert inspected.run.id == "sprint:alpha"
    assert status["run"]["id"] == "sprint:alpha"
    assert status["taskCounts"] == {"done": 1, "todo": 1}
    assert status["artifactCounts"] == {"approved": 1}
    assert status["readyTaskIds"] == ["T2"]
    assert state_path.read_bytes() == before_bytes
    assert after_stat.st_mtime_ns == before_stat.st_mtime_ns


def test_find_state_file_rejects_traversal_even_when_outside_state_exists(
    tmp_path: Path,
) -> None:
    repo_root = tmp_path / "repo"
    outside_state = write_state_file(
        tmp_path / "escape" / "state.yaml",
        minimal_swarm_state("escape"),
    )

    with pytest.raises(SprintEngineStorageError, match="Invalid Sprint Engine run id"):
        find_state_file("sprint:../../escape", repo_root)

    with pytest.raises(SprintEngineStorageError, match="Invalid Sprint Engine run id"):
        load_run("sprint:../../escape", repo_root)

    assert outside_state.is_file()


@pytest.mark.parametrize(
    "run_id",
    [
        "sprint:",
        "sprint:.",
        "sprint:..",
        "sprint:alpha/beta",
        "sprint:alpha\\beta",
        "sprint:C:alpha",
    ],
)
def test_find_state_file_rejects_non_slug_run_ids(
    tmp_path: Path,
    run_id: str,
) -> None:
    with pytest.raises(SprintEngineStorageError, match="Invalid Sprint Engine run id"):
        find_state_file(run_id, tmp_path)


def test_find_state_file_allows_single_segment_team_slug(tmp_path: Path) -> None:
    state_path = write_swarm_state(
        tmp_path,
        "alpha.01_shared-domain",
        minimal_swarm_state("alpha.01_shared-domain"),
    )

    assert find_state_file("sprint:alpha.01_shared-domain", tmp_path) == state_path
