"""The coordinator brief: the one instruction layer a roleless seat receives.

An agent with no role gets no role directive — that is the point of it — so the
agent holding the coordination job is told what coordinating this sprint means,
and nothing else. An architect coordinates through its own directive skill and
its card is unchanged.

Pinned here: the brief reaches a roleless gate whatever source shape the run was
created from (the init branches rewrite that card wholesale), it never reaches an
architect run, it is layered once rather than accumulated, and it names no role
and no persona.
"""

from __future__ import annotations

import json
from pathlib import Path

from helpers import SwarmCli, create_team, read_state, task, write_state
from sprintengine_core.tool.plans import (
    COORDINATOR_BRIEF_HEADING,
    apply_coordinator_brief_to_task,
    ensure_plan_approval_gate,
    find_architect_plan_gate,
)


def seed_plan_gate(fixture, *roles: str) -> dict:
    """Seed a run's plan-approval gate the way `sprintengine run` does."""
    state = read_state(fixture.state_path)
    state.setdefault("sprintengine", {})["rosterConfigured"] = True
    state["configuredRoles"] = list(roles)
    ensure_plan_approval_gate(state, fixture.state_path, "sprintengine", start_active=False)
    write_state(fixture.state_path, state)
    return read_state(fixture.state_path)


def gate_description(state: dict, state_path: Path) -> str:
    return str(find_architect_plan_gate(state, state_path)["task"]["description"])


def brief_of(description: str) -> str:
    assert COORDINATOR_BRIEF_HEADING in description, description
    return description.split(COORDINATOR_BRIEF_HEADING, 1)[1]


def test_a_roleless_gate_card_carries_the_brief(tmp_path) -> None:
    fixture = create_team(tmp_path, "roleless-brief", [])
    state = seed_plan_gate(fixture, "developer", "tester")

    brief = brief_of(gate_description(state, fixture.state_path))
    # Exactly the six things: what this is, where to start, one task per item,
    # read the modules, order them into a graph, and the final verification task.
    assert "You are coordinating this sprint" in brief
    assert "create one task for each piece of work it names" in brief
    assert "Read the modules those tasks will touch" in brief
    assert "build the task graph" in brief
    assert "final verification task" in brief
    # No persona and no role vocabulary: inventing a generalist is what this epic
    # deletes, and the plan-quality contract lives on the acceptance criteria.
    for forbidden in ("architect", "planner", "generalist", "you are a", "persona", "role"):
        assert forbidden not in brief.lower(), forbidden


def test_an_architect_gate_card_gains_no_brief(tmp_path) -> None:
    fixture = create_team(tmp_path, "architect-no-brief", [])
    state = seed_plan_gate(fixture, "architect", "developer")

    assert COORDINATOR_BRIEF_HEADING not in gate_description(state, fixture.state_path)


def test_the_brief_is_layered_once_not_accumulated(tmp_path) -> None:
    """Every gate re-seed re-applies it, so it must replace, never append."""
    fixture = create_team(tmp_path, "roleless-brief-idempotent", [])
    state = seed_plan_gate(fixture, "developer")
    first = gate_description(state, fixture.state_path)

    ensure_plan_approval_gate(state, fixture.state_path, "sprintengine", start_active=False)
    apply_coordinator_brief_to_task(
        find_architect_plan_gate(state, fixture.state_path)["task"], state, fixture.state_path
    )

    repeated = gate_description(state, fixture.state_path)
    assert repeated == first
    assert repeated.count(COORDINATOR_BRIEF_HEADING) == 1


def test_a_card_that_is_only_the_brief_still_replaces_it(tmp_path) -> None:
    """No separator to match on when the brief IS the whole description."""
    fixture = create_team(tmp_path, "roleless-brief-bare", [])
    state = seed_plan_gate(fixture, "developer")
    gate = find_architect_plan_gate(state, fixture.state_path)["task"]
    gate["description"] = brief_of(str(gate["description"]))
    gate["description"] = COORDINATOR_BRIEF_HEADING + gate["description"]

    apply_coordinator_brief_to_task(gate, state, fixture.state_path)
    assert str(gate["description"]).count(COORDINATOR_BRIEF_HEADING) == 1


