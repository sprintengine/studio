"""Quality-gate derivation for a soulless-General roster.

A General-only roster has none of the specialist reviewer roles, so the
roster-driven derivation skips them — a missing reviewer is never turned into an
unclaimable gate. The General instead authors its own `role: general` review /
testing gates, which it self-approves via the `allowSelfReview` default. These
tests pin both halves of that contract.
"""

from __future__ import annotations

from sprintengine_core import store
from sprintengine_core.tool.gates import gate_is_claimable_for_role, latest_implementer_agent_id

POLICY = store.DEFAULT_QUALITY_POLICY
SPECIALIST_GATE_IDS = {"architect_review", "code_reviewer", "nuclear_reviewer", "spec_reviewer", "tester", "product"}


def roster(*roles: str) -> dict:
    return {
        "sprintengine": {"rosterConfigured": True},
        "agents": {f"{role}-1": {"role": role, "status": "idle"} for role in roles},
    }


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
