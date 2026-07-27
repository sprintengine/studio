"""Engine coverage for the operator `roster runtime` mutation (MC-1516).

`roster runtime --role --cli [--model] --actor ui` is the app-owned, user-driven
mid-run edit of one role's execution runtime. It applies to any run and is legal
after plan approval. The merge lands in `roleRuntimes` in run.yaml and re-emits
on the projection, so future spawns and claims resolve the new runtime.
"""
from __future__ import annotations

import json
from pathlib import Path

from sprintengine_core import store as folder_store
from helpers import SwarmCli, read_state


def _workspace(tmp_path: Path):
    root = tmp_path / "project"
    root.mkdir(parents=True, exist_ok=True)
    state_path = root / ".multi-code" / "sprintengine" / "runtime-edit" / "run.yaml"
    return root, state_path


def _init_user_run(cli: SwarmCli) -> dict:
    # Mirrors a wizard-created user-composed run: architect + developer enabled,
    # both with an explicit runtime.
    return cli.run(
        "init",
        "--name", "runtime-edit",
        "--goal", "Edit role runtimes mid-run",
        "--agent", "architect:architect",
        "--configured-roles-json", json.dumps(["architect", "developer"]),
        "--role-runtimes-json", json.dumps({
            "architect": {"cli": "claude-code", "model": "claude-fable-5"},
            "developer": {"cli": "claude-code", "model": "claude-sonnet-5"},
        }),
    )


def test_runtime_edit_updates_run_yaml_projection_and_events(tmp_path) -> None:
    root, state_path = _workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    _init_user_run(cli)

    result = cli.run(
        "roster", "runtime",
        "--role", "architect",
        "--cli", "claude-code",
        "--model", "claude-opus-4-8",
        "--actor", "ui",
    )
    assert result["ok"] is True
    assert result["role"] == "architect"
    assert result["runtime"] == {"cli": "claude-code", "model": "claude-opus-4-8"}
    assert result["previous"] == {"cli": "claude-code", "model": "claude-fable-5"}

    # Canonical in run.yaml; unmentioned roles preserved by the merge.
    run = folder_store.load_run_yaml(state_path.parent)
    assert run["roleRuntimes"]["architect"] == {"cli": "claude-code", "model": "claude-opus-4-8"}
    assert run["roleRuntimes"]["developer"] == {"cli": "claude-code", "model": "claude-sonnet-5"}

    # Re-emits on the projection the renderer polls.
    state = read_state(state_path)
    projection = folder_store.build_projection(state_path.parent, state_path=state_path)
    assert projection["run"]["roleRuntimes"]["architect"]["model"] == "claude-opus-4-8"

    # Recorded on the run history with the operator actor and the previous value.
    events = [event for event in state["events"] if event.get("type") == "role_runtime_changed"]
    assert events, "expected a role_runtime_changed event"
    assert events[-1]["actor"] == "ui"
    assert events[-1]["previous"] == {"cli": "claude-code", "model": "claude-fable-5"}


def test_runtime_edit_without_model_pins_cli_default(tmp_path) -> None:
    root, state_path = _workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    _init_user_run(cli)

    result = cli.run(
        "roster", "runtime",
        "--role", "developer",
        "--cli", "claude-code",
        "--actor", "ui",
    )
    # Model cleared: the role launches with no --model flag (the CLI's default).
    assert result["runtime"] == {"cli": "claude-code"}
    run = folder_store.load_run_yaml(state_path.parent)
    assert run["roleRuntimes"]["developer"] == {"cli": "claude-code"}


def test_runtime_edit_rejects_unknown_role(tmp_path) -> None:
    root, state_path = _workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    _init_user_run(cli)

    failure = cli.run_failure(
        "roster", "runtime", "--role", "wizard", "--cli", "claude-code", "--actor", "ui",
    )
    assert "unknown role" in (failure.stdout + failure.stderr)


def test_runtime_edit_rejects_role_not_enabled_for_run(tmp_path) -> None:
    root, state_path = _workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    _init_user_run(cli)

    failure = cli.run_failure(
        "roster", "runtime", "--role", "tester", "--cli", "claude-code", "--actor", "ui",
    )
    assert "role_not_enabled_for_run" in (failure.stdout + failure.stderr)


def test_runtime_edit_requires_cli(tmp_path) -> None:
    root, state_path = _workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    _init_user_run(cli)

    failure = cli.run_failure(
        "roster", "runtime", "--role", "developer", "--cli", "", "--actor", "ui",
    )
    assert "requires --cli" in (failure.stdout + failure.stderr)


def test_runtime_edit_on_legacy_run_without_configured_roles(tmp_path) -> None:
    # Legacy/headless runs have no configuredRoles; the enabled-set guard no-ops
    # and the edit still lands (matching the rest of the roster boundary).
    root, state_path = _workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    cli.run("init", "--name", "runtime-edit", "--goal", "Legacy run")

    result = cli.run(
        "roster", "runtime",
        "--role", "developer",
        "--cli", "claude-code",
        "--model", "claude-haiku-4-5",
        "--actor", "ui",
    )
    assert result["ok"] is True
    run = folder_store.load_run_yaml(state_path.parent)
    assert run["roleRuntimes"]["developer"] == {"cli": "claude-code", "model": "claude-haiku-4-5"}
