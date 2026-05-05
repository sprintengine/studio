from __future__ import annotations

import json
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
            "title": "Implement lifecycle",
            "description": "Add task lifecycle commands.",
            "dependsOn": [],
            "ownedPaths": ["multiloop_core/tool.py"],
            "acceptanceCriteria": ["Task can be completed with evidence"],
            "implementationNotes": [],
            "ownerAgentId": None,
            "evidence": {"summary": "", "touchedFiles": [], "commandsRan": [], "results": []},
            "learnedFacts": [],
            "blockers": [],
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
            "startedAt": None,
            "completedAt": None,
        },
        {
            "id": "T2",
            "milestoneId": "M2",
            "role": "developer",
            "status": "ready",
            "title": "Dependent lifecycle test",
            "description": "Verify dependencies.",
            "dependsOn": ["T1"],
            "ownedPaths": ["tests/multiloop_tool/test_m2_lifecycle.py"],
            "acceptanceCriteria": [],
            "implementationNotes": [],
            "ownerAgentId": None,
            "evidence": {"summary": "", "touchedFiles": [], "commandsRan": [], "results": []},
            "learnedFacts": [],
            "blockers": [],
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
            "startedAt": None,
            "completedAt": None,
        },
        {
            "id": "T3",
            "milestoneId": "M1",
            "role": "developer",
            "status": "ready",
            "title": "Future milestone task",
        },
    ]
    return state


def test_task_next_claims_only_active_milestone_ready_tasks_and_resumes_owner(tmp_path: Path) -> None:
    state_path = tmp_path / "multiloop" / "m2" / "state.json"
    write_state(state_path, m2_state())
    cli = MultiloopCli(tmp_path, state_path)

    claimed = cli.run("task", "next", "--role", "developer", "--id", "developer-1")
    resumed = cli.run("task", "next", "--role", "developer", "--id", "developer-1")

    assert "Claimed task: T1 [in_progress]" in claimed.stdout
    assert "Resumed task: T1 [in_progress]" in resumed.stdout
    state = read_state(state_path)
    assert state["tasks"][0]["ownerAgentId"] == "developer-1"
    assert state["tasks"][1]["status"] == "ready"
    assert state["tasks"][2]["status"] == "ready"


def test_task_create_builds_valid_active_milestone_task_and_supports_lifecycle(tmp_path: Path) -> None:
    state_path = tmp_path / "multiloop" / "m2" / "state.json"
    state = m2_state()
    state["tasks"] = []
    write_state(state_path, state)
    cli = MultiloopCli(tmp_path, state_path)

    created = cli.run(
        "task",
        "create",
        "--task-id",
        "M2-T1",
        "--role",
        "developer",
        "--title",
        "Build lifecycle task",
        "--description",
        "Create a valid task without hand-editing JSON.",
        "--owned-path",
        "multiloop_core/tool.py",
        "--acceptance-criterion",
        "Task can be claimed and completed.",
        "--implementation-note",
        "Use the Multiloop CLI.",
    )
    claimed = cli.run("task", "next", "--role", "developer", "--id", "developer-1")
    cli.run(
        "task",
        "log",
        "--task-id",
        "M2-T1",
        "--id",
        "developer-1",
        "--summary",
        "Created task through CLI.",
        "--file",
        "multiloop_core/tool.py",
        "--command",
        "python3 scripts/multiloop_tool.py task create --help",
        "--result",
        "Help lists task creation arguments.",
    )
    completed = cli.run("task", "status", "--task-id", "M2-T1", "--status", "done", "--id", "developer-1")

    assert "Created task: M2-T1 [ready]" in created.stdout
    assert "Claimed task: M2-T1 [in_progress]" in claimed.stdout
    assert "Updated task: M2-T1 [done]" in completed.stdout
    final_state = read_state(state_path)
    task = final_state["tasks"][0]
    assert task["milestoneId"] == "M2"
    assert task["role"] == "developer"
    assert task["evidence"]["summary"] == "Created task through CLI."
    assert task["ownedPaths"] == ["multiloop_core/tool.py"]
    assert task["acceptanceCriteria"] == ["Task can be claimed and completed."]
    assert task["implementationNotes"] == ["Use the Multiloop CLI."]


