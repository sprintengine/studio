"""Engine coverage for "Architect picks the team": roster source, allowed
runtimes, and the `roster.configure` mutation (plan.md section C).

Two CLI-init-only flags (`--roster-source`, `--allowed-runtimes-json`) persist
top-level in run.yaml and re-emit on the projection; neither is MCP-mutable. The
new `sprintengine.roster.configure` tool runs five ordered validations, then sets
`configuredRoles := union(submitted, planning role)` and merges `roleRuntimes`.
"""
from __future__ import annotations

import json
from pathlib import Path

from sprintengine_core import store as folder_store
from sprintengine_mcp import SprintEngineMcpServer
from sprintengine_mcp.capabilities import PLANNING_TOOLS, ROSTER_GROWTH_TOOLS
from sprintengine_mcp.schemas import MCP_V1_CONTRACT_SCHEMAS
from helpers import SwarmCli, read_state


def _workspace(tmp_path: Path):
    root = tmp_path / "project"
    root.mkdir(parents=True, exist_ok=True)
    state_path = root / ".multi-code" / "sprintengine" / "auto-roster" / "run.yaml"
    return root, state_path


def _init_architect_run(cli: SwarmCli, allowed: list[dict]) -> dict:
    # Mirrors a wizard-created "Architect picks the team" run: only the architect
    # seat is filled, configuredRoles is architect-only, and the sprint palette is
    # the ticked selection.
    return cli.run(
        "init",
        "--name", "auto-roster",
        "--goal", "Architect picks the team",
        "--roster-source", "architect",
        "--agent", "architect:architect",
        "--configured-roles-json", json.dumps(["architect"]),
        "--role-runtimes-json", json.dumps({"architect": {"cli": "claude-code", "model": "claude-fable-5"}}),
        "--allowed-runtimes-json", json.dumps(allowed),
    )


OPUS = {"cli": "claude-code", "model": "claude-opus-4-8"}
GLM = {"cli": "zai", "model": "glm-5.2"}
CLI_DEFAULT = {"cli": "claude-code", "model": None}


# --------------------------------------------------------------------------- #
# Init flags + run.yaml / projection round-trip
# --------------------------------------------------------------------------- #

def test_init_persists_roster_source_and_allowed_runtimes(tmp_path) -> None:
    root, state_path = _workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    _init_architect_run(cli, [OPUS, CLI_DEFAULT])

    # On disk in run.yaml immediately, both top-level.
    run = folder_store.load_run_yaml(state_path.parent)
    assert run["rosterSource"] == "architect"
    assert run["allowedRuntimes"] == [
        {"cli": "claude-code", "model": "claude-opus-4-8"},
        {"cli": "claude-code", "model": None},
    ]

    # Survives load_state / sync_run_yaml_from_state round-trip.
    state = read_state(state_path)
    assert state["rosterSource"] == "architect"
    assert state["allowedRuntimes"][0]["model"] == "claude-opus-4-8"
    folder_store.sync_run_yaml_from_state(state_path.parent, state)
    reloaded = folder_store.load_run_yaml(state_path.parent)
    assert reloaded["rosterSource"] == "architect"
    assert reloaded["allowedRuntimes"] == run["allowedRuntimes"]

    # Re-emits on projection.run.
    projection = folder_store.build_projection(state_path.parent, state_path=state_path)
    assert projection["run"]["rosterSource"] == "architect"
    assert projection["run"]["allowedRuntimes"] == run["allowedRuntimes"]


def test_user_mode_run_leaves_new_keys_absent(tmp_path) -> None:
    root, state_path = _workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    cli.run("init", "--name", "auto-roster", "--goal", "User picks the team")

    run = folder_store.load_run_yaml(state_path.parent)
    assert "rosterSource" not in run
    assert "allowedRuntimes" not in run

    projection = folder_store.build_projection(state_path.parent, state_path=state_path)
    assert "rosterSource" not in projection["run"]
    assert "allowedRuntimes" not in projection["run"]


def test_allowed_runtimes_drops_cli_less_and_dedupes(tmp_path) -> None:
    root, state_path = _workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    _init_architect_run(cli, [OPUS, OPUS, {"model": "no-cli"}, {"cli": "zai", "model": ""}])

    run = folder_store.load_run_yaml(state_path.parent)
    # Duplicate OPUS collapsed, cli-less entry dropped, empty model -> None.
    assert run["allowedRuntimes"] == [
        {"cli": "claude-code", "model": "claude-opus-4-8"},
        {"cli": "zai", "model": None},
    ]


def test_invalid_roster_source_rejected(tmp_path) -> None:
    root, state_path = _workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    failure = cli.run_failure(
        "init", "--name", "auto-roster", "--goal", "x", "--roster-source", "robot",
    )
    assert "roster-source" in (failure.stdout + failure.stderr)


