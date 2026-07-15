"""Lease-derived worker views (MC-1591): "who is doing what", with no agents map.

The dispatch planner and the projection distinguish "worker is running a task",
"worker finished one", and "worker never had one" from the task LEASES alone —
the persistent `agents` map is gone. `store.derive_worker_views` reconstructs each
worker's role/status/currentTaskId/lastOwnedTaskId/ownedTaskIds from the task
records: an ACTIVE lease (in_progress/review/needs_input) makes the holder the
current worker, and a task's `lastImplementedByAgentId` keeps its implementer a
recent worker after the lease ends at `done`.

Release stays keyed on the lease: only an `in_progress` lease returns to the queue;
`review` and `needs_input` leases stay bound to their worker id.
"""
from __future__ import annotations

from fixtures import task
from sprintengine_core.store import derive_worker_views
from sprintengine_core.tool.state import (
    mint_lease,
    release_agent_targets,
    release_expired_agent_targets,
    task_lease,
)


def owned(task_id: str, status: str, worker: str, role: str = "developer", **fields) -> dict:
    """A task record with an active lease for `worker` (mirrors assign_task)."""
    record = task(task_id, task_id, role, status=status, owner=worker)
    record.update(fields)
    if status in ("in_progress", "review", "needs_input"):
        mint_lease(record, worker, role)
    return record


def views(*tasks) -> dict:
    return derive_worker_views(list(tasks), [])


# --- lastOwnedTaskId / currentTaskId derivation ------------------------------


def test_current_and_last_owned_task_id_derived_from_an_active_lease() -> None:
    worker = views(owned("T1", "in_progress", "developer-1"))["developer-1"]
    assert worker["currentTaskId"] == "T1"
    assert worker["lastOwnedTaskId"] == "T1"
    assert worker["ownedTaskIds"] == ["T1"]
    assert worker["status"] == "running"


def test_last_owned_task_id_survives_the_task_completing() -> None:
    # After `done` the lease is gone, so currentTaskId clears — but the implementer
    # stamp keeps developer-1 a recent worker whose lastOwnedTaskId still points at
    # T1 (unlike currentTaskId, this durable record is what the planner reads).
    done = task("T1", "T1", "developer", status="done", owner=None)
    done["lastImplementedByAgentId"] = "developer-1"
    done["completedAt"] = "2026-07-08T01:00:00Z"
    worker = views(done)["developer-1"]
    assert worker["currentTaskId"] is None
    assert worker["lastOwnedTaskId"] == "T1"
    assert worker["status"] == "idle"


def test_last_owned_task_id_tracks_the_most_recently_touched_task() -> None:
    first = task("T1", "T1", "developer", status="done", owner=None)
    first["lastImplementedByAgentId"] = "developer-1"
    first["completedAt"] = "2026-07-08T00:00:00Z"
    second = task("T2", "T2", "developer", status="done", owner=None)
    second["lastImplementedByAgentId"] = "developer-1"
    second["completedAt"] = "2026-07-08T02:00:00Z"
    worker = views(first, second)["developer-1"]
    assert worker["lastOwnedTaskId"] == "T2"
    assert set(worker["ownedTaskIds"]) == {"T1", "T2"}


def test_review_and_needs_input_leases_keep_the_worker_current() -> None:
    review = views(owned("T1", "review", "developer-1"))["developer-1"]
    assert review["currentTaskId"] == "T1" and review["status"] == "running"

    blocked = views(owned("T2", "needs_input", "developer-2"))["developer-2"]
    assert blocked["currentTaskId"] == "T2" and blocked["status"] == "needs_input"


def test_a_done_plan_gate_with_no_implementer_yields_no_worker() -> None:
    # The lazy roster: a done task carrying neither a lease nor an implementer stamp
    # is not attributed to anyone — its role simply stays in configuredRoles.
    orphan = task("T0", "Plan", "architect", status="done", owner=None)
    assert derive_worker_views([orphan], []) == {}


# --- release stays keyed on the lease ----------------------------------------


def _state(*tasks) -> dict:
    return {"sprintengine": {}, "tasks": list(tasks), "events": []}


def test_release_frees_an_in_progress_lease_to_the_queue() -> None:
    state = _state(owned("T1", "in_progress", "developer-1"))
    released = release_agent_targets(state, "developer-1", reason="terminal closed", actor="developer-1")
    assert released == [
        {"kind": "task", "taskId": "T1", "previousOwnerAgentId": "developer-1", "fromStatus": "in_progress", "status": "todo"}
    ]
    freed = state["tasks"][0]
    assert freed["status"] == "todo"
    assert freed["ownerAgentId"] is None
    assert task_lease(freed) is None
    # The worker no longer appears in the derived view — nothing is active.
    assert derive_worker_views(state["tasks"], []) == {}


def test_release_preserves_review_and_needs_input_leases() -> None:
    review = _state(owned("T1", "review", "developer-1"))
    assert release_agent_targets(review, "developer-1", reason="terminal closed", actor="developer-1") == []
    assert review["tasks"][0]["ownerAgentId"] == "developer-1"
    assert review["tasks"][0]["status"] == "review"

    blocked = _state(owned("T2", "needs_input", "developer-2", needsInput={"kind": "user", "question": "Which provider?"}))
    assert release_agent_targets(blocked, "developer-2", reason="terminal closed", actor="developer-2") == []
    assert blocked["tasks"][0]["ownerAgentId"] == "developer-2"
    assert blocked["tasks"][0]["needsInput"]["question"] == "Which provider?"


def test_expiry_sweep_frees_a_stale_in_progress_lease_and_is_idempotent() -> None:
    state = _state(owned("T1", "in_progress", "developer-1"))
    state["sprintengine"] = {"agentTimeoutSeconds": 1}
    # Age the lease heartbeat far past the timeout.
    task_lease(state["tasks"][0])["heartbeatAt"] = "2000-01-01T00:00:00Z"

    result = release_expired_agent_targets(state, actor="sprintengine")
    assert result["dirty"] is True
    assert result["released"] == [
        {"agentId": "developer-1", "role": "developer", "targetKind": "task", "taskId": "T1", "fromStatus": "in_progress", "status": "todo"}
    ]
    assert state["tasks"][0]["status"] == "todo"
    assert state["tasks"][0]["ownerAgentId"] is None

    # Released to the queue, the lease is gone, so a second sweep is a no-op.
    assert release_expired_agent_targets(state, actor="sprintengine") == {"released": [], "dirty": False}
