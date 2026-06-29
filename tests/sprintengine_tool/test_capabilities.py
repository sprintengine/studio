"""Role-scoped tool capability tests for the Sprint Engine MCP surface.

Visibility and authorization share one capability table
(`sprintengine_mcp/capabilities.py`): a tool hidden from a role's
`tools/list` must also fail when called by name, and the listed surface must
match the table exactly so the two can never drift apart.
"""

from __future__ import annotations

import json
import threading
from contextlib import contextmanager

import urllib.request

from helpers import create_team, create_workspace_team, read_state, task, write_state, write_workspace_role
from sprintengine_mcp import McpRequestContext, SprintEngineMcpServer
from sprintengine_mcp.auth import ActorContext
from sprintengine_mcp.capabilities import (
    AGENT_COMMON_TOOLS,
    PLANNING_TOOLS,
    REVIEW_TOOLS,
    allowed_tools_for_classification,
    classify_role,
    clear_role_classification_cache,
)
from sprintengine_mcp.http_server import SESSION_HEADER, SprintEngineHttpMcpServer
from sprintengine_mcp.schemas import TOOL_SCHEMAS
from sprintengine_mcp.tool_contracts import MCP_TOOL_CONTRACTS


def actor(agent_id: str, role: str) -> dict[str, object]:
    return {"id": agent_id, "role": role, "mcpAuthorized": True}


def make_context(fixture, tmp_path, role: str = "", agent_id: str = "") -> McpRequestContext:
    return McpRequestContext(
        actor=ActorContext(id="multicode-app", role="user"),
        state_path=fixture.state_path,
        workspace_root=tmp_path,
        allowed_roots=(tmp_path,),
        role=role,
        agent_id=agent_id,
    )


def listed_names(server: SprintEngineMcpServer, context: McpRequestContext | None) -> set[str]:
    return {schema["name"] for schema in server.list_tools(context)}


def test_capability_table_stays_within_active_contracts() -> None:
    all_tools = set(MCP_TOOL_CONTRACTS)
    assert AGENT_COMMON_TOOLS <= all_tools
    assert REVIEW_TOOLS <= all_tools
    assert PLANNING_TOOLS <= all_tools
    # Every active tool is reachable by some classification (operator gets all).
    assert allowed_tools_for_classification("operator", all_tools) == all_tools


