"""The run's configuredRoles is an enforced roster boundary.

`configuredRoles` (written once at init from the roster's enabled roles) is the
enforced enabled-role set. When it is present and non-empty:
  - add_roster_agent refuses to seat a role that is not enabled, and refuses a
    second seat for a planning role (architect/general singleton), and
  - ensure_role_in_roster (plan.add_task's guard) refuses an off-roster task role.
Every guard no-ops when configuredRoles is absent or empty, so legacy/headless
runs seat and plan exactly as before. Enabled reviewer roles still seat and lazy-
register on first gate claim. These are pure in-process state builders — the
same dict-state shape the folder store materializes.
"""

from __future__ import annotations

import pytest

from sprintengine_core.tool.state import (
    add_roster_agent,
    ensure_role_in_roster,
    lazily_register_reviewer_id,
    planning_seat_taken,
)


def configured_state(configured, seated=None):
    """A configured run: rosterConfigured, optional seated agents, configuredRoles.

    `configured` is None to omit the key entirely (legacy run), or a list to set
    it (including [] for the explicit-empty case). `seated` maps agent id -> role.
    """
    agents = {agent_id: {"role": role, "status": "idle"} for agent_id, role in (seated or {}).items()}
    state = {"sprintengine": {"rosterConfigured": True}, "agents": agents, "events": []}
    if configured is not None:
        state["configuredRoles"] = configured
    return state


def test_add_roster_agent_rejects_off_roster_role() -> None:
    state = configured_state(["architect", "developer", "code_reviewer", "tester"])
    with pytest.raises(SystemExit) as exc:
        add_roster_agent(state, "security", "security", "architect")
    message = str(exc.value)
    assert "not enabled for this run" in message
    assert "ask the user to add it to the roster" in message
    assert "security" not in state["agents"]


def test_add_roster_agent_rejects_second_architect_seat() -> None:
    state = configured_state(["architect", "developer"], seated={"architect-1": "architect"})
    with pytest.raises(SystemExit) as exc:
        add_roster_agent(state, "architect", "architect-2", "architect")
    assert "singleton" in str(exc.value)
    assert "architect-2" not in state["agents"]


def test_add_roster_agent_rejects_second_general_seat() -> None:
    state = configured_state(["general", "developer"], seated={"general-1": "general"})
    with pytest.raises(SystemExit) as exc:
        add_roster_agent(state, "general", "general-2", "architect")
    assert "singleton" in str(exc.value)
    assert "general-2" not in state["agents"]


def test_add_roster_agent_allows_replacing_a_retired_planner() -> None:
    # A retired architect has vacated its planning seat, so a replacement seats.
    state = configured_state(["architect"], seated={"architect-1": "architect"})
    state["agents"]["architect-1"]["status"] = "retired"
    assert planning_seat_taken(state["agents"], "architect") is False
    agent = add_roster_agent(state, "architect", "architect-2", "architect")
    assert agent["role"] == "architect"
    assert state["agents"]["architect-2"]["role"] == "architect"


def test_add_roster_agent_reseat_of_same_id_is_idempotent() -> None:
    # Re-adding the exact seated planner id is a no-op, never a seat-cap rejection.
    state = configured_state(["architect"], seated={"architect-1": "architect"})
    agent = add_roster_agent(state, "architect", "architect-1", "architect")
    assert agent is state["agents"]["architect-1"]


def test_configured_reviewer_role_seats_and_lazy_registers() -> None:
    state = configured_state(
        ["architect", "developer", "code_reviewer", "tester"],
        seated={"architect-1": "architect"},
    )
    add_roster_agent(state, "code_reviewer", "code_reviewer", "architect")
    assert state["agents"]["code_reviewer"]["role"] == "code_reviewer"
    # An enabled reviewer role still registers its persistent id on first gate claim.
    assert lazily_register_reviewer_id(state, "tester", "tester") is True
    assert state["agents"]["tester"]["role"] == "tester"
    assert "ownedTaskIds" not in state["agents"]["tester"]


def test_lazy_register_rejects_off_roster_reviewer() -> None:
    # A reviewer role the run never enabled cannot slip in through gate claim.
    state = configured_state(["architect", "developer"], seated={"architect-1": "architect"})
    with pytest.raises(SystemExit) as exc:
        lazily_register_reviewer_id(state, "security", "security")
    assert "not enabled for this run" in str(exc.value)


def test_guards_noop_when_configured_roles_absent() -> None:
    # Legacy run: rosterConfigured but no configuredRoles key -> nothing enforced.
    state = configured_state(None, seated={"architect-1": "architect"})
    add_roster_agent(state, "security", "security-1", "architect")
    add_roster_agent(state, "architect", "architect-2", "architect")
    assert state["agents"]["security-1"]["role"] == "security"
    assert state["agents"]["architect-2"]["role"] == "architect"


def test_guards_noop_when_configured_roles_empty() -> None:
    # An explicit empty enabled set is treated as "unenforced" for the roster
    # boundary (distinct from gate derivation, where [] means no derived gates).
    state = configured_state([], seated={"architect-1": "architect"})
    add_roster_agent(state, "security", "security-1", "architect")
    add_roster_agent(state, "architect", "architect-2", "architect")
    assert "security-1" in state["agents"]
    assert "architect-2" in state["agents"]


def test_ensure_role_in_roster_rejects_off_roster_plan_role() -> None:
    state = configured_state(["architect", "developer"], seated={"architect-1": "architect"})
    with pytest.raises(SystemExit) as exc:
        ensure_role_in_roster(state, "security")
    assert "not enabled for this run" in str(exc.value)


def test_ensure_role_in_roster_allows_enabled_seated_role() -> None:
    state = configured_state(
        ["architect", "developer"],
        seated={"architect-1": "architect", "developer-1": "developer"},
    )
    ensure_role_in_roster(state, "developer")  # enabled and seated -> no raise


def test_ensure_role_in_roster_noop_without_configured_roles() -> None:
    # No configuredRoles and no seated roster constraint -> unconfigured, no raise.
    state = {"sprintengine": {}, "agents": {}, "events": []}
    ensure_role_in_roster(state, "security")
