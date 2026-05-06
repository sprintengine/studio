from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path
from typing import Any

from tests.multiloop_tool.test_m1_cli import MultiloopCli, read_state, write_state


def _task(task_id: str, milestone_id: str, title: str, *, status: str = "ready") -> dict[str, Any]:
    return {
        "id": task_id,
        "milestoneId": milestone_id,
        "role": "developer",
        "status": status,
        "title": title,
        "description": f"Complete {title.lower()}.",
        "dependsOn": [],
        "ownedPaths": ["multiloop_core/tool.py"],
        "acceptanceCriteria": [f"{title} has auditable evidence."],
        "implementationNotes": [],
        "ownerAgentId": None,
        "evidence": {"summary": "", "touchedFiles": [], "commandsRan": [], "results": []},
        "learnedFacts": [],
        "blockers": [],
        "createdAt": "2026-01-01T00:00:00Z",
        "updatedAt": "2026-01-01T00:00:00Z",
        "startedAt": None,
        "completedAt": None,
    }


def _complete_legacy_task(state_path: Path, task_id: str, *, agent_id: str, summary: str) -> None:
    state = read_state(state_path)
    for task in state["tasks"]:
        if task["id"] != task_id:
            continue
        task["status"] = "done"
        task["ownerAgentId"] = agent_id
        task["evidence"] = {
            "summary": summary,
            "touchedFiles": ["multiloop_core/tool.py"],
            "commandsRan": ["pytest tests/multiloop_tool"],
            "results": ["Passed"],
        }
        task["completedAt"] = "2026-01-01T00:10:00Z"
        task["updatedAt"] = "2026-01-01T00:10:00Z"
        write_state(state_path, state)
        return
    raise AssertionError(f"missing task {task_id}")


def _complete_linked_sprintengine_run(tmp_path: Path, team_slug: str) -> None:
    sprint_state_path = tmp_path / ".multi-code" / "sprintengine" / team_slug / "state.yaml"
    state = json.loads(sprint_state_path.read_text(encoding="utf-8"))
    for task in state["tasks"]:
        task["status"] = "done"
        task["ownerAgentId"] = None
        task["evidence"] = {
            "summary": "Sprint Engine gate completed for fixture.",
            "touchedFiles": ["sprintengine_core/tool.py"],
            "commandsRan": ["pytest tests/sprintengine_tool"],
            "results": ["Passed"],
        }
        task["completedAt"] = "2026-01-01T00:10:00Z"
    sprint_state_path.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def test_two_milestone_fixture_preserves_accepted_history_and_surfaces_next_milestone(
    tmp_path: Path,
) -> None:
    state_path = tmp_path / "multiloop" / "m7-two-milestone" / "state.json"
    cli = MultiloopCli(tmp_path, state_path)
    cli.run("init", "--name", "M7 Two Milestone", "--final-goal", "Ship a validated adaptive loop.")
    state = read_state(state_path)
    state["roadmap"].extend(
        [
            {
                "id": "M2",
                "title": "Implement and validate fixture slice",
                "status": "planned",
                "goal": "Complete the second validation slice.",
                "entryCriteria": [],
                "acceptanceCriteria": [],
                "finalGoalContribution": "Validates next-milestone execution after accepted history.",
                "learnedFacts": [],
                "blockers": [],
                "reviewVerdicts": [],
            },
            {
                "id": "M3",
                "title": "Review-informed continuation",
                "status": "planned",
                "goal": "Use evidence to decide whether more roadmap work is needed.",
                "entryCriteria": [],
                "acceptanceCriteria": [],
                "finalGoalContribution": "Keeps future roadmap decisions evidence-backed.",
                "learnedFacts": [],
                "blockers": [],
                "reviewVerdicts": [],
            },
        ]
    )
    state["tasks"] = [_task("T1", "M1", "Build state reader"), _task("T2", "M2", "Validate renderer fixture")]
    write_state(state_path, state)

    _complete_legacy_task(state_path, "T1", agent_id="developer-m1", summary="State reader fixture passed.")
    cli.run(
        "milestone",
        "verdict",
        "add",
        "M1",
        "--id",
        "tester-m1",
        "--role",
        "tester",
        "--verdict",
        "accepted",
        "--evidence",
        "T1 evidence includes touched files, command, and passing result.",
        "--final-goal-implication",
        "The state reader evidence supports the final validated loop goal.",
        "--next-recommendation",
        "Accept M1 and start M2.",
    )
    cli.run("milestone", "accept", "M1", "--id", "coordinator")
    after_m1_accept = read_state(state_path)
    accepted_m1_snapshot = deepcopy(after_m1_accept["roadmap"][0])
    accepted_t1_snapshot = deepcopy(after_m1_accept["tasks"][0])

    cli.run(
        "roadmap",
        "revise",
        "M3",
        "--learned-fact",
        "M1 evidence proved reviewers need fixture-backed next-milestone context.",
        "--rationale",
        "M1 tester verdict narrowed the future validation scope.",
        "--id",
        "coordinator",
    )
    started = cli.run("milestone", "start", "M2").stdout
    _complete_legacy_task(state_path, "T2", agent_id="developer-m2", summary="Renderer fixture passed.")
    _complete_linked_sprintengine_run(tmp_path, "m7-two-milestone-m2")
    cli.run(
        "milestone",
        "verdict",
        "add",
        "M2",
        "--id",
        "tester-m2",
        "--role",
        "tester",
        "--verdict",
        "accepted",
        "--evidence",
        "T2 evidence proves the next active milestone is visible and executable.",
        "--final-goal-implication",
        "Second milestone validation keeps the loop moving toward the final goal.",
        "--next-recommendation",
        "Accept M2 and keep M3 planned with revised learning.",
    )
    cli.run("milestone", "accept", "M2", "--id", "coordinator")

    roadmap = cli.run("roadmap", "show").stdout
    m2_detail = cli.run("milestone", "show", "M2", "--tasks").stdout
    final_state = read_state(state_path)

    assert "Started milestone: M2 [active]: Implement and validate fixture slice" in started
    assert "* M2 [accepted]: Implement and validate fixture slice" in roadmap
    assert "- M3 [planned]: Review-informed continuation" in roadmap
    assert "Latest revision: R1 - M1 tester verdict narrowed the future validation scope." in roadmap
    verdicts = cli.run("milestone", "verdict", "list", "M2").stdout
    assert "Verdicts for M2 [accepted]: Implement and validate fixture slice" in verdicts
    assert "V1 tester [accepted] by tester-m2" in verdicts
    assert "T2 [done]" in m2_detail
    assert "Renderer fixture passed." in m2_detail
    assert final_state["roadmap"][0] == accepted_m1_snapshot
    assert final_state["tasks"][0] == accepted_t1_snapshot
    assert final_state["roadmap"][0]["reviewVerdicts"][0]["verdict"] == "accepted"
    assert final_state["roadmap"][1]["reviewVerdicts"][0]["verdict"] == "accepted"
    assert final_state["roadmap"][2]["learnedFacts"] == [
        "M1 evidence proved reviewers need fixture-backed next-milestone context."
    ]