def test_task_create_rejects_duplicate_inactive_done_and_unknown_dependencies(tmp_path: Path) -> None:
    state_path = tmp_path / "multiloop" / "m2" / "state.json"
    write_state(state_path, m2_state())
    cli = MultiloopCli(tmp_path, state_path)

    duplicate = cli.run_failure("task", "create", "--task-id", "T1", "--role", "developer", "--title", "Duplicate")
    inactive = cli.run_failure(
        "task",
        "create",
        "--task-id",
        "M1-T4",
        "--milestone-id",
        "M1",
        "--role",
        "developer",
        "--title",
        "Inactive milestone task",
    )
    done = cli.run_failure("task", "create", "--task-id", "M2-DONE", "--role", "developer", "--status", "done", "--title", "Done")
    bad_dependency = cli.run_failure(
        "task",
        "create",
        "--task-id",
        "M2-T4",
        "--role",
        "developer",
        "--title",
        "Bad dependency",
        "--depends-on",
        "NOPE",
    )

    assert "Task already exists: T1" in duplicate.stderr
    assert "Can only create tasks for the active milestone: M2" in inactive.stderr
    assert "Cannot create a task directly as done" in done.stderr
    assert "unknown task id 'NOPE'" in bad_dependency.stderr


def test_task_create_help_shows_usage_and_enum_values(tmp_path: Path) -> None:
    state_path = tmp_path / "multiloop" / "m2" / "state.json"
    cli = MultiloopCli(tmp_path, state_path)

    help_output = cli.run("task", "create", "--help").stdout

    assert "usage:" in help_output
    assert "--role" in help_output
    assert "developer" in help_output
    assert "code_reviewer" in help_output
    assert "--status" in help_output
    assert "todo,ready,in_progress,needs_input,done,blocked" in help_output


def test_state_validation_rejects_bad_dependencies_feedback_and_agent_ownership() -> None:
    state = m2_state()
    state["tasks"][0]["feedback"] = {"confidencePct": 91, "topFriction": "runtime"}
    state["tasks"][0]["ownerAgentId"] = "developer-1"
    state["agents"] = {"developer-1": {"role": "developer", "status": "running", "currentTaskId": "T1"}}
    validate_state(state)

    nullable_evidence = deepcopy(state)
    nullable_evidence["tasks"][0]["evidence"] = None
    validate_state(nullable_evidence)

    missing_evidence = deepcopy(state)
    del missing_evidence["tasks"][0]["evidence"]
    validate_state(missing_evidence)

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
    cross_milestone_dependency["tasks"][0]["dependsOn"] = ["T3"]
    with pytest.raises(
        StateValidationError,
        match=r"\$\.tasks\[0\]\.dependsOn\[0\]: task dependency 'T3' belongs to a different milestone",
    ):
        validate_state(cross_milestone_dependency)

    wrong_agent_task = deepcopy(state)
    wrong_agent_task["agents"]["developer-1"]["currentTaskId"] = "T2"
    wrong_agent_task["tasks"][1]["ownerAgentId"] = "developer-2"
    with pytest.raises(
        StateValidationError,
        match=r"\$\.agents\.developer-1\.currentTaskId: task 'T2' is not owned by 'developer-1'",
    ):
        validate_state(wrong_agent_task)


def test_task_claim_rejects_inactive_milestone_and_unfinished_dependencies(tmp_path: Path) -> None:
    state_path = tmp_path / "multiloop" / "m2" / "state.json"
    write_state(state_path, m2_state())
    cli = MultiloopCli(tmp_path, state_path)

    inactive = cli.run_failure("task", "claim", "--task-id", "T3", "--id", "developer-1")
    blocked_dependency = cli.run_failure("task", "claim", "--task-id", "T2", "--id", "developer-1")

    assert "outside the active milestone" in inactive.stderr
    assert "unfinished dependencies" in blocked_dependency.stderr
    assert read_state(state_path)["tasks"][1]["status"] == "ready"


