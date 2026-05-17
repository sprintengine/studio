from __future__ import annotations

import json
import subprocess

from helpers import create_team, get_task, read_state, swarm_command, task


def run_claim_process(state_path, task_id: str, agent_id: str) -> subprocess.Popen[str]:
    return subprocess.Popen(
        [
            *swarm_command(state_path, ()),
            "task",
            "claim",
            "--task-id",
            task_id,
            "--id",
            agent_id,
        ],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def run_gate_next_process(state_path, role: str, agent_id: str) -> subprocess.Popen[str]:
    return subprocess.Popen(
        [
            *swarm_command(state_path, ()),
            "task",
            "gate",
            "next",
            "--role",
            role,
            "--id",
            agent_id,
        ],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def review_task_with_gates() -> dict:
    record = task("T1", "Implementation awaiting review", "developer", "review", owner="developer-fixture")
    record["qualityGates"] = [
        {
            "id": "code-review",
            "phase": "review",
            "role": "code_reviewer",
            "status": "pending",
            "required": True,
            "allowSelfReview": False,
            "focus": "Code quality",
            "attempts": [],
        },
        {
            "id": "spec-review",
            "phase": "review",
            "role": "spec_reviewer",
            "status": "pending",
            "required": True,
            "allowSelfReview": False,
            "focus": "Spec conformance",
            "attempts": [],
        },
    ]
    return record


def test_concurrent_claims_for_same_task_are_serialized_by_state_lock(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "concurrent-claim-lock",
        [task("T1", "Single implementation", "developer")],
    )

    processes = [
        run_claim_process(fixture.state_path, "T1", "developer-a"),
        run_claim_process(fixture.state_path, "T1", "developer-b"),
    ]
    completed = [process.communicate(timeout=10) for process in processes]
    return_codes = [process.returncode for process in processes]
    assert return_codes == [0, 0]

    payloads = [json.loads(stdout) for stdout, _stderr in completed]
    successes = [payload for payload in payloads if payload["ok"] is True]
    failures = [payload for payload in payloads if payload["ok"] is False]
    assert len(successes) == 1
    assert len(failures) == 1
    assert failures[0]["error"] == "Task is not ready."

    state = read_state(fixture.state_path)
    claimed_task = get_task(state, "T1")
    assert claimed_task["status"] == "in_progress"
    assert claimed_task["ownerAgentId"] in {"developer-a", "developer-b"}
    assert sum(event["type"] == "task_claimed" for event in state["events"]) == 1
    assert fixture.state_path.with_suffix(".yaml.lock").exists() is False


def test_concurrent_gate_next_claims_same_gate_once(tmp_path) -> None:
    fixture = create_team(tmp_path, "concurrent-gate-claim", [review_task_with_gates()])

    processes = [
        run_gate_next_process(fixture.state_path, "code_reviewer", "code-reviewer-a"),
        run_gate_next_process(fixture.state_path, "code_reviewer", "code-reviewer-b"),
    ]
    completed = [process.communicate(timeout=10) for process in processes]
    assert [process.returncode for process in processes] == [0, 0]

    payloads = [json.loads(stdout) for stdout, _stderr in completed]
    claimed = [payload for payload in payloads if payload["claimed"]]
    not_claimed = [payload for payload in payloads if not payload["claimed"]]
    assert len(claimed) == 1
    assert claimed[0]["gate"]["id"] == "code-review"
    assert claimed[0]["attempt"]["status"] == "in_progress"
    assert len(not_claimed) == 1
    assert not_claimed[0]["reason"] == "no_ready_gate"

    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    code_gate = next(gate for gate in task_record["qualityGates"] if gate["id"] == "code-review")
    assert task_record["status"] == "review"
    assert code_gate["status"] == "in_progress"
    assert len(code_gate["attempts"]) == 1
    assert code_gate["attempts"][0]["claimedBy"] in {"code-reviewer-a", "code-reviewer-b"}
    assert (fixture.team_dir / "tasks" / "review" / "0001-T1.json").is_file()
    assert (fixture.team_dir / "runner" / "gate.queue.lock").exists() is False


def test_different_gates_on_same_task_can_be_claimed_in_parallel(tmp_path) -> None:
    fixture = create_team(tmp_path, "parallel-distinct-gates", [review_task_with_gates()])

    processes = [
        run_gate_next_process(fixture.state_path, "code_reviewer", "code-reviewer"),
        run_gate_next_process(fixture.state_path, "spec_reviewer", "spec-reviewer"),
    ]
    completed = [process.communicate(timeout=10) for process in processes]
    assert [process.returncode for process in processes] == [0, 0]

    payloads = [json.loads(stdout) for stdout, _stderr in completed]
    assert all(payload["claimed"] for payload in payloads)
    assert {payload["gate"]["id"] for payload in payloads} == {"code-review", "spec-review"}

    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert task_record["status"] == "review"
    assert {gate["status"] for gate in task_record["qualityGates"]} == {"in_progress"}


def test_gate_next_resumes_existing_active_gate_for_agent(tmp_path) -> None:
    fixture = create_team(tmp_path, "resume-active-gate", [review_task_with_gates()])

    first = fixture.cli.run("task", "gate", "next", "--role", "code_reviewer", "--id", "code-reviewer")
    second = fixture.cli.run("task", "gate", "next", "--role", "code_reviewer", "--id", "code-reviewer")

    assert first["claimed"] is True
    assert first["resumed"] is False
    assert second["claimed"] is True
    assert second["resumed"] is True
    assert second["gate"]["id"] == "code-review"
    assert second["attempt"]["id"] == first["attempt"]["id"]


def test_changes_requested_task_next_stays_distinct_and_claimable_with_gate_commands(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "changes-requested-still-claimable",
        [
            task("T1", "Done dependency", "developer", "done"),
            task("T2", "Needs implementation rework", "developer", "changes_requested", depends_on=["T1"]),
        ],
    )

    no_gate = fixture.cli.run("task", "gate", "next", "--role", "code_reviewer", "--id", "code-reviewer")
    claimed = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-fixture")

    assert no_gate["claimed"] is False
    assert no_gate["reason"] == "no_ready_gate"
    assert claimed["claimed"] is True
    assert claimed["task"]["id"] == "T2"
    assert claimed["task"]["status"] == "in_progress"
