"""Property + regression coverage for the claim-time lease (MC-1591).

Leases replaced the roster: assignment is a lease minted on the task record at
claim, not a seat in an `agents` map. Three invariants carry the whole model, and
one historical failure must stay unrepresentable:

  1. **Claim is atomic.** The runner's claim.queue lock serializes the mint, so
     concurrent claimers never double-assign a task — every ready task is claimed
     by exactly one worker, and no worker walks away with two.
  2. **A worker holds ≤1 *active* lease.** A claimer already holding an active
     lease is refused; a worker whose task is `done` holds none and may claim
     again (the D2 change that ended the retire/re-add churn).
  3. **Expiry releases exactly the `in_progress` leases.** The liveness sweep
     returns un-started work to the queue and leaves `review` / `needs_input`
     leases bound to their worker id.

Plus the 2026-07-14 starvation regression (the "specialists-as-a-pack" history
d2c4caca patched around) and the token-attribution risk a reusable worker id
introduces.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from helpers import SwarmCli, create_team, get_task, read_state, task, write_state
from sprintengine_core import store as folder_store
from sprintengine_core.tool.state import (
    active_lease_worker,
    mint_lease,
    release_expired_agent_targets,
    task_lease,
    worker_active_lease_tasks,
)


def _claim(cli: SwarmCli, worker_id: str) -> dict:
    return cli.run("task", "next", "--role", "developer", "--id", worker_id)


# --- 1. claim atomicity: the claim.queue lock serializes the mint ------------


def test_concurrent_claimers_never_double_assign_one_task(tmp_path: Path) -> None:
    fixture = create_team(tmp_path, "race-one-task", [task("T1", "Only one", "developer")])
    workers = [f"developer-{i}" for i in range(8)]

    with ThreadPoolExecutor(max_workers=len(workers)) as pool:
        results = list(pool.map(lambda w: _claim(fixture.cli, w), workers))

    winners = [r for r in results if r.get("claimed") is True]
    assert len(winners) == 1, [r.get("reason") for r in results]
    assert winners[0]["task"]["id"] == "T1"

    # The lease records a single owner, and it is one of the racers.
    record = get_task(read_state(fixture.state_path), "T1")
    assert record["status"] == "in_progress"
    assert record["ownerAgentId"] in workers
    assert record["lease"]["workerId"] == record["ownerAgentId"]


def test_concurrent_claimers_partition_the_ready_queue(tmp_path: Path) -> None:
    # More racers than tasks: every task is claimed exactly once, every winning
    # worker holds exactly one lease, and no task is owned twice.
    tasks = [task(f"T{i}", f"Task {i}", "developer") for i in range(5)]
    fixture = create_team(tmp_path, "race-many-tasks", tasks)
    workers = [f"developer-{i}" for i in range(12)]

    with ThreadPoolExecutor(max_workers=len(workers)) as pool:
        pool.map(lambda w: _claim(fixture.cli, w), workers)

    state = read_state(fixture.state_path)
    claimed = [t for t in state["tasks"] if t["status"] == "in_progress"]
    assert len(claimed) == 5  # all five ready tasks got claimed
    owners = [t["ownerAgentId"] for t in claimed]
    assert len(set(owners)) == 5  # each by a distinct worker — no double-claim
    for owner in set(owners):
        assert len(worker_active_lease_tasks(state, owner)) == 1  # ≤1 active lease


# --- 2. one active lease per worker; a done id may claim again (D2) ----------


def test_worker_holds_one_active_lease_then_may_claim_again_when_done(tmp_path: Path) -> None:
    fixture = create_team(
        tmp_path,
        "one-lease-per-worker",
        [task("T1", "First", "developer"), task("T2", "Second", "developer")],
    )
    state = read_state(fixture.state_path)
    state["defaultPhases"] = []  # publish -> done in one call, no review phase
    write_state(fixture.state_path, state)

    first = _claim(fixture.cli, "developer-1")
    assert first["claimed"] is True and first["task"]["id"] == "T1"

    # Holding an active lease, a second claim gets no new task — it resumes T1
    # rather than picking up T2, and T1 stays the worker's only active lease.
    blocked = _claim(fixture.cli, "developer-1")
    assert blocked["claimed"] is False
    assert blocked["reason"] in ("agent_already_has_active_task", "worker_task_capacity_reached")
    assert blocked["task"]["id"] == "T1"
    assert [t["id"] for t in worker_active_lease_tasks(read_state(fixture.state_path), "developer-1")] == ["T1"]

    fixture.cli.run("task", "publish", "--task-id", "T1", "--id", "developer-1", "--summary", "Shipped T1.")
    assert get_task(read_state(fixture.state_path), "T1")["status"] == "done"

    # T1 done -> no active lease -> the SAME id claims again (D2: no life cap).
    again = _claim(fixture.cli, "developer-1")
    assert again["claimed"] is True and again["task"]["id"] == "T2"


# --- 3. expiry releases exactly the in_progress leases -----------------------


def _leased(task_id: str, worker: str, status: str) -> dict:
    record = task(task_id, task_id, "developer", status=status, owner=worker)
    mint_lease(record, worker, "developer")
    task_lease(record)["heartbeatAt"] = "2000-01-01T00:00:00Z"  # stale past any timeout
    return record


@pytest.mark.parametrize("status,released", [("in_progress", True), ("review", False), ("needs_input", False)])
def test_expiry_releases_only_in_progress_leases(status: str, released: bool) -> None:
    state = {
        "sprintengine": {"agentTimeoutSeconds": 1},
        "tasks": [_leased("T1", "developer-1", status)],
        "events": [],
    }
    result = release_expired_agent_targets(state, actor="sprintengine")
    record = state["tasks"][0]

    if released:
        assert [r["taskId"] for r in result["released"]] == ["T1"]
        assert record["status"] == "todo"
        assert record["ownerAgentId"] is None
        assert task_lease(record) is None
    else:
        assert result["released"] == []
        assert record["status"] == status
        assert record["ownerAgentId"] == "developer-1"
        assert task_lease(record) is not None


def test_expiry_sweep_across_mixed_leases_frees_exactly_the_in_progress_one() -> None:
    # All three heartbeats are stale; the sweep must free precisely the one
    # in_progress lease and leave the review + needs_input leases bound.
    state = {
        "sprintengine": {"agentTimeoutSeconds": 1},
        "tasks": [
            _leased("T1", "developer-1", "in_progress"),
            _leased("T2", "developer-2", "review"),
            _leased("T3", "developer-3", "needs_input"),
        ],
        "events": [],
    }
    result = release_expired_agent_targets(state, actor="sprintengine")

    assert {r["taskId"] for r in result["released"]} == {"T1"}
    by_id = {t["id"]: t for t in state["tasks"]}
    assert by_id["T1"]["status"] == "todo" and by_id["T1"]["ownerAgentId"] is None
    assert by_id["T2"]["ownerAgentId"] == "developer-2" and by_id["T2"]["status"] == "review"
    assert by_id["T3"]["ownerAgentId"] == "developer-3" and by_id["T3"]["status"] == "needs_input"

    # The released lease re-dispatches on the append-only ledger, and a repeat
    # sweep is a no-op (T1 no longer carries an active lease).
    assert any(r["reason"] == "agent_expired_release" for r in state.get("_dispatchRecords", []))
    assert release_expired_agent_targets(state, actor="sprintengine") == {"released": [], "dirty": False}


# --- 4. the 2026-07-14 "specialists-as-a-pack" starvation is unrepresentable --


def test_a_spent_planner_id_never_starves_a_successor(tmp_path: Path) -> None:
    # The starvation d2c4caca patched: a retired planner still "owned" its done
    # task and, as a singleton seat, blocked a live successor from claiming open
    # same-role work — dispatch stalled. Under leases there is no seat and the
    # lease ends at `done`, so the successor claims freely and dispatch continues.
    done = task("T0", "Approved plan", "architect", status="done")
    done["lastImplementedByAgentId"] = "architect-1"
    open_work = task("T1", "Final sign-off", "architect")  # ready, same role
    fixture = create_team(tmp_path, "planner-starvation", [done, open_work])

    # The precondition of the old starvation — a spent id still holding an active
    # lease — cannot be represented: a done task carries no active lease.
    assert active_lease_worker(get_task(read_state(fixture.state_path), "T0")) is None

    # A live successor with a fresh id claims the open work: dispatch keeps flowing.
    successor = fixture.cli.run("task", "next", "--role", "architect", "--id", "architect-2")
    assert successor["claimed"] is True and successor["task"]["id"] == "T1"


def test_a_reused_planner_id_may_take_the_next_open_task(tmp_path: Path) -> None:
    # The same shape from the reuse angle: the spent planner id itself, holding no
    # active lease, is allowed back onto the next open task (D2) — the churn of
    # retiring and re-adding a planner seat is gone.
    done = task("T0", "Approved plan", "architect", status="done")
    done["lastImplementedByAgentId"] = "architect-1"
    fixture = create_team(tmp_path, "planner-reuse", [done, task("T1", "Follow-up plan", "architect")])

    reused = fixture.cli.run("task", "next", "--role", "architect", "--id", "architect-1")
    assert reused["claimed"] is True and reused["task"]["id"] == "T1"


# --- 5. token attribution survives a reusable worker id ----------------------


def test_reused_worker_id_is_flagged_multi_task_not_double_counted() -> None:
    # D2 lets one id own two tasks over time. The token report keys per-task usage
    # off the roster's ownedTaskIds and refuses to attribute when an owner owns
    # more than one (ownerOwnsMultipleTasks). The lease-derived view must therefore
    # carry BOTH tasks under the reused id, so the report degrades safely — a
    # reused id's tasks are marked unmeasurable, never conflated or silently dropped.
    finished = task("T1", "First", "developer", status="done")
    finished["lastImplementedByAgentId"] = "developer-1"
    finished["completedAt"] = "2026-07-08T01:00:00Z"
    current = task("T2", "Second", "developer", status="in_progress", owner="developer-1")
    mint_lease(current, "developer-1", "developer")

    workers = folder_store.derive_worker_views([finished, current], [])
    assert set(workers["developer-1"]["ownedTaskIds"]) == {"T1", "T2"}  # the multi-task signal
    # Per-task primary attribution still resolves to the right id on each task.
    assert finished["lastImplementedByAgentId"] == "developer-1"
    assert current["ownerAgentId"] == "developer-1"


def test_a_fresh_id_per_task_stays_measurable_and_distinct() -> None:
    # The mitigation in practice: the spawner mints a fresh id per task, so each
    # owner owns exactly one task and every task stays measurable and distinctly
    # attributed — no task is dropped for lack of an owner.
    t1 = task("T1", "First", "developer", status="done")
    t1["lastImplementedByAgentId"] = "developer-1"
    t1["completedAt"] = "2026-07-08T01:00:00Z"
    t2 = task("T2", "Second", "developer", status="in_progress", owner="developer-2")
    mint_lease(t2, "developer-2", "developer")

    workers = folder_store.derive_worker_views([t1, t2], [])
    assert workers["developer-1"]["ownedTaskIds"] == ["T1"]
    assert workers["developer-2"]["ownedTaskIds"] == ["T2"]


def test_lease_carries_session_id_across_a_same_worker_rebind_only() -> None:
    # Per-task session attribution (the recorded-sessionId mitigation): a re-mint
    # by the SAME worker (phase re-bind) preserves the lease's sessionId, so its
    # usage stays attributable across the phase walk; a different worker taking the
    # lease resets it, so one worker's session never bleeds into another's tally.
    record = task("T1", "Work", "developer", status="in_progress", owner="developer-1")
    mint_lease(record, "developer-1", "developer")
    task_lease(record)["sessionId"] = "sess-abc"

    mint_lease(record, "developer-1", "developer")  # same worker, phase re-bind
    assert task_lease(record)["sessionId"] == "sess-abc"

    mint_lease(record, "developer-2", "developer")  # a different worker takes over
    assert "sessionId" not in task_lease(record)


def test_a_lease_session_id_rides_the_projection_worker_view() -> None:
    # The finer attribution key: when the lease carries a sessionId it must reach
    # the derived worker view the token report consumes, so a reused id's work can
    # be disambiguated by the session that actually ran it.
    record = task("T1", "Session", "developer", status="in_progress", owner="developer-1")
    mint_lease(record, "developer-1", "developer")
    task_lease(record)["sessionId"] = "sess-A"

    worker = folder_store.derive_worker_views([record], [])["developer-1"]
    assert worker["sessionId"] == "sess-A"
    assert worker["currentTaskId"] == "T1"
