"""Task `phases` + run-level `defaultPhases` (MC-1542 Stage 0).

`defaultPhases` is the operator's one lever over the review step: it is both the
default a task inherits and the ceiling a task may not exceed. These tests pin
that asymmetry, the `[]` (no-review) mode, and the TS/Python enum parity that is
this subsystem's known bug class.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from helpers import REPO_ROOT, create_team, read_state, task, write_state
from sprintengine_core import store as folder_store
from sprintengine_core.tool import constants


# --- enum parity ------------------------------------------------------------


def test_phase_vocabulary_matches_across_python_modules() -> None:
    """store.py and tool/constants.py cannot import each other (cycle), so the
    phase vocabulary is duplicated. Drift here is the known bug class."""
    assert folder_store.VALID_TASK_PHASES == constants.VALID_TASK_PHASES
    assert folder_store.DEFAULT_RUN_PHASES == constants.DEFAULT_RUN_PHASES


def test_phase_vocabulary_matches_the_renderer() -> None:
    """The renderer keeps its own copy of the phase vocabulary; pin it to Python."""
    source = (REPO_ROOT / "src/shared/sprintengine/state.ts").read_text(encoding="utf-8")
    match = re.search(r"export const sprintEngineTaskPhases = \[([^\]]*)\] as const", source)
    assert match, "sprintEngineTaskPhases not found in src/shared/sprintengine/state.ts"
    phases = tuple(value.strip().strip("'\"") for value in match.group(1).split(",") if value.strip())
    assert phases == folder_store.VALID_TASK_PHASES


# --- normalize_phase_list ---------------------------------------------------


def test_normalize_phase_list_dedups_and_preserves_order() -> None:
    assert folder_store.normalize_phase_list(["review", "review"], field="x") == ["review"]
    assert folder_store.normalize_phase_list([], field="x") == []
    assert folder_store.normalize_phase_list(["", "  "], field="x") == []


def test_normalize_phase_list_rejects_unknown_phase_and_non_list() -> None:
    with pytest.raises(ValueError, match="unknown phase 'testing'"):
        folder_store.normalize_phase_list(["testing"], field="x")
    with pytest.raises(ValueError, match="must be an array"):
        folder_store.normalize_phase_list("review", field="x")


# --- run_default_phases -----------------------------------------------------


def test_absent_default_phases_reads_as_the_engine_default() -> None:
    assert folder_store.run_default_phases({}) == ["review"]


def test_explicit_empty_default_phases_is_honoured() -> None:
    """`[]` is a legitimate cheap-and-fast mode, not an absent key."""
    assert folder_store.run_default_phases({"defaultPhases": []}) == []


# --- init + round-trip ------------------------------------------------------


def test_default_phases_round_trips_through_run_yaml_and_projection(tmp_path: Path) -> None:
    fixture = create_team(tmp_path, "phase-roundtrip", [task("T1", "Work", "developer")])
    state = read_state(fixture.state_path)
    state["defaultPhases"] = []
    write_state(fixture.state_path, state)

    run = folder_store.load_run_yaml(fixture.team_dir)
    assert run["defaultPhases"] == []
    assert folder_store.run_default_phases(read_state(fixture.state_path)) == []

    projection = json.loads((fixture.team_dir / folder_store.PROJECTION_FILE).read_text(encoding="utf-8"))
    assert projection["run"]["defaultPhases"] == []


def test_absent_default_phases_stays_absent_in_run_yaml(tmp_path: Path) -> None:
    fixture = create_team(tmp_path, "phase-absent", [task("T1", "Work", "developer")])
    run = folder_store.load_run_yaml(fixture.team_dir)
    assert "defaultPhases" not in run

    projection = json.loads((fixture.team_dir / folder_store.PROJECTION_FILE).read_text(encoding="utf-8"))
    assert "defaultPhases" not in projection["run"]


def test_init_default_phases_json_flag_records_the_run_phase_list(tmp_path: Path) -> None:
    from sprintengine_core.tool.state import apply_default_phases

    state: dict = {}
    apply_default_phases(state, None)
    assert "defaultPhases" not in state

    apply_default_phases(state, "  ")
    assert "defaultPhases" not in state

    apply_default_phases(state, "[]")
    assert state["defaultPhases"] == []

    apply_default_phases(state, '["review"]')
    assert state["defaultPhases"] == ["review"]

    with pytest.raises(SystemExit, match="unknown phase 'product'"):
        apply_default_phases(state, '["product"]')


# --- per-task phases + ceiling ----------------------------------------------


def test_parse_phases_arg_handles_cli_string_mcp_array_and_absence() -> None:
    from sprintengine_core.tool.tasks import parse_phases_arg

    assert parse_phases_arg(None) is None
    assert parse_phases_arg("") == []
    assert parse_phases_arg("review") == ["review"]
    assert parse_phases_arg(["review"]) == ["review"]
    assert parse_phases_arg([]) == []
    # A bare string is never spread char-by-char (the house array-field scar tissue).
    with pytest.raises(SystemExit):
        parse_phases_arg(["r", "e", "v"])


def test_task_phases_default_to_the_run_and_may_be_trimmed(tmp_path: Path) -> None:
    from sprintengine_core.tool.tasks import resolve_task_phases

    state = {"defaultPhases": ["review"]}
    assert resolve_task_phases(state, {"id": "T1"}) == ["review"]
    assert resolve_task_phases(state, {"id": "T1", "phases": []}) == []
    assert resolve_task_phases({}, {"id": "T1"}) == ["review"]


def test_task_may_not_add_a_phase_outside_the_run_ceiling() -> None:
    from sprintengine_core.tool.tasks import assert_phases_within_run_ceiling

    assert_phases_within_run_ceiling({"defaultPhases": ["review"]}, ["review"], "T1")
    assert_phases_within_run_ceiling({"defaultPhases": ["review"]}, [], "T1")
    with pytest.raises(SystemExit, match="phase_not_configured_for_run"):
        assert_phases_within_run_ceiling({"defaultPhases": []}, ["review"], "T1")


def test_plan_add_task_records_trimmed_phases(tmp_path: Path) -> None:
    fixture = create_team(tmp_path, "phase-plan", [])
    state = read_state(fixture.state_path)
    state["sprintengine"]["rosterConfigured"] = True
    state["agents"] = {"developer-1": {"role": "developer", "status": "idle"}}
    write_state(fixture.state_path, state)

    payload = fixture.cli.run("plan", "add-task", "--title", "Docs only", "--role", "developer", "--phases", "")
    assert payload["task"]["phases"] == []

    inherited = fixture.cli.run("plan", "add-task", "--title", "Real work", "--role", "developer")
    assert "phases" not in inherited["task"]


def test_plan_add_task_rejects_a_phase_outside_the_run_ceiling(tmp_path: Path) -> None:
    fixture = create_team(tmp_path, "phase-ceiling", [])
    state = read_state(fixture.state_path)
    state["sprintengine"]["rosterConfigured"] = True
    state["agents"] = {"developer-1": {"role": "developer", "status": "idle"}}
    state["defaultPhases"] = []
    write_state(fixture.state_path, state)

    rejected = fixture.cli.run_failure(
        "plan", "add-task", "--title", "Sneaky review", "--role", "developer", "--phases", "review"
    )
    assert "phase_not_configured_for_run" in rejected.stderr


# --- pre-MC-1542 store rejection --------------------------------------------


def test_pre_1542_run_store_is_rejected_loudly(tmp_path: Path) -> None:
    """Decision 8: old stores are rejected, never migrated. The message must name
    the remedy at every surface that reads a store."""
    fixture = create_team(tmp_path, "old-store", [task("T1", "Work", "developer")])
    run_path = fixture.team_dir / folder_store.RUN_FILE
    run = folder_store.load_run_yaml(fixture.team_dir)
    run["schemaVersion"] = 1
    folder_store.atomic_write_yaml(run_path, run)

    with pytest.raises(folder_store.RunStoreVersionError) as loader_error:
        folder_store.state_from_folder_store(fixture.team_dir)
    assert "predates a breaking change" in str(loader_error.value)
    assert "Delete" in str(loader_error.value)
    assert str(fixture.team_dir) in str(loader_error.value)

    with pytest.raises(folder_store.RunStoreVersionError):
        folder_store.build_projection(fixture.team_dir)


def test_missing_schema_version_reads_as_pre_1542(tmp_path: Path) -> None:
    fixture = create_team(tmp_path, "no-version", [task("T1", "Work", "developer")])
    run_path = fixture.team_dir / folder_store.RUN_FILE
    run = folder_store.load_run_yaml(fixture.team_dir)
    run.pop("schemaVersion", None)
    folder_store.atomic_write_yaml(run_path, run)

    with pytest.raises(folder_store.RunStoreVersionError):
        folder_store.state_from_folder_store(fixture.team_dir)


def test_fresh_store_is_stamped_with_the_current_schema_version(tmp_path: Path) -> None:
    fixture = create_team(tmp_path, "fresh-store", [task("T1", "Work", "developer")])
    run = folder_store.load_run_yaml(fixture.team_dir)
    assert run["schemaVersion"] == folder_store.RUN_SCHEMA_VERSION == 3


def test_projection_carries_the_store_schema_version(tmp_path: Path) -> None:
    """The renderer reads projection.json off disk without calling Python, so the
    version must ride the projection or the app cannot reject an old store."""
    fixture = create_team(tmp_path, "projection-version", [task("T1", "Work", "developer")])
    projection = json.loads((fixture.team_dir / folder_store.PROJECTION_FILE).read_text(encoding="utf-8"))
    assert projection["run"]["schemaVersion"] == folder_store.RUN_SCHEMA_VERSION


def test_store_schema_version_matches_the_main_process_mirror() -> None:
    """`SPRINT_ENGINE_RUN_SCHEMA_VERSION` in src/main/sprintengine-artifacts.ts is
    what actually rejects a stale store at the app surfaces. Pin the pair."""
    source = (REPO_ROOT / "src/main/sprintengine-artifacts.ts").read_text(encoding="utf-8")
    match = re.search(r"export const SPRINT_ENGINE_RUN_SCHEMA_VERSION = (\d+)", source)
    assert match, "SPRINT_ENGINE_RUN_SCHEMA_VERSION not found in src/main/sprintengine-artifacts.ts"
    assert int(match.group(1)) == folder_store.RUN_SCHEMA_VERSION


def test_approval_tasks_carry_an_explicit_empty_phase_list() -> None:
    """Regression: the plan-approval and product-intake tasks are approval surfaces,
    not implementation work. Left to inherit `defaultPhases`, their author would end
    up self-reviewing a plan document, and the draft placeholder would survive."""
    source = (REPO_ROOT / "sprintengine_core/tool/plans.py").read_text(encoding="utf-8")
    # Both `normalize_task({...})` literals must set `phases: []`.
    assert source.count('"phases": [],') == 2, (
        "ensure_plan_approval_gate and ensure_product_intake_gate must each pin `phases: []`"
    )


def test_pre_1542_store_raises_a_readable_cli_error_not_a_traceback(tmp_path: Path) -> None:
    """The CLI/MCP boundary converts the loader's ValueError into a clean SystemExit."""
    from sprintengine_core.tool.state import load_mutation_state

    fixture = create_team(tmp_path, "cli-old-store", [task("T1", "Work", "developer")])
    run = folder_store.load_run_yaml(fixture.team_dir)
    run["schemaVersion"] = 1
    folder_store.atomic_write_yaml(fixture.team_dir / folder_store.RUN_FILE, run)

    with pytest.raises(SystemExit) as error:
        load_mutation_state(fixture.state_path)
    assert "predates a breaking change" in str(error.value.code)
