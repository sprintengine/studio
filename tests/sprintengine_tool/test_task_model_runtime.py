"""Per-task CLI model attribution (MC-1448).

Tasks record the CLI model/CLI that worked them, resolved at claim from the
run's per-role runtime map (written at init from the roster's model selection)
or an explicit --model/--cli override. See sprintengine_core.tool.state
(assign_task / apply_role_runtimes / role_runtime).
"""

from __future__ import annotations

import json

from helpers import create_team, get_task, read_state, task, write_state
from sprintengine_core import store as store_module
from sprintengine_core.tool import state as state_module
from sprintengine_core.tool.tasks import normalize_task


def test_normalize_task_preserves_model_and_cli() -> None:
    normalized = normalize_task(
        {"id": "T1", "title": "x", "role": "developer", "model": "  claude-fable-5 ", "cli": "claude-code"}
    )
    assert normalized["model"] == "claude-fable-5"
    assert normalized["cli"] == "claude-code"


def test_normalize_task_defaults_model_and_cli_to_none() -> None:
    normalized = normalize_task({"id": "T1", "title": "x", "role": "developer"})
    assert normalized["model"] is None
    assert normalized["cli"] is None


def test_apply_role_runtimes_parses_and_drops_default_only_roles() -> None:
    st: dict = {}
    state_module.apply_role_runtimes(
        st,
        json.dumps(
            {
                "developer": {"model": "claude-fable-5", "cli": "claude-code"},
                "security": {"model": "opus[1m]", "cli": "claude-code"},
                "tester": {"model": "", "cli": ""},  # CLI default -> recorded as nothing
            }
        ),
    )
    assert st["roleRuntimes"] == {
        "developer": {"model": "claude-fable-5", "cli": "claude-code"},
        "security": {"model": "opus[1m]", "cli": "claude-code"},
    }


def test_apply_role_runtimes_ignores_empty_input() -> None:
    st: dict = {}
    state_module.apply_role_runtimes(st, None)
    state_module.apply_role_runtimes(st, "")
    assert "roleRuntimes" not in st


def test_assign_task_stamps_from_role_runtime_map() -> None:
    st = {"agents": {}, "roleRuntimes": {"developer": {"model": "claude-fable-5", "cli": "claude-code"}}}
    tsk = {"id": "T1", "role": "developer", "status": "todo"}
    state_module.assign_task(st, tsk, "developer-1")
    assert tsk["model"] == "claude-fable-5"
    assert tsk["cli"] == "claude-code"


def test_assign_task_explicit_override_beats_role_runtime_map() -> None:
    st = {"agents": {}, "roleRuntimes": {"developer": {"model": "claude-fable-5", "cli": "claude-code"}}}
    tsk = {"id": "T1", "role": "developer", "status": "todo"}
    state_module.assign_task(st, tsk, "developer-1", model="custom-x", cli="opencode")
    assert tsk["model"] == "custom-x"
    assert tsk["cli"] == "opencode"


def test_assign_task_records_nothing_for_cli_default_role() -> None:
    st = {"agents": {}, "roleRuntimes": {}}
    tsk = {"id": "T1", "role": "developer", "status": "todo"}
    state_module.assign_task(st, tsk, "developer-1")
    assert "model" not in tsk and "cli" not in tsk


def test_stamp_task_execution_identity_helper() -> None:
    st = {"roleRuntimes": {"developer": {"model": "claude-fable-5", "cli": "claude-code"}}}
    # role-map path
    a = {"id": "A", "role": "developer"}
    state_module.stamp_task_execution_identity(st, a)
    assert a["model"] == "claude-fable-5" and a["cli"] == "claude-code"
    # explicit override beats the map
    b = {"id": "B", "role": "developer"}
    state_module.stamp_task_execution_identity(st, b, model="opus[1m]")
    assert b["model"] == "opus[1m]" and b["cli"] == "claude-code"
    # no runtime + no override -> nothing stamped, no clobber
    c = {"id": "C", "role": "unknown_role", "model": "prior"}
    state_module.stamp_task_execution_identity(st, c)
    assert c["model"] == "prior" and "cli" not in c


