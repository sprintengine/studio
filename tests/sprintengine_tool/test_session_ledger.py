from __future__ import annotations

import json

from helpers import create_team, task
from sprintengine_core import store as folder_store
from sprintengine_mcp import SprintEngineMcpServer
from sprintengine_mcp.capabilities import allowed_tools_for_classification
from sprintengine_mcp.schemas import TOOL_SCHEMAS


def actor(agent_id: str = "multicode-app", role: str = "user") -> dict[str, object]:
    # role "user" classifies as operator (the app's host actor that drives the
    # lifecycle calls), which sees the full tool surface.
    return {"id": agent_id, "role": role, "authenticated": True, "mcpAuthorized": True}


def test_build_session_ledger_retains_resume_ids_and_names_unmeasured_cli() -> None:
    records = [
        {"agentId": "dev-1", "role": "developer", "cli": "codex", "cliSessionId": "", "recordedAt": "2026-06-28T10:00:00Z"},
        {"agentId": "dev-1", "role": "developer", "cli": "codex", "cliSessionId": "S1", "recordedAt": "2026-06-28T10:01:00Z"},
        # duplicate id (e.g. a redundant first-participation record) collapses
        {"agentId": "dev-1", "role": "developer", "cli": "codex", "cliSessionId": "S1", "recordedAt": "2026-06-28T10:02:00Z"},
        # resume mints a new id; both are retained in order, no overwrite
        {"agentId": "dev-1", "role": "developer", "cli": "codex", "cliSessionId": "S2", "recordedAt": "2026-06-28T10:05:00Z"},
        # an agent on an unmeasured CLI with no session id is still recorded
        {"agentId": "rev-1", "role": "nuclear_reviewer", "cli": "weirdcli", "cliSessionId": "", "recordedAt": "2026-06-28T10:03:00Z"},
    ]

    ledger = folder_store.build_session_ledger(records)

    assert [entry["agentId"] for entry in ledger] == ["dev-1", "rev-1"]
    dev = ledger[0]
    assert dev["cliSessionIds"] == ["S1", "S2"]
    assert dev["firstSeenAt"] == "2026-06-28T10:00:00Z"
    assert dev["lastSeenAt"] == "2026-06-28T10:05:00Z"
    rev = ledger[1]
    assert rev["cli"] == "weirdcli"
    assert rev["cliSessionIds"] == []


def test_record_session_tool_projects_ledger_with_resume(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "ledger-run",
        [task("T1", "Implement feature", "developer", "in_progress", owner="dev-1")],
    )
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    for cli, cli_session_id in [("claude-code", ""), ("claude-code", "C1"), ("claude-code", "C2")]:
        result = server.call_tool(
            "sprintengine.agent.record_session",
            {
                "statePath": str(fixture.state_path),
                "agentId": "dev-1",
                "role": "developer",
                "cli": cli,
                "cliSessionId": cli_session_id,
            },
            actor(),
        )
        assert result.get("ok"), result

    projection = json.loads((fixture.team_dir / "projection.json").read_text())
    assert "ledger" in projection
    entry = next(item for item in projection["ledger"] if item["agentId"] == "dev-1")
    assert entry["cli"] == "claude-code"
    assert entry["cliSessionIds"] == ["C1", "C2"]
    assert entry["role"] == "developer"

    # Rebuilding the projection from disk (as happens after an app restart)
    # reproduces the ledger from the append-only log, not from process memory.
    folder_store.write_projection_file(fixture.team_dir, {}, state_path=fixture.state_path)
    reread = json.loads((fixture.team_dir / "projection.json").read_text())
    assert reread["ledger"] == projection["ledger"]


def test_record_session_rejects_empty_agent_id(tmp_path) -> None:
    fixture = create_team(tmp_path, "ledger-empty", [task("T1", "x", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])
    result = server.call_tool(
        "sprintengine.agent.record_session",
        {"statePath": str(fixture.state_path), "agentId": "  "},
        actor(),
    )
    assert not result.get("ok")


def test_record_session_in_every_agent_role_surface() -> None:
    for classification in ("worker", "reviewer", "architect", "operator"):
        allowed = allowed_tools_for_classification(classification, TOOL_SCHEMAS)
        assert "sprintengine.agent.record_session" in allowed
