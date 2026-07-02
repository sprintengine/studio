"""Task-scoped worker lifecycle (MC-1444): the durable lastOwnedTaskId record.

The dispatch planner distinguishes "worker finished a task" from "worker never
had one" via agent.lastOwnedTaskId. Unlike currentTaskId it must survive
set_agent_idle, agent leave, and reconcile, and it must reach the renderer
through the projection roster.
"""
from __future__ import annotations

from sprintengine_core.store import normalize_agent_record
from sprintengine_core.tool.state import (
    ensure_agent,
    reconcile_agent,
    record_agent_leave,
    set_agent_active,
    set_agent_idle,
)


def _state_with_task(status: str) -> dict:
    return {
        "agents": {},
        "tasks": [{"id": "T1", "status": status, "ownerAgentId": "developer-1", "role": "developer"}],
    }


def test_last_owned_task_id_written_on_assignment_and_survives_idle() -> None:
    state = _state_with_task("in_progress")
    agent = ensure_agent(state, "developer-1", "developer")

    set_agent_active(agent, state["tasks"][0])
    assert agent["currentTaskId"] == "T1"
    assert agent["lastOwnedTaskId"] == "T1"

    state["tasks"][0]["status"] = "done"
    set_agent_idle(agent)
    assert agent["currentTaskId"] is None
    assert agent["lastOwnedTaskId"] == "T1"


def test_last_owned_task_id_survives_reconcile_and_leave() -> None:
    state = _state_with_task("in_progress")
    agent = ensure_agent(state, "developer-1", "developer")
    set_agent_active(agent, state["tasks"][0])

    # Task moved on (published); reconcile clears the stale live ref but must
    # keep the durable ownership record the planner reads.
    state["tasks"][0]["status"] = "review"
    state["tasks"][0]["ownerAgentId"] = None
    result = reconcile_agent(state, "developer-1", "developer")
    assert result["agent"]["currentTaskId"] is None
    assert result["agent"]["lastOwnedTaskId"] == "T1"

    left = record_agent_leave(state, "developer-1", "developer", reason="terminal disposed")
    assert left["status"] == "left"
    assert left["lastOwnedTaskId"] == "T1"


def test_last_owned_task_id_tracks_reassignment() -> None:
    state = _state_with_task("in_progress")
    agent = ensure_agent(state, "developer-1", "developer")
    set_agent_active(agent, state["tasks"][0])
    set_agent_idle(agent)

    next_task = {"id": "T2", "status": "in_progress", "ownerAgentId": "developer-1", "role": "developer"}
    state["tasks"].append(next_task)
    set_agent_active(agent, next_task)
    assert agent["lastOwnedTaskId"] == "T2"


def test_projection_agent_record_carries_last_owned_task_id() -> None:
    record = normalize_agent_record(
        "developer-1",
        {"role": "developer", "status": "idle", "lastOwnedTaskId": "T1"},
    )
    assert record["lastOwnedTaskId"] == "T1"

    bare = normalize_agent_record("developer-2", {"role": "developer", "status": "idle"})
    assert "lastOwnedTaskId" not in bare
