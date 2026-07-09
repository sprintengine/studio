"""Fix-forward sweeps (MC-1542 Stage 2).

A sweep is an ordinary task in a sweep role's lane that reviews the branch and
fixes what it finds. Nothing in the engine treats it specially — that is the point.
What the engine DOES enforce:

- the fix-forward mandate is layered onto every sweep role's startup brief, bundled
  or custom, without the manifest referencing it;
- `requiredSweeps` is the operator's override of the architect's risk-tiered call,
  and the run cannot complete while a mandated sweep has no planned task.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from helpers import create_team, read_state, task, write_state, write_workspace_role
from sprintengine_core import store as folder_store
from sprintengine_core.role_registry import discover_role_registry
from sprintengine_core.skill_layers import (
    SPRINTENGINE_SOUL_EXTRA_SKILLS,
    SPRINTENGINE_SWEEP_SKILLS,
    sprintengine_extra_skills_for_role,
)


# --- the sweep layer --------------------------------------------------------


def test_the_fix_forward_mandate_is_layered_onto_sweep_roles_only() -> None:
    discovery = discover_role_registry(workspace_root=Path("/unused"), user_root=Path("/unused"))

    assert sprintengine_extra_skills_for_role(discovery, "security") == (
        *SPRINTENGINE_SWEEP_SKILLS,
        *SPRINTENGINE_SOUL_EXTRA_SKILLS,
    )
    assert sprintengine_extra_skills_for_role(discovery, "developer") == SPRINTENGINE_SOUL_EXTRA_SKILLS
    # A broken/unknown role must never lose the quality bar.
    assert sprintengine_extra_skills_for_role(discovery, "not_a_role") == SPRINTENGINE_SOUL_EXTRA_SKILLS


def test_a_custom_workspace_sweep_role_inherits_the_mandate(tmp_path: Path) -> None:
    """A pack author declares `sweep: {focus, when}` and nothing else."""
    workspace = tmp_path / "workspace"
    write_workspace_role(
        workspace,
        "ai_slop",
        label="AI slop review",
        sweep={"focus": "dead abstractions, boilerplate comments, hedging copy", "when": "always"},
    )
    discovery = discover_role_registry(workspace_root=workspace, user_root=tmp_path / "user")

    assert discovery.get_role("ai_slop").is_sweep
    assert "ai_slop" in [role.id for role in discovery.sweep_roles()]
    assert sprintengine_extra_skills_for_role(discovery, "ai_slop")[0] == SPRINTENGINE_SWEEP_SKILLS[0]


def test_the_sweep_mandate_reaches_a_rendered_sweep_brief() -> None:
    from sprintengine_core.tool.prompts import load_soul_prompt

    security = load_soul_prompt("security") or ""
    developer = load_soul_prompt("developer") or ""

    assert "Fix-Forward Sweep" in security
    assert "Patch what you find, directly." in security
    assert "Never take the whole sprint hostage over one finding." in security
    assert "Fix-Forward Sweep" not in developer
    # The quality norms still ride both.
    assert "production_reality_gate" in security
    assert "production_reality_gate" in developer


# --- requiredSweeps ---------------------------------------------------------


def test_required_sweeps_accepts_registry_sweep_roles(tmp_path: Path) -> None:
    from sprintengine_core.tool.state import apply_required_sweeps

    state: dict = {}
    apply_required_sweeps(state, None)
    assert "requiredSweeps" not in state

    apply_required_sweeps(state, "[]")
    assert "requiredSweeps" not in state

    apply_required_sweeps(state, '["tester", "security", "tester"]')
    assert state["requiredSweeps"] == ["tester", "security"]


def test_required_sweeps_rejects_a_worker_role(tmp_path: Path) -> None:
    """A typo (or a worker role) must fail at init, not silently never be planned."""
    from sprintengine_core.tool.state import apply_required_sweeps

    with pytest.raises(SystemExit, match="non-sweep role"):
        apply_required_sweeps({}, '["developer"]')


def test_required_sweeps_rejects_an_unknown_role(tmp_path: Path) -> None:
    from sprintengine_core.tool.state import apply_required_sweeps

    with pytest.raises(SystemExit):
        apply_required_sweeps({}, '["not_a_role_at_all"]')


def test_required_sweeps_round_trips_through_run_yaml_and_projection(tmp_path: Path) -> None:
    fixture = create_team(tmp_path, "sweeps-roundtrip", [task("T1", "Work", "developer")])
    state = read_state(fixture.state_path)
    state["requiredSweeps"] = ["tester"]
    write_state(fixture.state_path, state)

    assert folder_store.load_run_yaml(fixture.team_dir)["requiredSweeps"] == ["tester"]
    assert read_state(fixture.state_path)["requiredSweeps"] == ["tester"]

    projection = json.loads((fixture.team_dir / folder_store.PROJECTION_FILE).read_text(encoding="utf-8"))
    assert projection["run"]["requiredSweeps"] == ["tester"]


def test_absent_required_sweeps_stays_absent(tmp_path: Path) -> None:
    fixture = create_team(tmp_path, "sweeps-absent", [task("T1", "Work", "developer")])
    assert "requiredSweeps" not in folder_store.load_run_yaml(fixture.team_dir)
    assert folder_store.run_required_sweeps(read_state(fixture.state_path)) == []


# --- the completion invariant ------------------------------------------------


def test_a_run_cannot_complete_while_a_mandated_sweep_has_no_planned_task() -> None:
    from sprintengine_core.tool.commands.run import missing_required_sweeps

    state = {
        "requiredSweeps": ["tester", "security"],
        "tasks": [
            {"id": "T1", "role": "developer", "status": "done"},
            {"id": "T2", "role": "security", "status": "done"},
        ],
    }
    assert missing_required_sweeps(state) == ["tester"]

    state["tasks"].append({"id": "T3", "role": "tester", "status": "todo"})
    assert missing_required_sweeps(state) == []


def test_a_canceled_task_does_not_satisfy_a_mandated_sweep() -> None:
    from sprintengine_core.tool.commands.run import missing_required_sweeps

    state = {
        "requiredSweeps": ["tester"],
        "tasks": [{"id": "T1", "role": "tester", "status": "canceled"}],
    }
    assert missing_required_sweeps(state) == ["tester"]


def test_no_mandated_sweeps_means_no_invariant() -> None:
    from sprintengine_core.tool.commands.run import missing_required_sweeps

    assert missing_required_sweeps({"tasks": []}) == []


def test_finalize_blocks_the_run_and_names_the_missing_sweep(tmp_path: Path) -> None:
    from sprintengine_core.tool.commands.run import finalize_completed_run

    state = {
        "sprintengine": {"name": "t", "goal": "g"},
        "requiredSweeps": ["tester"],
        "tasks": [{"id": "T1", "role": "developer", "status": "done"}],
    }
    result = finalize_completed_run(state, tmp_path / "run.yaml", {})

    assert result["blocked"] is True
    assert result["missingRequiredSweeps"] == ["tester"]
    assert "tester" in result["message"]
    assert "one task per required sweep role" in result["message"]
