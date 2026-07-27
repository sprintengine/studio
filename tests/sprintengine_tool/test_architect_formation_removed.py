"""MC-1889: the architect-decides-staffing formation is gone, end to end.

The wizard's third team setup — user ticks a model palette, the architect surveys
the objective and staffs from it — is removed. With it go the `--roster-source`
and `--allowed-runtimes-json` init flags, the `rosterSource` / `allowedRuntimes`
run keys, and `sprintengine.roster.configure` (the mutation that only ever
applied to that formation).

What survives, pinned below: the architect ROLE. A roles-formation run staffing
an architect still plans through the architect, and a no-roles run still plans
through a general. Legacy run.yamls carrying the retired keys must still load.
"""
from __future__ import annotations

import json
from pathlib import Path

import yaml

from sprintengine_core import store as folder_store
from sprintengine_core.tool.plans import resolve_planning_role
from sprintengine_mcp import SprintEngineMcpServer
from sprintengine_mcp.schemas import MCP_V1_CONTRACT_SCHEMAS, TOOL_SCHEMAS
from helpers import SwarmCli, read_state


def _workspace(tmp_path: Path, name: str = "formation"):
    root = tmp_path / "project"
    root.mkdir(parents=True, exist_ok=True)
    return root, root / ".multi-code" / "sprintengine" / name / "run.yaml"


# --------------------------------------------------------------------------- #
# The formation's inputs are gone from the CLI surface
# --------------------------------------------------------------------------- #

def test_init_rejects_the_retired_formation_flags(tmp_path) -> None:
    # An unknown CLI flag is FATAL (unlike an unknown run.yaml key, which is
    # inert), so this is the seam that proves the app can no longer send them.
    root, state_path = _workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)

    for flag, value in (
        ("--roster-source", "architect"),
        ("--allowed-runtimes-json", json.dumps([{"cli": "claude-code", "model": None}])),
    ):
        failure = cli.run_failure("init", "--name", "formation", "--goal", "x", flag, value)
        assert failure.returncode != 0, flag
        assert "unrecognized arguments" in (failure.stdout + failure.stderr), flag


def test_init_writes_neither_retired_run_key(tmp_path) -> None:
    root, state_path = _workspace(tmp_path)
    SwarmCli(state_path, cwd=root).run("init", "--name", "formation", "--goal", "Ship it")

    run = folder_store.load_run_yaml(state_path.parent)
    projection = folder_store.build_projection(state_path.parent, state_path=state_path)
    for key in ("rosterSource", "allowedRuntimes"):
        assert key not in run, key
        assert key not in projection["run"], key


# --------------------------------------------------------------------------- #
# Legacy stores still load
# --------------------------------------------------------------------------- #

def test_legacy_run_yaml_keys_load_without_crashing(tmp_path) -> None:
    # 13 real run stores carry these keys. Reads stay tolerant: the keys are now
    # unknown, so they are simply inert — never a load or projection failure.
    root, state_path = _workspace(tmp_path, "legacy")
    cli = SwarmCli(state_path, cwd=root)
    cli.run("init", "--name", "legacy", "--goal", "Ship it")

    run_yaml_path = state_path.parent / "run.yaml"
    run = yaml.safe_load(run_yaml_path.read_text())
    run["rosterSource"] = "architect"
    run["allowedRuntimes"] = [{"cli": "claude-code", "model": "claude-opus-4-8"}]
    run_yaml_path.write_text(yaml.safe_dump(run, sort_keys=False))

    # Load, project, and round-trip: no crash, and the retired keys do not
    # resurface on the projection the app reads.
    state = read_state(state_path)
    folder_store.sync_run_yaml_from_state(state_path.parent, state)
    projection = folder_store.build_projection(state_path.parent, state_path=state_path)
    assert projection["run"]["name"] == "legacy"
    assert "rosterSource" not in projection["run"]
    assert "allowedRuntimes" not in projection["run"]

    # The CLI still serves the run afterwards.
    assert cli.run("summary")["ok"] is True


# --------------------------------------------------------------------------- #
# `roster.configure` is gone from every surface
# --------------------------------------------------------------------------- #

def test_roster_configure_is_removed_from_cli_and_mcp(tmp_path) -> None:
    root, state_path = _workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    cli.run("init", "--name", "formation", "--goal", "x")

    failure = cli.run_failure("roster", "configure", "--roles-json", json.dumps([]))
    assert failure.returncode != 0

    assert "sprintengine.roster.configure" not in TOOL_SCHEMAS
    assert "sprintengine.roster.configure" not in MCP_V1_CONTRACT_SCHEMAS

    server = SprintEngineMcpServer(allowed_roots=[root])
    called = server.call_tool(
        "sprintengine.roster.configure",
        {"statePath": str(state_path), "roles": []},
        {"id": "architect", "role": "architect", "mcpAuthorized": True},
    )
    assert called["ok"] is False

    # The operator-owned survivors are untouched.
    assert cli.run("roster", "enable", "--role", "tester", "--actor", "ui")["ok"] is True


# --------------------------------------------------------------------------- #
# Both surviving formations still plan the way they did
# --------------------------------------------------------------------------- #

def test_roles_formation_with_an_architect_still_plans_through_the_architect(tmp_path) -> None:
    root, state_path = _workspace(tmp_path, "roles-formation")
    cli = SwarmCli(state_path, cwd=root)
    cli.run(
        "init",
        "--name", "roles-formation",
        "--goal", "Pick roles yourself",
        "--agent", "architect:architect",
        "--configured-roles-json", json.dumps(["architect", "developer", "tester"]),
    )

    state = read_state(state_path)
    assert resolve_planning_role(state) == "architect"
    # The architect seat keeps its SINGLETON capacity rule and the user's roster
    # is exactly what the wizard sent — no formation collapsed it to ['architect'].
    assert state["configuredRoles"] == ["architect", "developer", "tester"]

    joined = SprintEngineMcpServer(allowed_roots=[root]).call_tool(
        "sprintengine.agent.join",
        {"statePath": str(state_path), "role": "architect", "agentId": "architect"},
        {"id": "architect", "role": "architect", "mcpAuthorized": True},
    )
    assert joined["ok"] is True
    assert joined["result"]["run"]["configuredRoles"] == ["architect", "developer", "tester"]


def test_no_roles_formation_still_plans_through_a_general(tmp_path) -> None:
    root, state_path = _workspace(tmp_path, "pool-formation")
    cli = SwarmCli(state_path, cwd=root)
    cli.run(
        "init",
        "--name", "pool-formation",
        "--goal", "Plain agent pool",
        "--agent", "general:general",
        "--configured-roles-json", json.dumps(["general"]),
    )

    state = read_state(state_path)
    assert resolve_planning_role(state) == "general"

    joined = SprintEngineMcpServer(allowed_roots=[root]).call_tool(
        "sprintengine.agent.join",
        {"statePath": str(state_path), "role": "general", "agentId": "general"},
        {"id": "general", "role": "general", "mcpAuthorized": True},
    )
    assert joined["ok"] is True
    assert joined["result"]["run"]["configuredRoles"] == ["general"]
