"""Quality-gate derivation: config-keyed roles + soulless-General roster.

Derivation selects gate roles from the run's explicit enabled-role set
(`configuredRoles`, written at init), not from who is currently seated, so a
lazy architect-only roster still derives its required reviewer/tester gates.
Legacy runs with no `configuredRoles` key fall back to the seated-roster roles
and derive gates exactly as before. A gate whose role is not enabled is skipped,
never queued — so a General-only roster (none of the specialist reviewer roles)
derives no specialist gate and instead authors its own self-approved
`role: general` gates. These tests pin all of that.
"""

from __future__ import annotations

import json

from sprintengine_core import store
from sprintengine_core.tool.gates import gate_is_claimable_for_role, latest_implementer_agent_id

POLICY = store.DEFAULT_QUALITY_POLICY
SPECIALIST_GATE_IDS = {"architect_review", "code_reviewer", "nuclear_reviewer", "spec_reviewer", "tester", "product"}


def roster(*roles: str) -> dict:
    return {
        "sprintengine": {"rosterConfigured": True},
        "agents": {f"{role}-1": {"role": role, "status": "idle"} for role in roles},
    }


def roster_with_configured(seated: list[str], configured: list[str]) -> dict:
    state = roster(*seated)
    state["configuredRoles"] = configured
    return state


def derived_ids(task: dict, state: dict) -> list[str]:
    return [gate["id"] for gate in store.derive_default_quality_gates(task, state, POLICY)]


def test_general_only_roster_derives_no_unclaimable_specialist_gates() -> None:
    state = roster("general")
    # A general implementation task: none of the specialist reviewer roles are
    # rostered, so no default gate is derived — nothing becomes unclaimable.
    impl_task = {"id": "T1", "role": "general", "producesImplementation": True, "ownedPaths": ["sprintengine_core/x.py"]}
    assert derived_ids(impl_task, state) == []

    # Even if a developer-role task somehow lands in a General-only roster, the
    # missing code_reviewer/spec_reviewer/tester/product/architect roles are all
    # skipped rather than queued.
    dev_task = {"id": "T2", "role": "developer", "ownedPaths": ["sprintengine_core/x.py"]}
    assert derived_ids(dev_task, state) == []


def test_missing_reviewer_roles_are_skipped_not_queued() -> None:
    # A partial roster that does reach the derivation loop: only the rostered
    # reviewer role yields a gate; the absent ones (spec_reviewer, tester,
    # product, nuclear, architect) are skipped, so every derived gate is
    # claimable by a rostered role.
    state = roster("general", "developer", "code_reviewer")
    dev_task = {"id": "T1", "role": "developer", "ownedPaths": ["sprintengine_core/x.py"]}
    gates = store.derive_default_quality_gates(dev_task, state, POLICY)
    ids = [gate["id"] for gate in gates]
    assert "code_reviewer" in ids
    assert not (SPECIALIST_GATE_IDS - {"code_reviewer"}) & set(ids)
    rostered = store.roster_roles_from_state(state)
    assert all(gate["role"] in rostered for gate in gates)


def test_general_authored_gate_normalizes_self_reviewable() -> None:
    gate = store.normalize_quality_gate(
        {"id": "general_review", "phase": "review", "role": "general", "status": "pending"},
        "fallback",
    )
    assert gate is not None
    assert gate["role"] == "general"
    assert gate["allowSelfReview"] is True  # default, so the General can self-approve
    assert gate["required"] is True


def test_general_self_review_gate_is_claimable_by_the_general() -> None:
    gate = store.normalize_quality_gate(
        {"id": "general_review", "phase": "review", "role": "general", "status": "pending"},
        "fallback",
    )
    task = {
        "id": "T1",
        "role": "general",
        "status": "review",
        "qualityGates": [gate],
        "comments": [{"type": "implementation_summary", "authorAgentId": "general-1", "actor": "general-1"}],
    }
    assert latest_implementer_agent_id(task) == "general-1"
    # Self-review is allowed by default — the General both implements and verdicts.
    assert gate_is_claimable_for_role(task, gate, "general", "general-1") is True

    # When a gate explicitly forbids self-review, the implementer is blocked.
    no_self = dict(gate, allowSelfReview=False)
    assert gate_is_claimable_for_role(task, no_self, "general", "general-1") is False