# --------------------------------------------------------------------------- #
# roster.configure — happy path + effect
# --------------------------------------------------------------------------- #

def _server_for(state_path: Path, root: Path) -> SprintEngineMcpServer:
    return SprintEngineMcpServer(allowed_roots=[root])


def _configure(server, state_path, roles, actor_id="architect", role="architect"):
    return server.call_tool(
        "sprintengine.roster.configure",
        {"statePath": str(state_path), "roles": roles, "id": actor_id},
        {"id": actor_id, "role": role, "mcpAuthorized": True},
    )


def test_configure_unions_planner_and_merges_runtimes(tmp_path) -> None:
    root, state_path = _workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    _init_architect_run(cli, [OPUS, GLM, CLI_DEFAULT])
    server = _server_for(state_path, root)

    result = _configure(
        server,
        state_path,
        [
            {"role": "developer", "cli": "claude-code", "model": "claude-opus-4-8"},
            {"role": "tester", "cli": "zai", "model": "glm-5.2"},
            {"role": "security", "cli": "claude-code", "model": None},
        ],
    )
    assert result["ok"] is True
    configured = result["result"]["configuredRoles"]
    # Planning role unioned in, submitted roles present.
    assert configured[0] == "architect"
    assert set(configured) == {"architect", "developer", "tester", "security"}

    state = read_state(state_path)
    # roleRuntimes merged: architect seat preserved, submitted roles added.
    assert state["roleRuntimes"]["architect"] == {"cli": "claude-code", "model": "claude-fable-5"}
    assert state["roleRuntimes"]["developer"] == {"cli": "claude-code", "model": "claude-opus-4-8"}
    assert state["roleRuntimes"]["tester"] == {"cli": "zai", "model": "glm-5.2"}
    # model: null records the cli only (CLI default, no --model fabricated).
    assert state["roleRuntimes"]["security"] == {"cli": "claude-code"}
    assert any(event.get("type") == "roster_configured" for event in state["events"])


def test_configure_before_approval_replaces_configured_roles(tmp_path) -> None:
    root, state_path = _workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    _init_architect_run(cli, [OPUS, GLM])
    server = _server_for(state_path, root)

    first = _configure(server, state_path, [{"role": "developer", "cli": "claude-code", "model": "claude-opus-4-8"}])
    assert set(first["result"]["configuredRoles"]) == {"architect", "developer"}

    # A revision before approval replaces the proposal (configuredRoles is set,
    # not appended): developer drops out, tester takes over.
    second = _configure(server, state_path, [{"role": "tester", "cli": "zai", "model": "glm-5.2"}])
    assert set(second["result"]["configuredRoles"]) == {"architect", "tester"}


# --------------------------------------------------------------------------- #
# roster.configure — five ordered validations
# --------------------------------------------------------------------------- #

def _err(result) -> str:
    return result["error"]["message"]


def test_configure_rejects_non_architect_roster_source(tmp_path) -> None:
    root, state_path = _workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    # User-mode run: rosterSource absent.
    cli.run("init", "--name", "auto-roster", "--goal", "x", "--configured-roles-json", json.dumps(["architect"]))
    server = _server_for(state_path, root)

    denied = _configure(server, state_path, [{"role": "developer", "cli": "claude-code", "model": "claude-opus-4-8"}])
    assert denied["ok"] is False
    assert "roster_configure_requires_architect_roster_source" in _err(denied)


def test_configure_rejects_unknown_role_naming_known_roles(tmp_path) -> None:
    root, state_path = _workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    _init_architect_run(cli, [OPUS])
    server = _server_for(state_path, root)

    denied = _configure(server, state_path, [{"role": "wizard", "cli": "claude-code", "model": "claude-opus-4-8"}])
    assert denied["ok"] is False
    message = _err(denied)
    assert "unknown role" in message
    assert "developer" in message  # known roles are named


def test_configure_rejects_out_of_palette_runtime(tmp_path) -> None:
    root, state_path = _workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    _init_architect_run(cli, [OPUS])  # only Opus ticked for this sprint
    server = _server_for(state_path, root)

    denied = _configure(server, state_path, [{"role": "developer", "cli": "zai", "model": "glm-5.2"}])
    assert denied["ok"] is False
    assert "runtime_not_allowed_for_run" in _err(denied)
    assert "developer" in _err(denied)


def test_configure_rejects_omitted_cli_and_model(tmp_path) -> None:
    root, state_path = _workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    _init_architect_run(cli, [OPUS])
    server = _server_for(state_path, root)

    # No ambient CLI-default fallback: omitting cli/model is out of palette.
    denied = _configure(server, state_path, [{"role": "developer"}])
    assert denied["ok"] is False
    assert "runtime_not_allowed_for_run" in _err(denied)


