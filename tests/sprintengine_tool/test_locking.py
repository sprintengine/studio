"""Concurrency: two processes racing for the same unit of work (MC-1542).

Under single-owner tasks there are exactly two contested transitions, and both
are serialized by the run lock (plus the claim-queue folder lock for claims):

- `task claim` — the ready queue hands a task to exactly one agent;
- `task advance` — the phase walk is strictly forward, so a duplicated advance
  (a resumed session replaying its last tool call) must lose on `phase_mismatch`
  rather than skip a phase or double-complete.

The gate queue is gone with quality gates: `runner/gate.queue.lock` must never
reappear.
"""
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


def run_advance_process(state_path, task_id: str, agent_id: str) -> subprocess.Popen[str]:
    return subprocess.Popen(
        [
            *swarm_command(state_path, ()),
            "task",
            "advance",
            "--task-id",
            task_id,
            "--id",
            agent_id,
            "--phase",
            "review",
            "--outcome",
            "pass",
            "--summary",
            "Reviewed my own diff.",
        ],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def review_task() -> dict:
    """A published task, owned by its implementer, sitting in the review phase."""
    record = task("T1", "Implementation awaiting its own review", "developer", "review", owner="developer-fixture")
    record["startedAt"] = "2026-07-08T00:00:00Z"
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


def test_concurrent_advance_completes_the_phase_exactly_once(tmp_path) -> None:
    # A resumed owner replaying `task advance` must not walk the task twice. The
    # run lock serializes the pair; the loser reads the already-advanced status
    # and fails the phase guard instead of stepping past `done`.
    fixture = create_team(tmp_path, "concurrent-advance-lock", [review_task()])

    processes = [
        run_advance_process(fixture.state_path, "T1", "developer-fixture"),
        run_advance_process(fixture.state_path, "T1", "developer-fixture"),
    ]
    completed = [process.communicate(timeout=10) for process in processes]
    return_codes = sorted(process.returncode for process in processes)
    assert return_codes == [0, 1]

    winner = next(stdout for (stdout, _stderr), process in zip(completed, processes) if process.returncode == 0)
    loser_stderr = next(stderr for (_stdout, stderr), process in zip(completed, processes) if process.returncode != 0)
    assert json.loads(winner)["nextStatus"] == "done"
    assert "phase_mismatch" in loser_stderr

    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert task_record["status"] == "done"
    assert task_record["ownerAgentId"] is None
    assert sum(event["type"] == "task_phase_advanced" for event in state["events"]) == 1
    # One `implementation_summary` from the winning advance; the loser wrote none.
    assert len(task_record["comments"]) == 1
    assert fixture.state_path.with_suffix(".yaml.lock").exists() is False


def test_concurrent_advance_by_a_non_owner_never_lands(tmp_path) -> None:
    # `advance` is owner-only, so a second agent racing the owner cannot complete
    # the task even if it wins the lock.
    fixture = create_team(tmp_path, "concurrent-advance-not-owner", [review_task()])

    processes = [
        run_advance_process(fixture.state_path, "T1", "developer-other"),
        run_advance_process(fixture.state_path, "T1", "developer-other"),
    ]
    completed = [process.communicate(timeout=10) for process in processes]
    assert [process.returncode for process in processes] == [1, 1]
    assert all("not_task_owner" in stderr for _stdout, stderr in completed)

    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert task_record["status"] == "review"
    assert task_record["ownerAgentId"] == "developer-fixture"


def test_review_tasks_materialize_without_a_gate_queue_lock(tmp_path) -> None:
    fixture = create_team(tmp_path, "no-gate-queue-lock", [review_task()])

    fixture.cli.run("task", "refresh-ready")

    assert (fixture.team_dir / "tasks" / "review" / "0001-T1.json").is_file()
    assert (fixture.team_dir / "runner" / "gate.queue.lock").exists() is False
    assert not (fixture.team_dir / "tasks" / "changes_requested").exists()
