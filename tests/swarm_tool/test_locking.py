from __future__ import annotations

import json
import subprocess

from helpers import SWARM_COMMAND, create_team, get_task, read_state, task


def run_claim_process(state_path, task_id: str, agent_id: str) -> subprocess.Popen[str]:
    return subprocess.Popen(
        [
            str(SWARM_COMMAND),
            "--state",
            str(state_path),
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