def test_listing_matches_capability_table_per_role(tmp_path) -> None:
    clear_role_classification_cache()
    fixture = create_team(tmp_path, "cap-listing", [task("T1", "Work", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    expectations = {
        "developer": "worker",
        "code_reviewer": "reviewer",
        "product": "reviewer",
        "architect": "architect",
    }
    for role, classification in expectations.items():
        assert classify_role(role, workspace_root=tmp_path) == classification
        listed = listed_names(server, make_context(fixture, tmp_path, role=role))
        assert listed == allowed_tools_for_classification(classification, TOOL_SCHEMAS), role

    # Worker surface: no plan/run-admin/rework-request tools, no CLI
    # compatibility join. Gate tools stay common because quality gates carry
    # their own role (a frontend_review gate is claimed by the frontend
    # worker) and gate claimability already enforces the role match.
    worker = listed_names(server, make_context(fixture, tmp_path, role="developer"))
    for hidden in ("sprintengine.plan.add_task", "sprintengine.task.request_changes", "sprintengine.summary", "sprintengine.join", "sprintengine.artifact.approve"):
        assert hidden not in worker
    assert "sprintengine.task.next" in worker
    assert "sprintengine.gate.verdict" in worker
    assert "sprintengine.roster.retire" in worker

    # Reviewer surface adds the rework-request privileges, still no plan tools.
    reviewer = listed_names(server, make_context(fixture, tmp_path, role="code_reviewer"))
    assert "sprintengine.task.request_changes" in reviewer
    assert "sprintengine.artifact.request_changes" in reviewer
    assert "sprintengine.plan.add_task" not in reviewer

    # Architect gets planning and review, but not the operator-only CLI join.
    architect = listed_names(server, make_context(fixture, tmp_path, role="architect"))
    assert "sprintengine.plan.add_task" in architect
    assert "sprintengine.summary" in architect
    assert "sprintengine.join" not in architect

    # Run-scoped sessions (no bound role) and stdio keep the full surface.
    assert listed_names(server, make_context(fixture, tmp_path)) == set(TOOL_SCHEMAS)
    assert listed_names(server, None) == set(TOOL_SCHEMAS)


def test_hidden_tools_fail_when_called_by_name(tmp_path) -> None:
    clear_role_classification_cache()
    fixture = create_team(tmp_path, "cap-enforce", [task("T1", "Work", "developer")])
    state = read_state(fixture.state_path)
    state["sprintengine"]["rosterConfigured"] = True
    state["agents"] = {
        "architect": {"role": "architect", "status": "idle", "currentTaskId": None},
        "developer-a": {"role": "developer", "status": "idle", "currentTaskId": None},
        "reviewer-a": {"role": "code_reviewer", "status": "idle", "currentTaskId": None},
    }
    write_state(fixture.state_path, state)
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    denied = server.call_tool(
        "sprintengine.plan.add_task",
        {"statePath": str(fixture.state_path), "title": "Sneaky", "role": "developer"},
        actor("developer-a", "developer"),
    )
    assert denied["ok"] is False
    assert denied["error"]["code"] == "tool_not_permitted_for_role"
    assert denied["error"]["details"]["role"] == "developer"
    assert "permittedAlternative" in denied["error"]["details"]
    assert len(read_state(fixture.state_path)["tasks"]) == 1

    reviewer_denied = server.call_tool(
        "sprintengine.summary",
        {"statePath": str(fixture.state_path)},
        actor("reviewer-a", "code_reviewer"),
    )
    assert reviewer_denied["ok"] is False
    assert reviewer_denied["error"]["code"] == "tool_not_permitted_for_role"

    worker_rework_denied = server.call_tool(
        "sprintengine.task.request_changes",
        {"statePath": str(fixture.state_path), "taskId": "T1", "id": "developer-a", "reason": "Not my call."},
        actor("developer-a", "developer"),
    )
    assert worker_rework_denied["ok"] is False
    assert worker_rework_denied["error"]["code"] == "tool_not_permitted_for_role"

    # The permitted side of the same roles keeps working.
    claimed = server.call_tool(
        "sprintengine.task.next",
        {"statePath": str(fixture.state_path), "role": "developer", "id": "developer-a"},
        actor("developer-a", "developer"),
    )
    assert claimed["ok"] is True
    assert claimed["result"]["claimed"] is True

    architect_plan = server.call_tool(
        "sprintengine.plan.add_task",
        {"statePath": str(fixture.state_path), "title": "Planned", "role": "developer"},
        actor("architect", "architect"),
    )
    assert architect_plan["ok"] is True


def test_plugin_role_with_review_capability_gets_reviewer_surface(tmp_path) -> None:
    clear_role_classification_cache()
    workspace = tmp_path / "plugin-ws"
    write_workspace_role(
        workspace,
        "compliance_reviewer",
        capabilities=[{"kind": "review", "phase": "review"}],
    )
    write_workspace_role(workspace, "data_engineer")
    fixture = create_workspace_team(tmp_path, "plugin-ws", "cap-plugin", [task("T1", "Work", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    assert classify_role("compliance_reviewer", workspace_root=workspace) == "reviewer"
    assert classify_role("data_engineer", workspace_root=workspace) == "worker"
    assert classify_role("never_registered_role", workspace_root=workspace) == "worker"

    context = McpRequestContext(
        actor=ActorContext(id="multicode-app", role="user"),
        state_path=fixture.state_path,
        workspace_root=workspace,
        allowed_roots=(tmp_path,),
        role="compliance_reviewer",
    )
    listed = listed_names(server, context)
    assert "sprintengine.gate.verdict" in listed
    assert "sprintengine.plan.add_task" not in listed


def test_role_bound_session_cannot_impersonate_another_role(tmp_path) -> None:
    clear_role_classification_cache()
    fixture = create_team(tmp_path, "cap-impersonate", [task("T1", "Work", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])
    context = make_context(fixture, tmp_path, role="developer", agent_id="developer-a")

    mismatched = server.call_tool(
        "sprintengine.task.next",
        {"statePath": str(fixture.state_path), "role": "architect", "id": "developer-a"},
        context=context,
    )
    assert mismatched["ok"] is False
    assert mismatched["error"]["code"] == "tool_not_permitted_for_role"
    assert mismatched["error"]["details"]["payloadRole"] == "architect"

    matched = server.call_tool(
        "sprintengine.task.next",
        {"statePath": str(fixture.state_path), "role": "developer", "id": "developer-a"},
        context=context,
    )
    assert matched["ok"] is True


def test_gate_aliases_are_gone_and_verdict_skipped_replaces_skip(tmp_path) -> None:
    assert "sprintengine.gate.publish" not in MCP_TOOL_CONTRACTS
    assert "sprintengine.gate.skip" not in MCP_TOOL_CONTRACTS
    assert "sprintengine.gate.publish" not in TOOL_SCHEMAS
    assert "sprintengine.gate.skip" not in TOOL_SCHEMAS

    record = task("T1", "Reviewable", "developer", "review")
    record["qualityGates"] = [
        {
            "id": "code-review",
            "phase": "review",
            "role": "code_reviewer",
            "status": "pending",
            "required": True,
            "allowSelfReview": True,
            "focus": "Review.",
            "attempts": [],
        }
    ]
    fixture = create_team(tmp_path, "cap-gate-skip", [record])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    removed = server.call_tool(
        "sprintengine.gate.publish",
        {"statePath": str(fixture.state_path), "taskId": "T1", "gateId": "code-review", "role": "code_reviewer", "id": "reviewer-a", "verdict": "approved", "summary": "ok"},
        actor("reviewer-a", "code_reviewer"),
    )
    assert removed["ok"] is False
    assert removed["error"]["code"] == "unknown_tool"

    claimed = server.call_tool(
        "sprintengine.gate.next",
        {"statePath": str(fixture.state_path), "role": "code_reviewer", "id": "reviewer-a"},
        actor("reviewer-a", "code_reviewer"),
    )
    assert claimed["ok"] is True
    skipped = server.call_tool(
        "sprintengine.gate.verdict",
        {
            "statePath": str(fixture.state_path),
            "taskId": "T1",
            "gateId": "code-review",
            "role": "code_reviewer",
            "id": "reviewer-a",
            "verdict": "skipped",
            "summary": "Redundant for this documented follow-up.",
        },
        actor("reviewer-a", "code_reviewer"),
    )
    assert skipped["ok"] is True
    persisted_gate = read_state(fixture.state_path)["tasks"][0]["qualityGates"][0]
    assert persisted_gate["status"] == "skipped"
    assert persisted_gate["skipRationale"] == "Redundant for this documented follow-up."


def test_worker_role_can_claim_and_verdict_its_own_gate(tmp_path) -> None:
    """Regression: quality gates carry their own role — a frontend_review
    gate is claimed and verdicted by the frontend worker (observed in real
    runs). The capability table must not fence gate tools behind manifest
    review capabilities."""
    clear_role_classification_cache()
    record = task("T1", "Frontend change", "frontend", "review")
    record["qualityGates"] = [
        {
            "id": "frontend_review",
            "phase": "review",
            "role": "frontend",
            "status": "pending",
            "required": True,
            "allowSelfReview": True,
            "focus": "Frontend review.",
            "attempts": [],
        }
    ]
    fixture = create_team(tmp_path, "cap-worker-gate", [record])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    assert classify_role("frontend", workspace_root=tmp_path) == "worker"
    claimed = server.call_tool(
        "sprintengine.gate.next",
        {"statePath": str(fixture.state_path), "role": "frontend", "id": "frontend"},
        actor("frontend", "frontend"),
    )
    assert claimed["ok"] is True
    assert claimed["result"]["claimed"] is True
    verdict = server.call_tool(
        "sprintengine.gate.verdict",
        {
            "statePath": str(fixture.state_path),
            "taskId": "T1",
            "gateId": "frontend_review",
            "role": "frontend",
            "id": "frontend",
            "verdict": "approved",
            "summary": "Looks right.",
        },
        actor("frontend", "frontend"),
    )
    assert verdict["ok"] is True
    assert read_state(fixture.state_path)["tasks"][0]["qualityGates"][0]["status"] == "approved"


def test_operator_keeps_cli_compatibility_join(tmp_path) -> None:
    fixture = create_team(tmp_path, "cap-cli-join", [task("T1", "Join", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    operator_join = server.call_tool(
        "sprintengine.join",
        {"statePath": str(fixture.state_path), "role": "developer", "id": "developer-a"},
        actor("workspace-user", "user"),
    )
    assert operator_join["ok"] is True

    agent_join = server.call_tool(
        "sprintengine.join",
        {"statePath": str(fixture.state_path), "role": "developer", "id": "developer-b"},
        actor("developer-b", "developer"),
    )
    assert agent_join["ok"] is False
    assert agent_join["error"]["code"] == "tool_not_permitted_for_role"
    assert agent_join["error"]["details"]["permittedAlternative"] == "sprintengine.agent.join"


def test_worker_tool_listing_stays_under_byte_budget(tmp_path) -> None:
    clear_role_classification_cache()
    fixture = create_team(tmp_path, "cap-budget", [task("T1", "Work", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    worker_listing = server.list_tools(make_context(fixture, tmp_path, role="developer"))
    serialized = len(json.dumps(worker_listing))
    # The token-efficiency plan targeted ~6k tokens (~24k chars) for workers;
    # gate tools stayed in the common surface for correctness (worker-role
    # gates like frontend_review are real), which costs ~4.5k chars more. The
    # host-driven token-accounting lifecycle tools (agent.record_session,
    # agent.sample_token_usage) add a little more. Budget guards against
    # regression toward the old ~62k-char full listing.
    assert serialized < 32_000, f"worker tools/list serialized to {serialized} chars"
    full_listing = len(json.dumps(server.list_tools(None)))
    assert serialized < full_listing


@contextmanager
def run_http_server(server: SprintEngineMcpServer, token: str):
    httpd = SprintEngineHttpMcpServer(
        ("127.0.0.1", 0),
        server,
        actor=ActorContext(id="workspace-user", role="user", authenticated=True, mcp_authorized=True),
        auth_token=token,
    )
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    host, port = httpd.server_address
    try:
        yield f"http://{host}:{port}/mcp"
    finally:
        httpd.shutdown()
        thread.join(timeout=5)
        httpd.server_close()


def post(url: str, token: str, payload: dict, session_id: str | None = None) -> tuple[dict[str, str], dict]:
    data = json.dumps(payload).encode("utf-8")
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    if session_id:
        headers[SESSION_HEADER] = session_id
    request = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=5) as response:
        return dict(response.headers.items()), json.loads(response.read().decode("utf-8"))


def test_http_agent_scoped_registration_filters_listing_and_enforces_calls(tmp_path) -> None:
    clear_role_classification_cache()
    workspace = tmp_path / "workspace-a"
    fixture = create_workspace_team(tmp_path, "workspace-a", "cap-http", [task("T1", "Work", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[workspace])

    with run_http_server(server, token="admin-token") as base_url:
        _, run = post(f"{base_url}/runs", "admin-token", {
            "runId": "agent-run",
            "workspaceRoot": str(workspace),
            "statePath": str(fixture.state_path),
            "allowedRoots": [str(workspace)],
            "registryRoots": [],
            "actorId": "multicode-app",
            "agentId": "developer-a",
            "role": "developer",
        })
        headers, _ = post(base_url, run["runToken"], {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
        session_id = headers[SESSION_HEADER]

        _, listing = post(base_url, run["runToken"], {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, session_id)
        names = {tool["name"] for tool in listing["result"]["tools"]}
        assert "sprintengine.task.next" in names
        assert "sprintengine.gate.verdict" in names
        assert "sprintengine.plan.add_task" not in names
        assert "sprintengine.task.request_changes" not in names

        _, denied = post(base_url, run["runToken"], {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "sprintengine.plan.add_task", "arguments": {"title": "Sneaky", "role": "developer"}},
        }, session_id)
        denied_result = json.loads(denied["result"]["content"][0]["text"])
        assert denied_result["ok"] is False
        assert denied_result["error"]["code"] == "tool_not_permitted_for_role"

        _, claimed = post(base_url, run["runToken"], {
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {"name": "sprintengine.task.next", "arguments": {"role": "developer", "id": "developer-a"}},
        }, session_id)
        claimed_result = json.loads(claimed["result"]["content"][0]["text"])
        assert claimed_result["ok"] is True
        assert claimed_result["result"]["claimed"] is True

        # Run-scoped registrations (no agentId/role) keep the operator surface.
        _, run_scoped = post(f"{base_url}/runs", "admin-token", {
            "runId": "operator-run",
            "workspaceRoot": str(workspace),
            "statePath": str(fixture.state_path),
            "allowedRoots": [str(workspace)],
            "registryRoots": [],
            "actorId": "multicode-app",
        })
        op_headers, _ = post(base_url, run_scoped["runToken"], {"jsonrpc": "2.0", "id": 5, "method": "initialize", "params": {}})
        _, op_listing = post(base_url, run_scoped["runToken"], {"jsonrpc": "2.0", "id": 6, "method": "tools/list"}, op_headers[SESSION_HEADER])
        op_names = {tool["name"] for tool in op_listing["result"]["tools"]}
        assert op_names == set(TOOL_SCHEMAS)