def test_configure_rejects_model_null_when_default_not_ticked(tmp_path) -> None:
    root, state_path = _workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    _init_architect_run(cli, [OPUS])  # explicit model only; CLI-default not ticked
    server = _server_for(state_path, root)

    denied = _configure(server, state_path, [{"role": "developer", "cli": "claude-code", "model": None}])
    assert denied["ok"] is False
    assert "runtime_not_allowed_for_run" in _err(denied)


def test_configure_accepts_model_null_when_default_ticked(tmp_path) -> None:
    root, state_path = _workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    _init_architect_run(cli, [CLI_DEFAULT])  # CLI default ticked
    server = _server_for(state_path, root)

    ok = _configure(server, state_path, [{"role": "developer", "cli": "claude-code", "model": None}])
    assert ok["ok"] is True
    assert set(ok["result"]["configuredRoles"]) == {"architect", "developer"}


def test_configure_locked_after_plan_approval(tmp_path) -> None:
    root, state_path = _workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    _init_architect_run(cli, [OPUS])
    server = _server_for(state_path, root)

    # Approve the plan: init seats the architect plan-gate task (T0); mark it done.
    state = read_state(state_path)
    plan_task = next(t for t in state["tasks"] if t["id"] == "T0")
    plan_task["status"] = "done"
    folder_store.sync_state_to_store(state_path.parent, state, state_path=state_path)

    denied = _configure(server, state_path, [{"role": "developer", "cli": "claude-code", "model": "claude-opus-4-8"}])
    assert denied["ok"] is False
    assert "roster_locked_after_plan_approval" in _err(denied)


# --------------------------------------------------------------------------- #
# Capability scoping (test_capabilities-style)
# --------------------------------------------------------------------------- #

def test_configure_is_planning_surface_architect_only(tmp_path) -> None:
    # Structural: a planning tool in the roster-growth fence. Architect gets the
    # full planning surface, so it is granted to the architect; general and worker
    # never get planning tools, so it is withheld from them. The operator (app/CLI
    # human) keeps the full surface by design, exactly like roster.add — the
    # per-call enforcement below is the "architect only" boundary for agents.
    assert "sprintengine.roster.configure" in PLANNING_TOOLS
    assert "sprintengine.roster.configure" in ROSTER_GROWTH_TOOLS
    assert "sprintengine.roster.configure" in MCP_V1_CONTRACT_SCHEMAS
    from sprintengine_mcp.capabilities import allowed_tools_for_classification
    from sprintengine_mcp.schemas import TOOL_SCHEMAS
    assert "sprintengine.roster.configure" in allowed_tools_for_classification("architect", TOOL_SCHEMAS)
    assert "sprintengine.roster.configure" in allowed_tools_for_classification("operator", TOOL_SCHEMAS)
    for withheld in ("general", "reviewer", "worker"):
        assert "sprintengine.roster.configure" not in allowed_tools_for_classification(withheld, TOOL_SCHEMAS), withheld


def test_run_metadata_exposes_roster_source(tmp_path) -> None:
    root, state_path = _workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    _init_architect_run(cli, [OPUS])
    server = _server_for(state_path, root)

    got = server.call_tool(
        "sprintengine.run.get",
        {"statePath": str(state_path)},
        {"id": "architect", "role": "architect", "mcpAuthorized": True},
    )
    assert got["ok"] is True
    assert got["result"]["run"]["rosterSource"] == "architect"


def test_run_metadata_omits_roster_source_for_user_mode(tmp_path) -> None:
    root, state_path = _workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    cli.run("init", "--name", "auto-roster", "--goal", "x")
    server = _server_for(state_path, root)

    got = server.call_tool(
        "sprintengine.run.get",
        {"statePath": str(state_path)},
        {"id": "architect", "role": "architect", "mcpAuthorized": True},
    )
    assert got["ok"] is True
    assert "rosterSource" not in got["result"]["run"]


def test_configure_withheld_from_general_and_worker(tmp_path) -> None:
    root, state_path = _workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    _init_architect_run(cli, [OPUS])
    server = _server_for(state_path, root)
    roles = [{"role": "developer", "cli": "claude-code", "model": "claude-opus-4-8"}]

    for classification_role in ("general", "developer"):
        denied = _configure(server, state_path, roles, actor_id=f"{classification_role}-a", role=classification_role)
        assert denied["ok"] is False, classification_role
        assert denied["error"]["code"] == "tool_not_permitted_for_role"


def test_init_flags_are_not_mcp_mutable(tmp_path) -> None:
    # The init schema must not carry rosterSource / allowedRuntimes: they are
    # CLI-init-only, app-written flags.
    init_schema = MCP_V1_CONTRACT_SCHEMAS["sprintengine.init"]
    props = init_schema["properties"]
    assert "rosterSource" not in props
    assert "allowedRuntimes" not in props