# --- configuredRoles-driven derivation (independent of who is seated) ---------


def test_configured_roles_derive_gates_when_reviewer_not_seated() -> None:
    # Architect-only roster, but configuredRoles enables the reviewer + tester.
    # The gates derive from configuration, not seat presence: code_reviewer and
    # tester are required even though neither is currently rostered.
    state = roster_with_configured(["architect"], ["developer", "code_reviewer", "tester"])
    dev_task = {"id": "T1", "role": "developer", "ownedPaths": ["src/server/x.py"]}
    gates = store.derive_default_quality_gates(dev_task, state, POLICY)
    by_id = {gate["id"]: gate for gate in gates}
    assert "code_reviewer" in by_id and by_id["code_reviewer"]["required"] is True
    assert "tester" in by_id and by_id["tester"]["required"] is True
    # configuredRoles is the enabled set, not the seated set nor the runtime keys.
    assert set(state["configuredRoles"]) != store.roster_roles_from_state(state)


def test_role_absent_from_configured_roles_derives_no_gate() -> None:
    # code_reviewer is seated but NOT enabled; tester is enabled but NOT seated.
    # Config wins both ways: no code_reviewer gate, and a tester gate is derived.
    state = roster_with_configured(["architect", "code_reviewer"], ["developer", "tester"])
    dev_task = {"id": "T1", "role": "developer", "ownedPaths": ["src/server/x.py"]}
    ids = derived_ids(dev_task, state)
    assert "code_reviewer" not in ids  # seated but not in configuredRoles -> skipped
    assert "tester" in ids  # in configuredRoles though unseated -> derived
    # Every unrostered specialist that is not enabled is skipped, never queued.
    assert not (SPECIALIST_GATE_IDS - {"tester"}) & set(ids)


def test_empty_configured_roles_derives_no_gates() -> None:
    # An explicit empty enabled set is present (not legacy) -> no gate roles.
    state = roster_with_configured(["architect", "developer", "code_reviewer"], [])
    dev_task = {"id": "T1", "role": "developer", "ownedPaths": ["src/server/x.py"]}
    assert derived_ids(dev_task, state) == []


def test_legacy_run_without_configured_roles_uses_roster_fallback() -> None:
    # No configuredRoles key -> derivation falls back to the seated roster and
    # produces exactly what it did before this change.
    state = roster("developer", "code_reviewer", "tester")
    assert "configuredRoles" not in state
    dev_task = {"id": "T1", "role": "developer", "ownedPaths": ["src/server/x.py"]}
    ids = derived_ids(dev_task, state)
    assert "code_reviewer" in ids and "tester" in ids
    # Unseated, unconfigured specialists stay skipped (nuclear/spec/product/architect).
    assert not (SPECIALIST_GATE_IDS - {"code_reviewer", "tester"}) & set(ids)


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
        "--configured-roles-json", json.dumps(["developer", "code_reviewer", "tester"]),
        "--role-runtimes-json", json.dumps({"developer": {"model": "claude-fable-5", "cli": "claude-code"}}),
    )
    state = read_state(state_path)
    assert state["configuredRoles"] == ["developer", "code_reviewer", "tester"]
    assert state["configuredRoles"] != list(state.get("roleRuntimes", {}).keys())
    assert set(state["configuredRoles"]) != store.roster_roles_from_state(state)


def test_init_without_configured_roles_omits_key(tmp_path) -> None:
    from helpers import SwarmCli, read_state

    state_path = tmp_path / ".multi-code" / "sprintengine" / "init-no-configured-roles" / "run.yaml"
    cli = SwarmCli(state_path)
    cli.run("init", "--name", "init-no-configured-roles", "--agent", "developer:developer-1")
    assert "configuredRoles" not in read_state(state_path)
