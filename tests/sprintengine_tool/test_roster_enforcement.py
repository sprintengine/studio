"""The run's role boundary is `configuredRoles`; assignment uniqueness is a lease.

MC-1591 deleted the seated roster (the `agents` map, `add_roster_agent`, the
singleton-seat cap, `ownedTaskIds`). Two enforcement questions survive, each with
a new authority:

  - *May this role be planned/claimed here?* — `ensure_role_in_roster` validates
    against `configuredRoles`, the run's enabled-role set written once at init. A
    run with **zero live workers** of an enabled role still admits its tasks (the
    lazy roster), and every guard no-ops when `configuredRoles` is absent or empty
    so legacy/headless runs are unconstrained.
  - *May this worker take another task?* — `worker_has_active_lease` refuses a
    worker that already holds an active lease, and permits one whose task is done.
    This replaced the singleton seat and the per-life `ownedTaskIds` cap: the cap
    is now ≤1 *active* lease, not ≤1 task for life.

These are pure in-process state builders (the same dict-state the folder store
materializes) plus a CLI init round-trip that pins where `configuredRoles` comes
from.
"""

from __future__ import annotations

import json

import pytest

from sprintengine_core.tool.state import (
    configured_role_set,
    ensure_role_in_roster,
    end_lease,
    mint_lease,
    worker_has_active_lease,
)

from helpers import task as make_task


def configured_state(configured):
    """A run with `configuredRoles` set to `configured` (None omits the key)."""
    state = {"sprintengine": {"rosterConfigured": True}, "events": []}
    if configured is not None:
        state["configuredRoles"] = configured
    return state


# --- configuredRoles: the role boundary --------------------------------------


def test_ensure_role_in_roster_rejects_off_roster_role() -> None:
    state = configured_state(["architect", "developer", "performance", "tester"])
    with pytest.raises(SystemExit) as exc:
        ensure_role_in_roster(state, "security")
    message = str(exc.value)
    assert "not enabled for this run" in message
    assert "ask the user to add it to the roster" in message


def test_ensure_role_in_roster_admits_an_enabled_role_with_zero_live_workers() -> None:
    # The lazy-roster change: membership is `configuredRoles`, not a seated worker.
    # A run whose only live worker is the architect still plans/claims `developer`
    # work — the old "enabled but unseated -> reject" gate is gone.
    state = configured_state(["architect", "developer"])
    ensure_role_in_roster(state, "developer")  # enabled -> no raise, even unseated


def test_ensure_role_in_roster_noop_when_configured_roles_absent() -> None:
    # Legacy/headless run: no configuredRoles key -> nothing enforced.
    state = configured_state(None)
    ensure_role_in_roster(state, "security")


def test_an_empty_enabled_set_is_a_roleless_run_that_admits_no_named_role() -> None:
    # MC-2057 inverted this. An explicit empty list is a ROLELESS run — a
    # deliberate choice of no roles — not an unenforced one. Collapsing it into
    # None (what it used to do) made a roleless run indistinguishable from a
    # legacy one and silently stopped rejecting a mistyped role.
    state = configured_state([])
    assert configured_role_set(state) == set()

    # Absent is legal: a roleless task/agent carries no role to validate.
    ensure_role_in_roster(state, None)
    ensure_role_in_roster(state, "")

    # Wrong is not: a named role is rejected because the run enables none.
    with pytest.raises(SystemExit) as error:
        ensure_role_in_roster(state, "security")
    assert "not enabled for this run" in str(error.value)


def test_absent_role_noops_on_a_role_based_run_too() -> None:
    # A roleless task in a role-based run means "any agent may take this"; it is
    # not a role, so there is nothing for the roster boundary to check.
    ensure_role_in_roster(configured_state(["architect", "developer"]), None)


# --- leases: the assignment-uniqueness cap that replaced the seat -------------


def leased(task_id: str, role: str, worker: str, status: str = "in_progress") -> dict:
    record = make_task(task_id, task_id, role, status=status, owner=worker)
    mint_lease(record, worker, role)
    return record


def test_worker_holding_an_active_lease_is_refused_a_second_claim() -> None:
    # Replaces the singleton seat / ownedTaskIds cap: the boundary is ≤1 ACTIVE
    # lease. A worker mid-task cannot claim T2.
    state = {"tasks": [leased("T1", "developer", "developer-1"), make_task("T2", "b", "developer")]}
    assert worker_has_active_lease(state, "developer-1", excluding_task_id="T2") is True


def test_worker_may_claim_again_once_its_task_is_done() -> None:
    # The deliberate D2 change: a worker id whose task is done holds no active
    # lease and may claim its next task — no more retire/re-add churn for a spent
    # architect id.
    done = make_task("T1", "a", "architect", status="done", owner="architect-1")
    end_lease(done)
    state = {"tasks": [done, make_task("T2", "plan-2", "architect")]}
    assert worker_has_active_lease(state, "architect-1") is False


def test_reclaiming_the_same_task_is_always_allowed() -> None:
    # A rework respawn re-claims its own task; excluding it makes the check pass.
    state = {"tasks": [leased("T1", "developer", "developer-1")]}
    assert worker_has_active_lease(state, "developer-1", excluding_task_id="T1") is False


def test_no_singleton_seat_survives_two_ids_of_a_role_each_hold_a_lease() -> None:
    # The old singleton architect seat is gone: leases cap per worker id, not per
    # role, so two architect ids can each own an active task at once.
    state = {"tasks": [leased("T1", "architect", "architect-1"), leased("T2", "architect", "architect-2")]}
    assert worker_has_active_lease(state, "architect-1") is True
    assert worker_has_active_lease(state, "architect-2") is True


# --- where configuredRoles comes from ----------------------------------------


def test_init_persists_configured_roles(tmp_path) -> None:
    # A real CLI init round-trip: --configured-roles-json lands in run.yaml as
    # `configuredRoles`, distinct from the roleRuntimes key set (which includes
    # CLI-default roles). `--agent` no longer seeds a roster (leases replaced it).
    from helpers import SwarmCli, read_state

    state_path = tmp_path / ".multi-code" / "sprintengine" / "init-configured-roles" / "run.yaml"
    cli = SwarmCli(state_path)
    cli.run(
        "init",
        "--name", "init-configured-roles",
        "--agent", "architect:architect-1",
        "--configured-roles-json", json.dumps(["developer", "security", "tester"]),
        "--role-runtimes-json", json.dumps({"developer": {"model": "claude-fable-5", "cli": "claude-code"}}),
    )
    state = read_state(state_path)
    assert state["configuredRoles"] == ["developer", "security", "tester"]
    assert state["configuredRoles"] != list(state.get("roleRuntimes", {}).keys())


def test_init_without_configured_roles_omits_key(tmp_path) -> None:
    # `--agent` marks the run roster-configured but never populates configuredRoles
    # (that is the separate --configured-roles-json contract), so the key stays
    # absent and the role boundary no-ops.
    from helpers import SwarmCli, read_state

    state_path = tmp_path / ".multi-code" / "sprintengine" / "init-no-configured-roles" / "run.yaml"
    cli = SwarmCli(state_path)
    cli.run("init", "--name", "init-no-configured-roles", "--agent", "developer:developer-1")
    state = read_state(state_path)
    assert "configuredRoles" not in state
    assert configured_role_set(state) is None