def test_done_requires_evidence_and_clears_agent_after_log(tmp_path: Path) -> None:
    state_path = tmp_path / "multiloop" / "m2" / "state.json"
    write_state(state_path, m2_state())
    cli = MultiloopCli(tmp_path, state_path)

    cli.run("task", "claim", "--task-id", "T1", "--id", "developer-1")
    missing_evidence = cli.run_failure("task", "status", "--task-id", "T1", "--status", "done", "--id", "developer-1")
    cli.run(
        "task",
        "log",
        "--task-id",
        "T1",
        "--id",
        "developer-1",
        "--summary",
        "Implemented lifecycle",
        "--file",
        "multiloop_core/tool.py",
        "--command",
        "pytest tests/multiloop_tool",
        "--result",
        "Passed",
    )
    completed = cli.run(
        "task",
        "status",
        "--task-id",
        "T1",
        "--status",
        "done",
        "--id",
        "developer-1",
        "--confidence-pct",
        "91",
        "--hallucination-risk-pct",
        "5",
    )

    assert "before logging summary, files, commands, and results" in missing_evidence.stderr
    assert "Updated task: T1 [done]" in completed.stdout
    state = read_state(state_path)
    assert state["agents"]["developer-1"]["status"] == "idle"
    assert state["tasks"][0]["completedAt"] is not None
    assert state["tasks"][0]["feedback"] == {"confidencePct": 91, "hallucinationRiskPct": 5}


def test_notes_and_blockers_are_visible_and_prevent_milestone_acceptance(tmp_path: Path) -> None:
    state_path = tmp_path / "multiloop" / "m2" / "state.json"
    state = m2_state()
    state["tasks"][0]["status"] = "in_progress"
    state["tasks"][0]["ownerAgentId"] = "developer-1"
    write_state(state_path, state)
    cli = MultiloopCli(tmp_path, state_path)

    cli.run(
        "task",
        "note",
        "--task-id",
        "T1",
        "--id",
        "developer-1",
        "--learned-fact",
        "Lifecycle needs milestone-scoped summaries",
        "--blocker",
        "Need validation runtime",
    )
    status = cli.run("status").stdout
    detail = cli.run("milestone", "show", "M2", "--tasks").stdout
    summary = cli.run("summary").stdout
    rejected = cli.run_failure("milestone", "accept", "M2", "--id", "coordinator")

    assert "Blockers: 1 active" in status
    assert "Need validation runtime" in json.dumps(read_state(state_path))
    assert "Active structured blockers:" in detail
    assert "Lifecycle needs milestone-scoped summaries" in detail
    assert "Blockers: 1 active" in summary
    assert "active blockers: B1" in rejected.stderr


def test_milestone_show_task_detail_controls_are_bounded_and_filterable(tmp_path: Path) -> None:
    state_path = tmp_path / "multiloop" / "m2" / "state.json"
    state = m2_state()
    for index in range(4, 11):
        state["tasks"].append(
            {
                "id": f"T{index}",
                "milestoneId": "M2",
                "role": "tester" if index == 10 else "developer",
                "status": "done" if index == 10 else "ready",
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
    task_detail = cli.run("milestone", "show", "M2", "--task-id", "T10").stdout

    assert "Task details:" in bounded
    assert "Use --limit, --status, --task-id, or --verbose for details." in bounded
    assert "T7 [ready]" not in hidden
    assert "T10 [done]" in filtered
    assert "T1 [ready]" not in filtered
    assert "Touched files:" in task_detail
    assert "file-10.py" in task_detail


def test_milestone_start_block_and_accept_preserve_loop_final_goal_distinction(tmp_path: Path) -> None:
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
    accepted = cli.run("milestone", "accept", "M2", "--id", "coordinator")

    final_state = read_state(state_path)
    assert "Started milestone: M2 [active]" in started.stdout
    assert "Blocked milestone: M2 [blocked]" in blocked.stdout
    assert "active blockers: B1" in blocked_accept.stderr
    assert "Accepted milestone: M2 [accepted]" in accepted.stdout
    assert final_state["roadmap"][1]["status"] == "accepted"
    assert final_state["loop"]["status"] == "active"
