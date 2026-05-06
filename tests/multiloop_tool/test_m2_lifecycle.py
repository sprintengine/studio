from __future__ import annotations

from copy import deepcopy
from pathlib import Path
from typing import Any

import pytest

from multiloop_core.state import StateValidationError, validate_state
from tests.multiloop_tool.test_m1_cli import MultiloopCli, base_state, read_state, write_state


def m2_state() -> dict[str, Any]:
    state = deepcopy(base_state())
    state["roadmap"][0]["status"] = "accepted"
    state["roadmap"][1]["status"] = "active"
    state["loop"]["currentMilestoneId"] = "M2"
    state["tasks"] = [
        {
            "id": "T1",
            "milestoneId": "M2",
            "role": "developer",
            "status": "ready",
            "title": "Legacy execution task",
            "description": "Legacy Multiloop task kept only for read/history tests.",
            "dependsOn": [],
            "ownedPaths": ["multiloop_core/tool.py"],
            "acceptanceCriteria": ["Task can be displayed."],
            "implementationNotes": [],
            "ownerAgentId": None,
            "evidence": {"summary": "Legacy evidence", "touchedFiles": [], "commandsRan": [], "results": []},
            "learnedFacts": [],
            "blockers": [],
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
            "startedAt": None,
            "completedAt": None,
        },
        {
            "id": "T2",
            "milestoneId": "M1",
            "role": "developer",
            "status": "ready",
            "title": "Other milestone legacy task",
        },
    ]
    return state


def test_task_mutation_commands_fail_with_sprintengine_direction(tmp_path: Path) -> None:
    state_path = tmp_path / "multiloop" / "m2" / "state.json"
    write_state(state_path, m2_state())
    cli = MultiloopCli(tmp_path, state_path)

    commands = [
        ("task", "create", "--task-id", "M2-T1", "--role", "developer", "--title", "Create task"),
        ("task", "next", "--role", "developer", "--id", "developer-1"),
        ("task", "claim", "--task-id", "T1", "--id", "developer-1"),
        ("task", "status", "--task-id", "T1", "--status", "done", "--id", "developer-1"),
        ("task", "log", "--task-id", "T1", "--id", "developer-1", "--summary", "Evidence"),
        ("task", "note", "--task-id", "T1", "--id", "developer-1", "--learned-fact", "Fact"),
    ]

    before = read_state(state_path)
    for command in commands:
        result = cli.run_failure(*command)
        assert "Multiloop no longer owns task execution." in result.stderr
        assert "scripts/sprintengine --state <linked-sprintengine-state>" in result.stderr
    assert read_state(state_path) == before


def test_task_create_help_remains_discoverable_while_command_is_disabled(tmp_path: Path) -> None:
    state_path = tmp_path / "multiloop" / "m2" / "state.json"
    cli = MultiloopCli(tmp_path, state_path)

    help_output = cli.run("task", "create", "--help").stdout

    assert "usage:" in help_output
    assert "--role" in help_output
    assert "developer" in help_output
    assert "code_reviewer" in help_output


