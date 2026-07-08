"""Task-scoped worker lifecycle (MC-1444): the durable lastOwnedTaskId record.

The dispatch planner distinguishes "worker finished a task" from "worker never
had one" via agent.lastOwnedTaskId. Unlike currentTaskId it must survive
set_agent_idle, agent leave, and reconcile, and it must reach the renderer
through the projection roster.

Under single-owner tasks (MC-1542) a roster id is spent the moment it owns a
task and is never recycled: it holds that task from claim through `review` to
`done`, and only a fresh id takes the next one. The only release that returns a
task to the queue is an `in_progress` release; `review` and `needs_input` stay
owned.
"""
from __future__ import annotations

from fixtures import create_team, read_state, task
from sprintengine_core.store import normalize_agent_record, normalize_roster_policy, worker_assignment_policy
from sprintengine_core.tool.state import (
    agent_owned_task_ids,
    append_owned_task_id,
    ensure_agent,
    next_replacement_agent_id,
    reconcile_agent,
    release_agent_targets,
    release_expired_agent_targets,
    set_agent_active,
    set_agent_idle,
    task_claim_exceeds_worker_capacity,
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


def test_reconcile_keeps_the_owner_bound_through_the_review_phase() -> None:
    # Publish leaves the task in `review` still owned (MC-1542 decision 1), so
    # reconcile re-adopts it as the agent's active task rather than clearing the
    # ref: `review` is an ACTIVE status, not spare capacity.
    state = _state_with_task("in_progress")
    agent = ensure_agent(state, "developer-1", "developer")
    set_agent_active(agent, state["tasks"][0])

    state["tasks"][0]["status"] = "review"
    result = reconcile_agent(state, "developer-1", "developer")
    assert result["activeTask"]["id"] == "T1"
    assert result["agent"]["currentTaskId"] == "T1"
    assert result["agent"]["lastOwnedTaskId"] == "T1"


def test_last_owned_task_id_survives_reconcile_and_leave() -> None:
    state = _state_with_task("in_progress")
    agent = ensure_agent(state, "developer-1", "developer")
    set_agent_active(agent, state["tasks"][0])

    # Task completed; reconcile clears the stale live ref but must keep the
    # durable ownership record the planner reads.
    state["tasks"][0]["status"] = "done"
    state["tasks"][0]["ownerAgentId"] = None
    result = reconcile_agent(state, "developer-1", "developer")
    assert result["agent"]["currentTaskId"] is None
    assert result["agent"]["lastOwnedTaskId"] == "T1"

    # Leaving resets the agent to idle (no stored terminal status) but keeps the
    # durable ownership record so the id stays task-capped.
    release_agent_targets(state, "developer-1", reason="terminal disposed", actor="developer-1")
    departed = state["agents"]["developer-1"]
    assert departed["status"] == "idle"
    assert departed["lastOwnedTaskId"] == "T1"


def test_last_owned_task_id_tracks_reassignment() -> None:
    state = _state_with_task("in_progress")
    agent = ensure_agent(state, "developer-1", "developer")
    set_agent_active(agent, state["tasks"][0])
    set_agent_idle(agent)

    next_task = {"id": "T2", "status": "in_progress", "ownerAgentId": "developer-1", "role": "developer"}
    state["tasks"].append(next_task)
    set_agent_active(agent, next_task)
    assert agent["lastOwnedTaskId"] == "T2"


def test_release_agent_targets_frees_an_in_progress_task_and_resets_agent_idle() -> None:
    # The single release authority. Only un-started implementation work returns to
    # the queue; the agent is reset to idle-no-target with no stored terminal status.
    state = _state_with_task("in_progress")
    agent = ensure_agent(state, "developer-1", "developer")
    set_agent_active(agent, state["tasks"][0])

    released = release_agent_targets(state, "developer-1", reason="terminal closed", actor="developer-1")
    assert released == [
        {"kind": "task", "taskId": "T1", "previousOwnerAgentId": "developer-1", "fromStatus": "in_progress", "status": "todo"}
    ]
    assert state["tasks"][0]["status"] == "todo"
    assert state["tasks"][0]["ownerAgentId"] is None
    departed = state["agents"]["developer-1"]
    assert departed["status"] == "idle"
    assert departed["currentTaskId"] is None
    # The id stays spent even though the task went back to the queue.
    assert departed["lastOwnedTaskId"] == "T1"


def test_release_agent_targets_preserves_review_ownership() -> None:
    # A published task's diff is already on the record and its walk half done;
    # releasing it to `todo` would hand a stranger work that is already finished.
    # The owner is revived under the same id with a phase brief instead.
    state = _state_with_task("review")
    agent = ensure_agent(state, "developer-1", "developer")
    set_agent_active(agent, state["tasks"][0])

    assert release_agent_targets(state, "developer-1", reason="terminal closed", actor="developer-1") == []
    assert state["tasks"][0]["ownerAgentId"] == "developer-1"
    assert state["tasks"][0]["status"] == "review"
    assert state["agents"]["developer-1"]["status"] == "idle"


def test_release_agent_targets_preserves_needs_input_ownership() -> None:
    # The single release authority never frees a needs_input task: the owner and
    # the question survive so input resolution routes back to the owner.
    state = _state_with_task("needs_input")
    state["tasks"][0]["needsInput"] = {"kind": "user", "question": "Which provider?"}
    agent = ensure_agent(state, "developer-1", "developer")
    set_agent_active(agent, state["tasks"][0])

    released = release_agent_targets(state, "developer-1", reason="terminal closed", actor="developer-1")
    assert released == []
    assert state["tasks"][0]["ownerAgentId"] == "developer-1"
    assert state["tasks"][0]["status"] == "needs_input"
    assert state["tasks"][0]["needsInput"]["question"] == "Which provider?"
    assert state["agents"]["developer-1"]["status"] == "idle"


def test_release_expired_agent_targets_frees_task_and_is_idempotent() -> None:
    state = _state_with_task("in_progress")
    state["sprintengine"] = {"agentTimeoutSeconds": 1}
    state["events"] = []
    agent = ensure_agent(state, "developer-1", "developer")
    set_agent_active(agent, state["tasks"][0])
    agent["heartbeatAt"] = "2000-01-01T00:00:00Z"

    result = release_expired_agent_targets(state, actor="sprintengine")
    assert result["dirty"] is True
    assert result["released"] == [
        {"agentId": "developer-1", "role": "developer", "targetKind": "task", "taskId": "T1", "fromStatus": "in_progress", "status": "todo"}
    ]
    assert state["tasks"][0]["status"] == "todo"
    assert state["tasks"][0]["ownerAgentId"] is None
    assert state["agents"]["developer-1"]["status"] == "idle"

    # Idle-no-target after release: a second sweep is a no-op.
    assert release_expired_agent_targets(state, actor="sprintengine") == {"released": [], "dirty": False}


def test_projection_agent_record_carries_last_owned_task_id() -> None:
    record = normalize_agent_record(
        "developer-1",
        {"role": "developer", "status": "idle", "lastOwnedTaskId": "T1"},
    )
    assert record["lastOwnedTaskId"] == "T1"

    bare = normalize_agent_record("developer-2", {"role": "developer", "status": "idle"})
    assert "lastOwnedTaskId" not in bare


# ---------------------------------------------------------------------------
# Task-scoped roster ids (no slot recycling): ownedTaskIds, per_task claim
# guard, and the assignment op.
# ---------------------------------------------------------------------------


def test_owned_task_ids_appended_once_and_survives_idle() -> None:
    agent = ensure_agent({"agents": {}}, "developer-1", "developer")
    assert append_owned_task_id(agent, "T1") is True
    assert append_owned_task_id(agent, "T1") is False  # rework respawn: no growth
    assert append_owned_task_id(agent, "") is False
    assert agent["ownedTaskIds"] == ["T1"]
    set_agent_idle(agent)
    assert agent["ownedTaskIds"] == ["T1"]


def test_set_agent_active_records_owned_task_ids() -> None:
    state = {"agents": {}, "tasks": [{"id": "T1", "status": "in_progress", "role": "developer"}]}
    agent = ensure_agent(state, "developer-1", "developer")
    set_agent_active(agent, state["tasks"][0])
    assert agent["ownedTaskIds"] == ["T1"]
    assert agent_owned_task_ids(agent) == {"T1"}


def test_roster_policy_defaults_absent_to_per_task() -> None:
    assert normalize_roster_policy(None) == {"workerAssignment": "per_task"}
    assert normalize_roster_policy({"workerAssignment": "bogus"}) == {"workerAssignment": "per_task"}
    assert worker_assignment_policy({}) == "per_task"
    assert worker_assignment_policy({"rosterPolicy": {"workerAssignment": "per_task"}}) == "per_task"


def test_per_task_claim_guard_allows_rework_refuses_second_distinct_task() -> None:
    per_task = {"rosterPolicy": {"workerAssignment": "per_task"}}
    owner = {"role": "developer", "ownedTaskIds": ["T1"]}
    assert task_claim_exceeds_worker_capacity(per_task, owner, "T1") is False  # rework own task
    assert task_claim_exceeds_worker_capacity(per_task, owner, "T2") is True   # second distinct task
    fresh = {"role": "developer"}
    assert task_claim_exceeds_worker_capacity(per_task, fresh, "T1") is False  # fresh id may take one
    # A roster entry written before ownedTaskIds existed still reports via
    # lastOwnedTaskId, so the guard holds mid-run upgrade.
    legacy = {"role": "developer", "lastOwnedTaskId": "T9"}
    assert task_claim_exceeds_worker_capacity(per_task, legacy, "T9") is False
    assert task_claim_exceeds_worker_capacity(per_task, legacy, "T8") is True
    # Absent policy defaults to per_task.
    assert task_claim_exceeds_worker_capacity({}, owner, "T2") is True


def test_allocator_first_worker_is_index_one() -> None:
    # D-Naming: with no id for the role yet (lazy roster seeds only the
    # architect), the first minted worker is `<role>-1`, matching the renderer
    # allocator. An unrelated role's id does not shift the index.
    assert next_replacement_agent_id({"agents": {}}, "developer") == "developer-1"
    assert next_replacement_agent_id({"agents": {"architect": {"role": "architect"}}}, "developer") == "developer-1"


def test_allocator_counts_legacy_bare_id() -> None:
    # A bare `<role>` id is index 1; the monotonic allocator never reuses it.
    assert next_replacement_agent_id({"agents": {"developer": {"role": "developer"}}}, "developer") == "developer-2"
    assert next_replacement_agent_id(
        {"agents": {"developer": {"role": "developer"}, "developer-2": {"role": "developer"}}},
        "developer",
    ) == "developer-3"


def _seed_roster(fixture, agents: dict) -> None:
    """Configure the roster and pin `defaultPhases: []` so publish lands on done.

    These tests are about roster capacity, not the phase walk, so the runs opt out
    of review the same way a cheap-and-fast run does.
    """
    state = read_state(fixture.state_path)
    state["sprintengine"]["rosterConfigured"] = True
    state["defaultPhases"] = []
    state["agents"] = agents
    from fixtures import write_state

    write_state(fixture.state_path, state)


def test_assignment_op_mints_fresh_id_per_serial_task_no_recycling(tmp_path) -> None:
    # Three serial developer tasks and a prior spent id seeded with a legacy
    # 'left' status: it normalizes to idle on load, capacity keys off task
    # ownership (owned T0) not status, so each task gets a fresh task-scoped id,
    # none owns two tasks, and the spent id is never reused.
    fixture = create_team(
        tmp_path,
        "assignment-serial",
        [
            task("T0", "Prior work", "developer", "done"),
            task("T1", "First", "developer"),
            task("T2", "Second", "developer", depends_on=["T1"]),
            task("T3", "Third", "developer", depends_on=["T2"]),
        ],
    )
    _seed_roster(
        fixture,
        {"developer-1": {"role": "developer", "status": "left", "currentTaskId": None, "lastOwnedTaskId": "T0", "ownedTaskIds": ["T0"]}},
    )

    minted = []
    for task_id in ("T1", "T2", "T3"):
        replenished = fixture.cli.run("roster", "replenish", "--actor", "runner", "--queue-depth", "--max-new", "3")
        assert [a["taskId"] for a in replenished["assignments"]] == [task_id]
        agent_id = replenished["assignments"][0]["agentId"]
        minted.append(agent_id)
        claimed = fixture.cli.run("task", "next", "--role", "developer", "--id", agent_id)
        assert claimed["claimed"] is True
        assert claimed["task"]["id"] == task_id
        published = fixture.cli.run("task", "publish", "--task-id", task_id, "--id", agent_id, "--summary", "Shipped.")
        assert published["nextStatus"] == "done"

    assert len(set(minted)) == 3
    state = read_state(fixture.state_path)
    for task_id, agent_id in zip(("T1", "T2", "T3"), minted):
        agent = state["agents"][agent_id]
        assert agent["ownedTaskIds"] == [task_id]
        assert agent["lastOwnedTaskId"] == task_id
    # The prior left id was never recycled onto a new task.
    assert state["agents"]["developer-1"]["ownedTaskIds"] == ["T0"]


def test_assignment_op_returns_one_assignment_per_parallel_task_bounded_by_budget(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "assignment-parallel",
        [task("P1", "One", "developer"), task("P2", "Two", "developer")],
    )
    _seed_roster(fixture, {})

    # Zero budget mints nothing.
    zero = fixture.cli.run("roster", "replenish", "--actor", "runner", "--queue-depth", "--max-new", "0")
    assert zero["assignments"] == []
    assert zero["action"] == "none"

    both = fixture.cli.run("roster", "replenish", "--actor", "runner", "--queue-depth", "--max-new", "5")
    assert {a["taskId"] for a in both["assignments"]} == {"P1", "P2"}
    assert all(a["role"] == "developer" for a in both["assignments"])
    assert len({a["agentId"] for a in both["assignments"]}) == 2


def test_assignment_op_mints_only_for_ready_tasks_not_for_in_flight_review(tmp_path) -> None:
    # A task in `review` is owned and mid-walk: it is neither ready work nor spare
    # capacity, so it mints nothing. Its owner is spent and cannot absorb the ready
    # task either — only a fresh id can. An idle id of another role is not developer
    # capacity.
    fixture = create_team(
        tmp_path,
        "assignment-review-in-flight",
        [
            task("T1", "In review", "developer", "review", owner="developer-1"),
            task("T2", "Ready dev work", "developer"),
        ],
    )
    _seed_roster(
        fixture,
        {
            "developer-1": {"role": "developer", "status": "running", "currentTaskId": "T1", "lastOwnedTaskId": "T1", "ownedTaskIds": ["T1"]},
            "tester-1": {"role": "tester", "status": "idle", "currentTaskId": None},
        },
    )

    replenished = fixture.cli.run("roster", "replenish", "--actor", "runner", "--queue-depth", "--max-new", "5")

    assert [a["taskId"] for a in replenished["assignments"]] == ["T2"]
    assert all(a["role"] == "developer" for a in replenished["assignments"])
    state = read_state(fixture.state_path)
    # The review owner is spent: it may re-enter T1 but never claim T2.
    assert task_claim_exceeds_worker_capacity(state, state["agents"]["developer-1"], "T1") is False
    assert task_claim_exceeds_worker_capacity(state, state["agents"]["developer-1"], "T2") is True