def test_blocked_runtime_fixture_records_explicit_blocker_instead_of_accepting_or_relooping(
    tmp_path: Path,
) -> None:
    state_path = tmp_path / "multiloop" / "m7-blocked-runtime" / "state.json"
    cli = MultiloopCli(tmp_path, state_path)
    cli.run("init", "--name", "M7 Blocked Runtime", "--final-goal", "Validate blocked runtime handling.")
    state = read_state(state_path)
    state["tasks"] = [_task("T1", "M1", "Run unavailable runtime fixture")]
    write_state(state_path, state)

    state["tasks"][0]["status"] = "blocked"
    state["tasks"][0]["ownerAgentId"] = "developer-runtime"
    state["tasks"][0]["blockers"] = ["Fixture runtime is unavailable."]
    state["roadmap"][0]["blockers"] = ["Fixture runtime is unavailable."]
    state["blockers"] = [
        {
            "id": "B1",
            "scope": "task",
            "milestoneId": "M1",
            "taskId": "T1",
            "status": "active",
            "summary": "Fixture runtime is unavailable.",
            "detail": "",
            "createdBy": "developer-runtime",
            "createdAt": "2026-01-01T00:10:00Z",
            "resolvedAt": None,
        }
    ]
    write_state(state_path, state)
    cli.run(
        "milestone",
        "verdict",
        "add",
        "M1",
        "--id",
        "tester-runtime",
        "--role",
        "tester",
        "--verdict",
        "blocked",
        "--evidence",
        "Developer task T1 is blocked by an unavailable fixture runtime.",
        "--blocker",
        "Fixture runtime is unavailable.",
        "--final-goal-implication",
        "The final goal cannot be accepted without explicit runtime evidence.",
        "--next-recommendation",
        "Keep M1 blocked until the runtime is available or scope is revised.",
    )
    accept = cli.run_failure("milestone", "accept", "M1", "--id", "coordinator")
    detail = cli.run("milestone", "show", "M1", "--tasks").stdout
    status = cli.run("status").stdout
    state = read_state(state_path)

    assert "Cannot accept milestone M1; active blockers: B1" in accept.stderr
    assert "Blockers: 1 active" in status
    assert "Active structured blockers:" in detail
    assert "Fixture runtime is unavailable." in detail
    assert state["loop"]["status"] == "active"
    assert state["roadmap"][0]["status"] == "active"
    assert state["roadmap"][0]["reviewVerdicts"][0]["verdict"] == "blocked"
    assert state["blockers"] == [
        {
            "id": "B1",
            "scope": "task",
            "milestoneId": "M1",
            "taskId": "T1",
            "status": "active",
            "summary": "Fixture runtime is unavailable.",
            "detail": "",
            "createdBy": "developer-runtime",
            "createdAt": "2026-01-01T00:10:00Z",
            "resolvedAt": None,
        }
    ]