def test_a_completed_gate_card_is_left_alone(tmp_path) -> None:
    """The card of an approved plan is a record, not a brief anyone works from."""
    fixture = create_team(tmp_path, "roleless-brief-done", [])
    state = seed_plan_gate(fixture, "developer")
    gate = find_architect_plan_gate(state, fixture.state_path)["task"]
    gate["status"] = "done"
    gate["description"] = "Approved."

    apply_coordinator_brief_to_task(gate, state, fixture.state_path)
    assert gate["description"] == "Approved."


def test_only_the_coordination_task_receives_the_brief(tmp_path) -> None:
    """The plan artifact's binding is the marker; ordinary work is untouched."""
    fixture = create_team(tmp_path, "roleless-brief-scope", [task("T9", "Build the thing")])
    state = seed_plan_gate(fixture, "developer")

    ordinary = next(t for t in state["tasks"] if t["id"] == "T9")
    apply_coordinator_brief_to_task(ordinary, state, fixture.state_path)
    assert COORDINATOR_BRIEF_HEADING not in ordinary["description"]


def _sourced_workspace(tmp_path: Path):
    """A workspace whose backlog holds an epic and one child, plus a run path."""
    root = tmp_path / "project"
    epic = root / "backlog" / "epics" / "auth-revamp.md"
    child = root / "backlog" / "login-form.md"
    epic.parent.mkdir(parents=True, exist_ok=True)
    epic.write_text("# Auth revamp\n", encoding="utf-8")
    child.write_text("---\nepic: auth-revamp\n---\n# Login form\n", encoding="utf-8")
    return root, epic, child, root / ".multi-code" / "sprintengine" / "auth-revamp" / "run.yaml"


def test_the_brief_survives_the_epic_branch_and_points_at_the_source_documents(tmp_path) -> None:
    """The regression this layer exists to hold.

    The epic init branch replaces the gate's title, description, and acceptance
    wholesale, so a brief applied when the gate was created would be gone by the
    time the coordinator reads the card. The paths themselves come from the
    source-context block `apply_source_context_to_task` already writes there.
    """
    root, epic, child, state_path = _sourced_workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    cli.run(
        "handover",
        "--name", "auth-revamp",
        "--goal", "Revamp authentication",
        "--handover", str(epic),
        "--source-plan-kind", "epic",
        "--source", f"generic_context:{child}",
        "--reference-sources",
    )
    initialized = cli.run(
        "init",
        "--goal", "Revamp authentication",
        # The planner path is opt-in since MC-2128; an epic source defaults to the
        # direct intake, which has no plan gate for a brief to land on.
        "--intake", "planned",
        "--configured-roles-json", json.dumps(["developer", "tester"]),
    )

    description = initialized["planTask"]["description"]
    assert description.startswith("Every open child item of the epic is one task.")
    brief = brief_of(description)
    # The brief introduces the source list, and the list itself follows directly:
    # one block, written by `apply_source_context_to_task`, never a second copy.
    assert "Start from the source documents listed below" in brief
    assert brief.count("Incoming source context for this run:") == 1
    assert brief.index("Start from the source") < brief.index("Incoming source context")
    # Project-root-relative paths, never a machine path.
    assert "- Root handoff (Epic): read `backlog/epics/auth-revamp.md`." in brief
    assert "- Epic child item (Context): read `backlog/login-form.md`." in brief
    assert str(root) not in description

    # A second init (the app re-inits an existing run) neither drops nor doubles it.
    reinitialized = cli.run("init", "--goal", "Revamp authentication", "--intake", "planned")
    reinit_description = str(reinitialized["planTask"]["description"])
    assert reinit_description.count(COORDINATOR_BRIEF_HEADING) == 1
    assert brief_of(reinit_description) == brief


def test_an_architect_run_from_the_same_source_shape_gains_no_brief(tmp_path) -> None:
    root, epic, child, state_path = _sourced_workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    cli.run(
        "handover",
        "--name", "auth-revamp",
        "--goal", "Revamp authentication",
        "--handover", str(epic),
        "--source-plan-kind", "epic",
        "--source", f"generic_context:{child}",
        "--reference-sources",
    )
    initialized = cli.run(
        "init",
        "--goal", "Revamp authentication",
        "--intake", "planned",
        "--configured-roles-json", json.dumps(["architect", "developer"]),
    )

    assert COORDINATOR_BRIEF_HEADING not in initialized["planTask"]["description"]
