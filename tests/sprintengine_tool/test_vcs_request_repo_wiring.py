"""The six MCP layers `sprintengine.vcs.request_repo` rides on (MC-1671).

The tool has to be wired at every layer `vcs.commit` is, or it either never
reaches an agent's tool list or arrives with the wrong arguments. These pin the
contract registration, the advertised schema, the any-agent capability, and the
payload adapter's key mapping — the wiring that behavioural tests would only fail
on indirectly.
"""
from __future__ import annotations

from pathlib import Path

from sprintengine_mcp.capabilities import AGENT_COMMON_TOOLS, PLANNING_TOOLS
from sprintengine_mcp.payloads import command_payload_to_namespace
from sprintengine_mcp.schemas import TOOL_SCHEMAS
from sprintengine_mcp.tool_contracts import MCP_TOOL_CONTRACTS

TOOL = "sprintengine.vcs.request_repo"


def test_tool_is_registered_as_command_backed() -> None:
    contract = MCP_TOOL_CONTRACTS[TOOL]
    assert contract.command_backed
    assert contract.command_handler.__name__ == "cmd_vcs_request_repo"


def test_schema_requires_root_and_id_but_not_state_path() -> None:
    schema = TOOL_SCHEMAS[TOOL]
    # `statePath` is server-resolvable and filtered out of `required`; `root` and
    # `id` are the caller's to supply. `root` is deliberately not `workspaceRoot`.
    assert set(schema["required"]) == {"root", "id"}
    assert "root" in schema["properties"]
    assert "workspaceRoot" not in schema["properties"]
    assert "repoId" in schema["properties"]


def test_every_joined_agent_may_call_it_without_a_planning_grant() -> None:
    # Any agent can bring in a project on demand — no approval gate, not planner-only.
    assert TOOL in AGENT_COMMON_TOOLS
    assert TOOL not in PLANNING_TOOLS


def test_payload_maps_root_repo_id_and_agent_id() -> None:
    ns = command_payload_to_namespace(
        TOOL,
        Path("/ws/.multi-code/sprintengine/alpha/run.yaml"),
        {"root": "../multicode-mobile", "repoId": "mobile", "id": "developer-1"},
        None,
    )
    assert ns.root == "../multicode-mobile"
    assert ns.repo_id == "mobile"
    assert ns.id == "developer-1"
    assert ns.state == Path("/ws/.multi-code/sprintengine/alpha/run.yaml")


def test_payload_leaves_repo_id_none_when_omitted() -> None:
    ns = command_payload_to_namespace(
        TOOL,
        Path("/ws/.multi-code/sprintengine/alpha/run.yaml"),
        {"root": "../multicode-mobile", "id": "developer-1"},
        None,
    )
    assert ns.repo_id is None
