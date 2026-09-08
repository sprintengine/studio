"""SEAM (MC-1883 x the sprint.create contract): a per-step roster reaches run.yaml.

The horizon epic threads a roster from a `@roster=` annotation on one step,
through `resolveEntryRoster`, the orchestrator's start action, the `startSprint`
port and the `sprint.create` delegate, into a launched run. Every hop above this
one is pinned by a TypeScript test. This is the LAST hop, and the only one that
can be proven against the real engine rather than a fake: the roles a roster
staffs must actually land in the run's `run.yaml`, not merely be passed along.

Without this, "the roster reached the launch" is an assertion about arguments.
With it, the claim is about the artifact the agents are actually staffed from.
"""
from __future__ import annotations

from pathlib import Path

from helpers import SwarmCli, read_state


def init_run(tmp_path: Path, name: str, *extra: str) -> Path:
    """Initialize a real run through the engine CLI, as the app's launch does."""
    state_path = tmp_path / ".multi-code" / "sprintengine" / name / "run.yaml"
    state_path.parent.mkdir(parents=True, exist_ok=True)
    SwarmCli(state_path).run(
        "init",
        "--name",
        name,
        "--goal",
        f"prove {name} staffing",
        *extra,
    )
    return state_path


def test_a_steps_roster_lands_in_its_runs_run_yaml(tmp_path) -> None:
    # The two staffing flags the launch path derives from a resolved roster: the
    # seats it opens (`--agent role:id`) and the roles it declares configured.
    state_path = init_run(
        tmp_path,
        "mobile-ui-step",
        "--agent",
        "developer:developer-1",
        "--agent",
        "tester:tester-1",
        "--configured-roles-json",
        '["developer", "tester"]',
    )
    state = read_state(state_path)

    assert state["configuredRoles"] == ["developer", "tester"]
    # `rosterConfigured` is the engine's own record that staffing was an explicit
    # choice — not a default it invented.
    assert state["sprintengine"]["rosterConfigured"] is True


def test_two_steps_with_different_rosters_produce_differently_staffed_runs(tmp_path) -> None:
    # The epic's acceptance, stated literally: "Two steps in one horizon with
    # different @roster= values produce two runs staffed differently, verified in
    # each run's run.yaml." Two runs, two rosters, one assertion each.
    mobile = read_state(
        init_run(
            tmp_path,
            "step-mobile-ui",
            "--agent",
            "developer:developer-1",
            "--configured-roles-json",
            '["developer"]',
        )
    )
    backend = read_state(
        init_run(
            tmp_path,
            "step-general-agents",
            "--agent",
            "architect:architect-1",
            "--agent",
            "developer:developer-1",
            "--agent",
            "reviewer:reviewer-1",
            "--configured-roles-json",
            '["architect", "developer", "reviewer"]',
        )
    )

    assert mobile["configuredRoles"] == ["developer"]
    assert backend["configuredRoles"] == ["architect", "developer", "reviewer"]
    assert mobile["configuredRoles"] != backend["configuredRoles"]


def test_a_run_with_no_roster_declares_no_configured_roles(tmp_path) -> None:
    # The un-staffed case the horizon's built-in default produces. It must be an
    # EMPTY declaration, never a silently seeded specialist set — the whole point
    # of the "absent means off" rule the epic established (owner, 2026-07-14).
    state = read_state(init_run(tmp_path, "step-no-roles"))
    # ABSENT, not `[]`: the engine writes the key only when staffing was chosen,
    # so "no roster" is distinguishable from "a roster that staffs nothing".
    assert "configuredRoles" not in state
    assert state["sprintengine"]["rosterConfigured"] is False
    # And no seats were invented for it.
    assert state["roles"] == {}