def test_role_runtimes_survive_folder_store_round_trip(tmp_path) -> None:
    fixture = create_team(tmp_path, "runtime-round-trip", [task("T1", "Build", "developer")])
    state = read_state(fixture.state_path)
    state["roleRuntimes"] = {"developer": {"model": "claude-fable-5", "cli": "claude-code"}}
    write_state(fixture.state_path, state)

    reloaded = read_state(fixture.state_path)
    assert reloaded["roleRuntimes"] == {"developer": {"model": "claude-fable-5", "cli": "claude-code"}}


def test_projection_emits_role_runtimes(tmp_path) -> None:
    fixture = create_team(tmp_path, "projection-role-runtimes", [task("T1", "Build", "developer")])
    state = read_state(fixture.state_path)
    state["roleRuntimes"] = {"developer": {"model": "claude-fable-5", "cli": "claude-code"}}
    write_state(fixture.state_path, state)

    projection = store_module.build_projection(fixture.state_path.parent, state_path=fixture.state_path)
    assert projection["run"]["roleRuntimes"] == {
        "developer": {"model": "claude-fable-5", "cli": "claude-code"}
    }


def test_projection_role_runtimes_empty_for_legacy_run(tmp_path) -> None:
    fixture = create_team(tmp_path, "projection-legacy-runtimes", [task("T1", "Build", "developer")])
    state = read_state(fixture.state_path)
    state.pop("roleRuntimes", None)
    write_state(fixture.state_path, state)

    projection = store_module.build_projection(fixture.state_path.parent, state_path=fixture.state_path)
    assert projection["run"]["roleRuntimes"] == {}


def test_projection_emits_configured_roles(tmp_path) -> None:
    fixture = create_team(tmp_path, "projection-configured-roles", [task("T1", "Build", "developer")])
    state = read_state(fixture.state_path)
    state["configuredRoles"] = ["architect", "developer", "security", "tester"]
    write_state(fixture.state_path, state)

    projection = store_module.build_projection(fixture.state_path.parent, state_path=fixture.state_path)
    assert projection["run"]["configuredRoles"] == [
        "architect",
        "developer",
        "security",
        "tester",
    ]


def test_projection_configured_roles_null_for_legacy_run(tmp_path) -> None:
    fixture = create_team(tmp_path, "projection-legacy-configured-roles", [task("T1", "Build", "developer")])
    state = read_state(fixture.state_path)
    state.pop("configuredRoles", None)
    write_state(fixture.state_path, state)

    projection = store_module.build_projection(fixture.state_path.parent, state_path=fixture.state_path)
    assert projection["run"]["configuredRoles"] is None


def test_projection_emits_source_and_source_bundle(tmp_path) -> None:
    fixture = create_team(tmp_path, "projection-source", [task("T1", "Build", "developer")])
    state = read_state(fixture.state_path)
    state["source"] = {
        "kind": "markdown",
        "origin": "file",
        "planKind": "epic",
        "path": "product-requirements.md",
        "originalPath": "docs/plan.md",
        "capturedAt": "2026-07-05T00:00:00Z",
    }
    state["sourceBundle"] = [
        {
            "kind": "html_mockup",
            "origin": "reference",
            "path": "docs/mockup.html",
            "capturedAt": "2026-07-05T00:00:00Z",
        }
    ]
    write_state(fixture.state_path, state)

    projection = store_module.build_projection(fixture.state_path.parent, state_path=fixture.state_path)
    assert projection["run"]["source"] == state["source"]
    assert projection["run"]["sourceBundle"] == state["sourceBundle"]