def test_state_validation_still_rejects_bad_legacy_task_shapes() -> None:
    state = m2_state()
    state["tasks"][0]["feedback"] = {"confidencePct": 91, "topFriction": "runtime"}
    state["tasks"][0]["ownerAgentId"] = "developer-1"
    state["agents"] = {"developer-1": {"role": "developer", "status": "running", "currentTaskId": "T1"}}
    validate_state(state)

    nullable_evidence = deepcopy(state)
    nullable_evidence["tasks"][0]["evidence"] = None
    validate_state(nullable_evidence)

    bad_evidence = deepcopy(state)
    bad_evidence["tasks"][0]["evidence"] = []
    with pytest.raises(StateValidationError, match=r"\$\.tasks\[0\]\.evidence: expected object"):
        validate_state(bad_evidence)

    bad_feedback = deepcopy(state)
    bad_feedback["tasks"][0]["feedback"] = {"confidencePct": 101}
    with pytest.raises(StateValidationError, match=r"\$\.tasks\[0\]\.feedback\.confidencePct: expected number between 0 and 100"):
        validate_state(bad_feedback)

    bad_role = deepcopy(state)
    bad_role["tasks"][0]["role"] = "Implementer"
    with pytest.raises(StateValidationError, match=r"\$\.tasks\[0\]\.role: expected one of"):
        validate_state(bad_role)

    self_dependency = deepcopy(state)
    self_dependency["tasks"][0]["dependsOn"] = ["T1"]
    with pytest.raises(StateValidationError, match=r"\$\.tasks\[0\]\.dependsOn\[0\]: task cannot depend on itself"):
        validate_state(self_dependency)

    cross_milestone_dependency = deepcopy(state)
    cross_milestone_dependency["tasks"][0]["dependsOn"] = ["T2"]
    with pytest.raises(
        StateValidationError,
        match=r"\$\.tasks\[0\]\.dependsOn\[0\]: task dependency 'T2' belongs to a different milestone",
    ):
        validate_state(cross_milestone_dependency)


def test_milestone_show_legacy_task_detail_controls_still_read_history(tmp_path: Path) -> None:
    state_path = tmp_path / "multiloop" / "m2" / "state.json"
    state = m2_state()
    for index in range(3, 10):
        state["tasks"].append(
            {
                "id": f"T{index}",
                "milestoneId": "M2",
                "role": "tester" if index == 9 else "developer",
                "status": "done" if index == 9 else "ready",
                "title": f"Extra lifecycle task {index}",
                "dependsOn": [],
                "ownerAgentId": None,
                "evidence": {
                    "summary": f"Evidence {index}",
                    "touchedFiles": [f"file-{index}.py"],
                    "commandsRan": [f"command {index}"],
                    "results": [f"result {index}"],
                },
                "learnedFacts": [f"fact {index}"],
                "blockers": [],
            }
        )
    write_state(state_path, state)
    cli = MultiloopCli(tmp_path, state_path)

    bounded = cli.run("milestone", "show", "M2", "--tasks").stdout
    hidden = cli.run("milestone", "show", "M2", "--tasks", "--limit", "2").stdout
    filtered = cli.run("milestone", "show", "M2", "--tasks", "--status", "done").stdout
    task_detail = cli.run("milestone", "show", "M2", "--task-id", "T9").stdout

    assert "Task details:" in bounded
    assert "Use --limit, --status, --task-id, or --verbose for details." in bounded
    assert "T6 [ready]" not in hidden
    assert "T9 [done]" in filtered
    assert "T1 [ready]" not in filtered
    assert "Touched files:" in task_detail
    assert "file-9.py" in task_detail


def test_milestone_start_block_and_accept_use_execution_read_model(tmp_path: Path) -> None:
    state_path = tmp_path / "multiloop" / "m2" / "state.json"
    state = base_state()
    state["roadmap"][0]["status"] = "accepted"
    state["loop"]["currentMilestoneId"] = "M1"
    write_state(state_path, state)
    cli = MultiloopCli(tmp_path, state_path)

    started = cli.run("milestone", "start", "M2")
    blocked = cli.run("milestone", "block", "M2", "--reason", "Missing runtime", "--id", "coordinator")
    blocked_accept = cli.run_failure("milestone", "accept", "M2", "--id", "coordinator")

    state = read_state(state_path)
    state["blockers"][0]["status"] = "resolved"
    state["blockers"][0]["resolvedAt"] = "2026-01-01T01:00:00Z"
    write_state(state_path, state)
    unfinished_accept = cli.run_failure("milestone", "accept", "M2", "--id", "coordinator")

    assert "Started milestone: M2 [active]" in started.stdout
    assert "Sprint Engine state: .multi-code/sprintengine/fixture-loop-m2/state.yaml" in started.stdout
    assert "Blocked milestone: M2 [blocked]" in blocked.stdout
    assert "active blockers: B1" in blocked_accept.stderr
    assert "unfinished tasks:" in unfinished_accept.stderr
