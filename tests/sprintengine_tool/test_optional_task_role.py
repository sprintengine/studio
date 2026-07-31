"""A task's role is optional, and the fake `general` role is deleted (MC-2057).

`general` was never a role — no soul file, no directive skill. It existed only so
that "an agent with no role" could pass through plumbing that demanded one. These
pin the replacement: absent is representable, absent is an OMITTED key, absent is
legal at the role boundaries, and a stored run that spelled absence as `general`
reads forward as a roleless run.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml

from helpers import create_team, read_state, task, write_state
from sprintengine_core import store as folder_store
from sprintengine_core.tool.roles import is_configured_role, optional_configured_role
from sprintengine_core.tool.state import (
    configured_role_set,
    is_roleless_agent_id,
    mint_lease,
    task_is_claimable_by_role,
    worker_role,
)
from sprintengine_core.tool.tasks import normalize_task


# --- the deleted role ---------------------------------------------------------


def test_general_is_no_longer_a_role_anywhere_in_the_registry() -> None:
    assert is_configured_role("general") is False
    with pytest.raises(SystemExit) as error:
        optional_configured_role("general", context="Task T1")
    assert "unknown role 'general'" in str(error.value)


# --- absent is an omitted key -------------------------------------------------


def test_a_task_may_carry_no_role_and_the_key_is_omitted() -> None:
    normalized = normalize_task({"id": "T1", "title": "Anyone may take this"})
    assert "role" not in normalized

    # An explicitly blank role is the same thing, not a third state.
    assert "role" not in normalize_task({"id": "T2", "title": "Blank", "role": "  "})

    # A named role still resolves, and a wrong one still fails.
    assert normalize_task({"id": "T3", "title": "Specialist", "role": "developer"})["role"] == "developer"
    with pytest.raises(SystemExit):
        normalize_task({"id": "T4", "title": "Typo", "role": "develper"})


def test_a_roleless_lease_omits_its_role_too() -> None:
    roleless = {"id": "T1", "title": "Anyone"}
    assert "role" not in mint_lease(roleless, "agent-1")

    roled = {"id": "T2", "title": "Specialist", "role": "developer"}
    assert mint_lease(roled, "developer-1")["role"] == "developer"


def test_run_yaml_never_persists_a_null_role(tmp_path: Path) -> None:
    fixture = create_team(tmp_path, "roleless-run-yaml", [task("T1", "Anyone may take this")])
    entries = folder_store.load_run_yaml(fixture.team_dir)["tasks"]
    assert entries[0]["id"] == "T1"
    assert "role" not in entries[0]


# --- configured_role_set: presence is the signal ------------------------------


def test_configured_role_set_distinguishes_absent_from_empty() -> None:
    # Absent / not a list: legacy or headless, boundaries no-op.
    assert configured_role_set({}) is None
    assert configured_role_set({"configuredRoles": None}) is None
    assert configured_role_set({"configuredRoles": "developer"}) is None
    # Present: its set, INCLUDING the empty set (a roleless run).
    assert configured_role_set({"configuredRoles": []}) == set()
    assert configured_role_set({"configuredRoles": ["developer", "tester"]}) == {"developer", "tester"}


# --- who may claim what -------------------------------------------------------


def test_absent_task_role_means_any_agent_may_take_it() -> None:
    roleless = {"id": "T1"}
    assert task_is_claimable_by_role(roleless, None) is True
    assert task_is_claimable_by_role(roleless, "developer") is True

    specialist = {"id": "T2", "role": "developer"}
    assert task_is_claimable_by_role(specialist, "developer") is True
    assert task_is_claimable_by_role(specialist, "tester") is False
    # A roleless agent is not a specialist and does not get specialist work.
    assert task_is_claimable_by_role(specialist, None) is False


def test_a_roleless_run_claims_and_completes_without_a_role(tmp_path: Path) -> None:
    fixture = create_team(tmp_path, "roleless-claim", [task("T1", "Anyone may take this")])
    state = read_state(fixture.state_path)
    state["configuredRoles"] = []
    state.setdefault("sprintengine", {})["rosterConfigured"] = True
    write_state(fixture.state_path, state)

    listed = fixture.cli.run("task", "list")
    assert [entry["id"] for entry in listed["readyTasks"]] == ["T1"]
    assert "role" not in listed["readyTasks"][0]

    claimed = fixture.cli.run("task", "next", "--id", "agent-1")
    assert claimed["claimed"] is True
    assert claimed["task"]["id"] == "T1"
    assert "role" not in claimed["task"]
    assert claimed["task"]["ownerAgentId"] == "agent-1"

    # Publish -> review phase -> done, with no role anywhere in the lifecycle.
    fixture.cli.run("task", "publish", "--task-id", "T1", "--id", "agent-1", "--summary", "Built it.")
    assert read_state(fixture.state_path)["tasks"][0]["status"] == "review"
    fixture.cli.run(
        "task", "advance", "--task-id", "T1", "--id", "agent-1",
        "--phase", "review", "--outcome", "pass", "--summary", "Self-reviewed.",
    )
    finished = read_state(fixture.state_path)["tasks"][0]
    assert finished["status"] == "done"
    assert "role" not in finished


# --- roleless ids -------------------------------------------------------------


def test_worker_role_reports_roleless_ids_as_roleless() -> None:
    assert is_roleless_agent_id("coordinator") is True
    assert is_roleless_agent_id("agent-1") is True
    assert is_roleless_agent_id("agent-12") is True
    assert is_roleless_agent_id("agent") is False
    assert is_roleless_agent_id("developer-1") is False

    # Unconfigured run: the minted-id guess matches against the WHOLE registry,
    # which is exactly where a roleless id could pick up a role it does not have.
    unconfigured: dict = {"tasks": []}
    assert worker_role(unconfigured, "coordinator") == ""
    assert worker_role(unconfigured, "agent-1") == ""
    assert worker_role(unconfigured, "developer-2") == "developer"

    # A roleless run records an EMPTY set; it must not borrow the registry's roles.
    roleless: dict = {"configuredRoles": [], "tasks": []}
    assert worker_role(roleless, "developer-2") == ""


# --- role boundaries ----------------------------------------------------------


def test_a_roleless_run_rejects_a_mistyped_role_but_admits_an_absent_one(tmp_path: Path) -> None:
    fixture = create_team(tmp_path, "roleless-boundary", [])
    state = read_state(fixture.state_path)
    state["configuredRoles"] = []
    state.setdefault("sprintengine", {})["rosterConfigured"] = True
    write_state(fixture.state_path, state)

    added = fixture.cli.run("plan", "add-task", "--title", "No role needed")
    assert "role" not in added["task"]

    with pytest.raises(AssertionError) as failure:
        fixture.cli.run("plan", "add-task", "--title", "Typo", "--role", "develper")
    assert "unknown role" in str(failure.value)

    with pytest.raises(AssertionError) as failure:
        fixture.cli.run("plan", "add-task", "--title", "Off roster", "--role", "developer")
    assert "not enabled for this run" in str(failure.value)


# --- the v4 -> v5 migration ---------------------------------------------------


def seed_v4_general_store(tmp_path: Path, name: str) -> Path:
    """A v4 store exactly as the two `general` runs on disk record one."""
    fixture = create_team(
        tmp_path,
        name,
        [
            task("T0", "Review general plan artifact", "general", status="done"),
            task("T1", "Build it", "general", status="in_progress", owner="general-2"),
        ],
    )
    state = read_state(fixture.state_path)
    state["configuredRoles"] = ["general"]
    state["roleRuntimes"] = {
        "general": {"model": "claude-opus-5", "cli": "claude-code"},
        "developer": {"cli": "claude-code"},
    }
    in_flight = state["tasks"][1]
    in_flight["lastImplementedByAgentId"] = "general"
    mint_lease(in_flight, "general-2", "general")
    write_state(fixture.state_path, state)

    # Stamp the store back to v4 (write paths always stamp the current version).
    run_path = fixture.team_dir / folder_store.RUN_FILE
    run = folder_store.load_run_yaml(fixture.team_dir)
    run["schemaVersion"] = 4
    folder_store.atomic_write_yaml(run_path, run)
    return fixture.team_dir


def test_a_stored_general_run_opens_as_a_roleless_run_with_its_graph_intact(tmp_path: Path) -> None:
    team_dir = seed_v4_general_store(tmp_path, "v4-general")

    state = folder_store.state_from_folder_store(team_dir)

    # The fake role is gone in every stored spelling.
    assert state["configuredRoles"] == []
    assert all("role" not in entry for entry in state["tasks"])
    assert "general" not in state["roleRuntimes"]
    assert state["roleRuntimes"]["developer"] == {"cli": "claude-code"}

    # Ids that encoded the fake role now encode none.
    in_flight = next(entry for entry in state["tasks"] if entry["id"] == "T1")
    assert in_flight["ownerAgentId"] == "agent-2"
    assert in_flight["lastImplementedByAgentId"] == "coordinator"
    assert in_flight["lease"]["workerId"] == "agent-2"
    assert "role" not in in_flight["lease"]

    # Graph, ownership, status, and lease state otherwise survive untouched.
    assert [entry["id"] for entry in state["tasks"]] == ["T0", "T1"]
    assert in_flight["status"] == "in_progress"
    assert in_flight["lease"]["repo"] == "primary"

    # The store is upgraded on disk, and re-reading is a no-op.
    run = folder_store.load_run_yaml(team_dir)
    assert run["schemaVersion"] == folder_store.RUN_SCHEMA_VERSION
    assert folder_store.state_from_folder_store(team_dir)["configuredRoles"] == []


def test_the_projection_path_migrates_too(tmp_path: Path) -> None:
    """The renderer reads projection.json without calling Python, so the projection
    build must upgrade a v4 store rather than reject it."""
    team_dir = seed_v4_general_store(tmp_path, "v4-general-projection")

    projection = folder_store.build_projection(team_dir)

    assert projection["run"]["schemaVersion"] == folder_store.RUN_SCHEMA_VERSION
    assert projection["run"]["configuredRoles"] == []
    assert all("role" not in entry for entry in projection["tasks"])


def test_a_v4_role_based_run_is_stamped_v5_and_otherwise_unchanged(tmp_path: Path) -> None:
    """Every role-based run on disk goes through the same migration. It must change
    nothing but the version — this is the quiet regression the epic risks."""
    fixture = create_team(tmp_path, "v4-roles", [task("T1", "Build it", "developer", owner="developer-1")])
    state = read_state(fixture.state_path)
    state["configuredRoles"] = ["architect", "developer"]
    write_state(fixture.state_path, state)
    run = folder_store.load_run_yaml(fixture.team_dir)
    before = json.loads(json.dumps({key: value for key, value in run.items() if key != "schemaVersion"}))
    run["schemaVersion"] = 4
    folder_store.atomic_write_yaml(fixture.team_dir / folder_store.RUN_FILE, run)

    migrated = folder_store.state_from_folder_store(fixture.team_dir)

    assert migrated["configuredRoles"] == ["architect", "developer"]
    assert migrated["tasks"][0]["role"] == "developer"
    assert migrated["tasks"][0]["ownerAgentId"] == "developer-1"
    after = folder_store.load_run_yaml(fixture.team_dir)
    assert after["schemaVersion"] == folder_store.RUN_SCHEMA_VERSION
    assert {key: value for key, value in after.items() if key != "schemaVersion"} == before


def test_a_pre_v4_store_is_still_rejected_never_migrated(tmp_path: Path) -> None:
    """v5 is the ONE migrating step. The pre-release clean break stands below it."""
    fixture = create_team(tmp_path, "v3-store", [task("T1", "Build it", "developer")])
    run = folder_store.load_run_yaml(fixture.team_dir)
    run["schemaVersion"] = 3
    folder_store.atomic_write_yaml(fixture.team_dir / folder_store.RUN_FILE, run)

    with pytest.raises(folder_store.RunStoreVersionError):
        folder_store.state_from_folder_store(fixture.team_dir)


def test_the_migration_is_yaml_stable(tmp_path: Path) -> None:
    """It rewrites run.yaml in place, so nothing outside the deleted role moves."""
    team_dir = seed_v4_general_store(tmp_path, "v4-yaml-stable")
    before = yaml.safe_load((team_dir / folder_store.RUN_FILE).read_text(encoding="utf-8"))

    folder_store.state_from_folder_store(team_dir)
    after = yaml.safe_load((team_dir / folder_store.RUN_FILE).read_text(encoding="utf-8"))

    changed = {key for key in set(before) | set(after) if before.get(key) != after.get(key)}
    assert changed == {"schemaVersion", "configuredRoles", "roleRuntimes", "tasks"}
