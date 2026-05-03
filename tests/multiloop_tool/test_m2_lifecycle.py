from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path
from typing import Any

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
    completed = cli.run("task", "status", "--task-id", "T1", "--status", "done", "--id", "developer-1")

    assert "before logging summary, files, commands, and results" in missing_evidence.stderr
    assert "Updated task: T1 [done]" in completed.stdout
    state = read_state(state_path)
    assert state["agents"]["developer-1"]["status"] == "idle"
    assert state["tasks"][0]["completedAt"] is not None


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
