"""Engine coverage for the operator `roster enable` mutation (MC-1593).

`roster enable --role [--cli --model] --actor ui` is the app-owned, user-driven
mid-run "Add a role" from the board. It is additive-only: the union never drops a
role. Like `roster runtime`, it applies to any run and is legal after plan
approval. A run with no configuredRoles is legacy/unconstrained — every role is already legal, so no
list is written.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from helpers import SwarmCli, read_state


def _workspace(tmp_path: Path):
    root = tmp_path / "project"
    root.mkdir(parents=True, exist_ok=True)
    state_path = root / ".multi-code" / "sprintengine" / "role-enable" / "run.yaml"
    return root, state_path


def _init_user_run(cli: SwarmCli) -> dict:
    return cli.run(
        "init",
        "--name", "role-enable",
        "--goal", "Enable roles mid-run",
        "--agent", "architect:architect",
        "--configured-roles-json", json.dumps(["architect", "developer"]),
        "--role-runtimes-json", json.dumps({
            "architect": {"cli": "claude-code", "model": "claude-fable-5"},
            "developer": {"cli": "claude-code", "model": "claude-sonnet-5"},
        }),
    )


def test_enable_appends_role_and_seeds_runtime(tmp_path) -> None:
    root, state_path = _workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    _init_user_run(cli)

    result = cli.run(
        "roster", "enable",
        "--role", "tester",
        "--cli", "claude-code",
        "--model", "claude-haiku-4-5",
        "--actor", "ui",
    )
    assert result["ok"] is True
    assert result["role"] == "tester"
    assert result["alreadyEnabled"] is False
    assert result["configuredRoles"] == ["architect", "developer", "tester"]

    state = read_state(state_path)
    assert state["configuredRoles"] == ["architect", "developer", "tester"]
    assert state["roleRuntimes"]["tester"] == {"cli": "claude-code", "model": "claude-haiku-4-5"}
    # Existing runtimes preserved by the merge.
    assert state["roleRuntimes"]["developer"] == {"cli": "claude-code", "model": "claude-sonnet-5"}

    events = [event for event in state["events"] if event.get("type") == "role_enabled"]
    assert len(events) == 1
    assert events[0]["actor"] == "ui"
    assert events[0]["role"] == "tester"


def test_enable_is_additive_and_idempotent(tmp_path) -> None:
    root, state_path = _workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    _init_user_run(cli)

    first = cli.run("roster", "enable", "--role", "tester", "--actor", "ui")
    assert first["alreadyEnabled"] is False
    again = cli.run("roster", "enable", "--role", "tester", "--actor", "ui")
    assert again["alreadyEnabled"] is True
    assert again["configuredRoles"] == ["architect", "developer", "tester"]

    # No runtime seeded when --cli was omitted.
    state = read_state(state_path)
    assert "tester" not in (state.get("roleRuntimes") or {})


def test_enable_makes_role_tasks_addable_and_claimable(tmp_path) -> None:
    """The point of the board control: after enable, the role's tasks pass the
    configuredRoles boundary at plan.add_task and a worker of that role can
    join — the exact operations the engine rejects for a non-enabled role."""
    root, state_path = _workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    _init_user_run(cli)

    with pytest.raises(AssertionError):
        cli.run("plan", "add-task", "--title", "Verify the build", "--role", "tester")

    cli.run("roster", "enable", "--role", "tester", "--actor", "ui")
    added = cli.run("plan", "add-task", "--title", "Verify the build", "--role", "tester")
    assert added["task"]["role"] == "tester"

    joined = cli.run("join", "--role", "tester", "--id", "tester-1")
    assert joined["ok"] is True


def test_enable_skips_list_write_on_unconstrained_run(tmp_path) -> None:
    """A legacy run with no configuredRoles admits every role already; writing a
    one-element list would suddenly constrain it."""
    root, state_path = _workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    cli.run(
        "init",
        "--name", "role-enable-legacy",
        "--goal", "Legacy unconstrained run",
        "--agent", "architect:architect",
    )
    state = read_state(state_path)
    assert not state.get("configuredRoles")

    result = cli.run("roster", "enable", "--role", "tester", "--actor", "ui")
    assert result["ok"] is True
    assert result["alreadyEnabled"] is True

    state = read_state(state_path)
    assert not state.get("configuredRoles")
