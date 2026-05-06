from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path

import pytest

from multiloop_core.state import StateValidationError, validate_state
from tests.multiloop_tool.test_m1_cli import MultiloopCli, base_state, read_state, write_state


def test_milestone_start_creates_linked_sprintengine_run_with_relative_paths(tmp_path: Path) -> None:
    state_path = tmp_path / "multiloop" / "fixture-loop" / "state.json"
    state = base_state()
    state["roadmap"][0]["status"] = "accepted"
    state["roadmap"][1]["status"] = "planned"
    state["loop"]["currentMilestoneId"] = "M1"
    write_state(state_path, state)
    cli = MultiloopCli(tmp_path, state_path)

    started = cli.run("milestone", "start", "M2")

    assert "Started milestone: M2 [active]" in started.stdout
    assert "Sprint Engine state: .multi-code/sprintengine/fixture-loop-m2/state.yaml" in started.stdout
    multiloop_state = read_state(state_path)
    milestone = multiloop_state["roadmap"][1]
    assert milestone["sprintEngine"] == {
        "teamSlug": "fixture-loop-m2",
        "statePath": ".multi-code/sprintengine/fixture-loop-m2/state.yaml",
        "planPath": ".multi-code/sprintengine/fixture-loop-m2/plan.md",
    }
    assert multiloop_state["loop"]["currentMilestoneId"] == "M2"
    assert multiloop_state["loop"]["status"] == "active"

    sprint_state_path = tmp_path / ".multi-code" / "sprintengine" / "fixture-loop-m2" / "state.yaml"
    sprint_state = json.loads(sprint_state_path.read_text(encoding="utf-8"))
    assert sprint_state["sprintengine"]["name"] == "fixture-loop-m2"
    assert "Final goal: Verify M1 behavior" in sprint_state["sprintengine"]["goal"]
    assert "Milestone M2: Milestone lifecycle and task model" in sprint_state["sprintengine"]["goal"]
    assert [task["role"] for task in sprint_state["tasks"][:2]] == ["product", "architect"]


def test_milestone_start_can_link_current_active_milestone_idempotently(tmp_path: Path) -> None:
    state_path = tmp_path / "multiloop" / "fixture-loop" / "state.json"
    write_state(state_path, base_state())
    cli = MultiloopCli(tmp_path, state_path)

    first = cli.run("milestone", "start", "M1")
    second = cli.run("milestone", "start", "M1")

    assert "Started milestone: M1 [active]" in first.stdout
    assert "Started milestone: M1 [active]" in second.stdout
    state = read_state(state_path)
    assert state["roadmap"][0]["sprintEngine"]["statePath"] == ".multi-code/sprintengine/fixture-loop-m1/state.yaml"
    assert (tmp_path / ".multi-code" / "sprintengine" / "fixture-loop-m1" / "state.yaml").is_file()


def test_state_validation_accepts_sprintengine_links_and_rejects_machine_paths() -> None:
    state = base_state()
    state["roadmap"][0]["sprintEngine"] = {
        "teamSlug": "fixture-loop-m1",
        "statePath": ".multi-code/sprintengine/fixture-loop-m1/state.yaml",
        "planPath": ".multi-code/sprintengine/fixture-loop-m1/plan.md",
    }
    validate_state(state)

    absolute_state = deepcopy(state)
    absolute_state["roadmap"][0]["sprintEngine"]["statePath"] = "/home/ada/project/.multi-code/sprintengine/x/state.yaml"
    with pytest.raises(StateValidationError, match="expected project-relative path"):
        validate_state(absolute_state)

    wrong_location = deepcopy(state)
    wrong_location["roadmap"][0]["sprintEngine"]["statePath"] = "sprintengine/x/state.yaml"
    with pytest.raises(StateValidationError, match=r"expected \.multi-code/sprintengine/<team>/state.yaml"):
        validate_state(wrong_location)
