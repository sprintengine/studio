"""The run's configuredRoles is an enforced roster boundary.

`configuredRoles` (written once at init from the roster's enabled roles) is the
enforced enabled-role set. When it is present and non-empty:
  - add_roster_agent refuses to seat a role that is not enabled, and refuses a
    second seat for a singleton-seat role (the architect; MC-1585 made generals a
    pool, so they seat freely like any worker role), and
  - ensure_role_in_roster (plan.add_task's guard) refuses an off-roster task role.
Every guard no-ops when configuredRoles is absent or empty, so legacy/headless
runs seat and plan exactly as before.

MC-1542 removed the lazy reviewer-id registration path: there are no reviewer
seats to mint on a gate claim, because there are no gates. `configuredRoles` now
has exactly one job — bounding who may be seated and what roles may be planned —
and the only way onto the roster is `add_roster_agent`. These are pure in-process
state builders (the same dict-state shape the folder store materializes), plus a
CLI init round-trip that pins where the key comes from.
"""

from __future__ import annotations

import json

import pytest

from sprintengine_core import store
from sprintengine_core.tool.state import (
    add_roster_agent,
    ensure_role_in_roster,
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
    state = configured_state(["architect", "developer", "performance", "tester"])
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


def test_generals_are_a_pool_not_a_singleton_seat() -> None:
    # Inverted from the old "second general seat is rejected" contract (MC-1585):
    # the default product is a POOL of plain agents sharing one task graph by
    # claiming, which the startup prompt and sprintengine_general_workflow have
    # always promised. A general seats like a developer; only the architect is
    # capped at one live seat. Planning stays serialized by task ownership.
    state = configured_state(["general"], seated={"general": "general"})
    agent = add_roster_agent(state, "general", "general-1", "general")
    assert agent["role"] == "general"
    assert add_roster_agent(state, "general", "general-2", "general")["role"] == "general"
    assert set(state["agents"]) == {"general", "general-1", "general-2"}


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


def test_enabled_non_planning_roles_seat_freely() -> None:
    # An enabled, non-planning role seats on demand and is not a singleton: two
    # developer ids co-exist because each owns exactly one task.
    state = configured_state(
        ["architect", "developer", "security"],
        seated={"architect-1": "architect"},
    )
    add_roster_agent(state, "security", "security-1", "architect")
    add_roster_agent(state, "developer", "developer-1", "architect")
    add_roster_agent(state, "developer", "developer-2", "architect")
    assert state["agents"]["security-1"]["role"] == "security"
    assert {"developer-1", "developer-2"} <= set(state["agents"])


def test_guards_noop_when_configured_roles_absent() -> None:
    # Legacy run: rosterConfigured but no configuredRoles key -> nothing enforced.
    state = configured_state(None, seated={"architect-1": "architect"})
    add_roster_agent(state, "security", "security-1", "architect")
    add_roster_agent(state, "architect", "architect-2", "architect")
    assert state["agents"]["security-1"]["role"] == "security"
    assert state["agents"]["architect-2"]["role"] == "architect"


def test_guards_noop_when_configured_roles_empty() -> None:
    # An explicit empty enabled set is treated as "unenforced" for the roster
    # boundary: an empty roster cannot be the whole allowed set.
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


def test_ensure_role_in_roster_rejects_an_enabled_but_unseated_role() -> None:
    # Two gates, both enforced: `developer` is enabled, but nothing is seated for
    # it, so plan.add_task still refuses. (`sprintengine.roster.add` first.)
    state = configured_state(["architect", "developer"], seated={"architect-1": "architect"})
    with pytest.raises(SystemExit) as exc:
        ensure_role_in_roster(state, "developer")
    assert "not in this Sprint Engine roster" in str(exc.value)


def test_ensure_role_in_roster_noop_without_configured_roles() -> None:
    # No configuredRoles and no seated roster constraint -> unconfigured, no raise.
    state = {"sprintengine": {}, "agents": {}, "events": []}
    ensure_role_in_roster(state, "security")


# --- where configuredRoles comes from ----------------------------------------


def test_init_persists_configured_roles(tmp_path) -> None:
    # A real CLI init round-trip: --configured-roles-json lands in run.yaml as
    # `configuredRoles`, distinct from the seated agent roles and the
    # roleRuntimes key set (which includes CLI-default roles).
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
    assert set(state["configuredRoles"]) != store.roster_roles_from_state(state)


def test_init_without_configured_roles_omits_key(tmp_path) -> None:
    from helpers import SwarmCli, read_state

    state_path = tmp_path / ".multi-code" / "sprintengine" / "init-no-configured-roles" / "run.yaml"
    cli = SwarmCli(state_path)
    cli.run("init", "--name", "init-no-configured-roles", "--agent", "developer:developer-1")
    assert "configuredRoles" not in read_state(state_path)