def test_projection_omits_source_keys_for_legacy_run(tmp_path) -> None:
    fixture = create_team(tmp_path, "projection-legacy-source", [task("T1", "Build", "developer")])
    state = read_state(fixture.state_path)
    state.pop("source", None)
    state.pop("sourceBundle", None)
    write_state(fixture.state_path, state)

    projection = store_module.build_projection(fixture.state_path.parent, state_path=fixture.state_path)
    assert "source" not in projection["run"]
    assert "sourceBundle" not in projection["run"]


def test_claim_stamps_model_from_role_runtime_map(tmp_path) -> None:
    fixture = create_team(tmp_path, "claim-role-model", [task("T1", "Build", "developer")])
    state = read_state(fixture.state_path)
    state["roleRuntimes"] = {"developer": {"model": "claude-fable-5", "cli": "claude-code"}}
    write_state(fixture.state_path, state)

    payload = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")
    assert payload["claimed"] is True

    claimed = get_task(read_state(fixture.state_path), "T1")
    assert claimed["model"] == "claude-fable-5"
    assert claimed["cli"] == "claude-code"


def test_claim_model_flag_overrides_role_runtime_map(tmp_path) -> None:
    fixture = create_team(tmp_path, "claim-flag-override", [task("T1", "Build", "developer")])
    state = read_state(fixture.state_path)
    state["roleRuntimes"] = {"developer": {"model": "claude-fable-5", "cli": "claude-code"}}
    write_state(fixture.state_path, state)

    fixture.cli.run("task", "claim", "--task-id", "T1", "--id", "developer-1", "--model", "opus[1m]", "--cli", "claude-code")

    claimed = get_task(read_state(fixture.state_path), "T1")
    assert claimed["model"] == "opus[1m]"
    assert claimed["cli"] == "claude-code"


def test_model_survives_handoff_after_owner_cleared(tmp_path) -> None:
    # ownerAgentId is cleared when a task reaches `done`; the model must remain —
    # that is the whole point of stamping it on the task record.
    fixture = create_team(tmp_path, "model-after-handoff", [task("T1", "Build", "developer")])
    state = read_state(fixture.state_path)
    state["roleRuntimes"] = {"developer": {"model": "claude-fable-5", "cli": "claude-code"}}
    write_state(fixture.state_path, state)

    fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")
    fixture.cli.run(
        "task", "publish", "--task-id", "T1", "--id", "developer-1", "--summary", "done",
    )

    # Publish routes the task into review and it STAYS owned (MC-1542 decision 1).
    reviewing = get_task(read_state(fixture.state_path), "T1")
    assert reviewing["status"] == "review"
    assert reviewing["ownerAgentId"] == "developer-1"
    assert reviewing["model"] == "claude-fable-5"

    fixture.cli.run(
        "task", "advance",
        "--task-id", "T1", "--id", "developer-1",
        "--phase", "review", "--outcome", "pass", "--summary", "self-reviewed",
    )

    published = get_task(read_state(fixture.state_path), "T1")
    assert published["status"] == "done"
    assert published.get("ownerAgentId") in (None, "")
    assert published["model"] == "claude-fable-5"
    assert published["cli"] == "claude-code"


def test_product_intake_task_stamped_on_claim(tmp_path) -> None:
    # The architect plan-gate and product-intake tasks are activated outside the
    # worker claim loop; confirm the product-intake task (T0) still records its
    # role's model when the product agent claims it. Regression for the gap where
    # only worker tasks were stamped.
    team_dir = tmp_path / ".multi-code" / "sprintengine" / "init-gates"
    state_path = team_dir / "run.yaml"
    from helpers import SwarmCli

    cli = SwarmCli(state_path)
    cli.run(
        "init",
        "--name", "init-gates",
        "--agent", "architect:architect-1",
        "--agent", "product:product-1",
        "--role-runtimes-json",
        json.dumps({"product": {"model": "claude-fable-5", "cli": "claude-code"}}),
    )
    cli.run("task", "next", "--role", "product", "--id", "product-1")

    intake = get_task(read_state(state_path), "T0")
    assert intake["role"] == "product"
    assert intake["model"] == "claude-fable-5"
    assert intake["cli"] == "claude-code"


def test_init_role_runtimes_json_persists(tmp_path) -> None:
    team_dir = tmp_path / ".multi-code" / "sprintengine" / "init-runtimes"
    state_path = team_dir / "run.yaml"
    from helpers import SwarmCli

    cli = SwarmCli(state_path)
    cli.run(
        "init",
        "--name",
        "init-runtimes",
        "--agent",
        "developer:developer-1",
        "--role-runtimes-json",
        json.dumps({"developer": {"model": "claude-fable-5", "cli": "claude-code"}}),
    )

    state = read_state(state_path)
    assert state["roleRuntimes"] == {"developer": {"model": "claude-fable-5", "cli": "claude-code"}}


# --- the seat reasoning-effort level (MC-1885) ------------------------------
# The level rides the existing `roleRuntimes` entry as an optional member, so the
# run-state SHAPE the engine validates is unchanged and RUN_SCHEMA_VERSION stays
# put. These prove the passthrough rather than assuming it.


def test_apply_role_runtimes_carries_the_reasoning_level() -> None:
    st: dict = {}
    state_module.apply_role_runtimes(
        st,
        json.dumps(
            {
                "developer": {"model": "claude-opus-5", "cli": "claude-code", "reasoning": "high"},
                "tester": {"model": "", "cli": "claude-code", "reasoning": "  "},
                # A level with no model and no cli has no seat to launch.
                "security": {"reasoning": "max"},
            }
        ),
    )
    assert st["roleRuntimes"] == {
        "developer": {"model": "claude-opus-5", "cli": "claude-code", "reasoning": "high"},
        "tester": {"cli": "claude-code"},
    }


def test_role_runtime_edit_preserves_a_level_it_does_not_mention() -> None:
    # `roster runtime` (the board's mid-run cli/model edit) sends only cli+model.
    # Replacing the entry wholesale would silently drop the configured level.
    st: dict = {}
    state_module.apply_role_runtimes(
        st, json.dumps({"developer": {"model": "claude-opus-5", "cli": "claude-code", "reasoning": "high"}})
    )
    state_module.apply_role_runtimes(
        st, json.dumps({"developer": {"model": "claude-sonnet-5", "cli": "claude-code"}})
    )
    assert st["roleRuntimes"]["developer"] == {
        "model": "claude-sonnet-5",
        "cli": "claude-code",
        "reasoning": "high",
    }
    # An explicit null clears it back to the CLI's own default effort.
    state_module.apply_role_runtimes(
        st, json.dumps({"developer": {"model": "claude-sonnet-5", "cli": "claude-code", "reasoning": None}})
    )
    assert st["roleRuntimes"]["developer"] == {"model": "claude-sonnet-5", "cli": "claude-code"}


def test_seat_reasoning_level_survives_init_and_projection_round_trip(tmp_path) -> None:
    team_dir = tmp_path / ".multi-code" / "sprintengine" / "init-reasoning"
    state_path = team_dir / "run.yaml"
    from helpers import SwarmCli

    cli = SwarmCli(state_path)
    cli.run(
        "init",
        "--name",
        "init-reasoning",
        "--agent",
        "developer:developer-1",
        "--role-runtimes-json",
        json.dumps({"developer": {"model": "claude-opus-5", "cli": "claude-code", "reasoning": "high"}}),
    )

    state = read_state(state_path)
    assert state["roleRuntimes"] == {
        "developer": {"model": "claude-opus-5", "cli": "claude-code", "reasoning": "high"}
    }

    projection = store_module.build_projection(state_path.parent, state_path=state_path)
    assert projection["run"]["roleRuntimes"] == {
        "developer": {"model": "claude-opus-5", "cli": "claude-code", "reasoning": "high"}
    }, "the level reaches the app through the projection, so no schema bump is needed"
    assert projection["run"]["schemaVersion"] == store_module.RUN_SCHEMA_VERSION
