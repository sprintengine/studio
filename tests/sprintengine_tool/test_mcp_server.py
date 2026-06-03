from __future__ import annotations

from contextlib import contextmanager
import json
import os
import subprocess
import sys
import threading
import urllib.error
import urllib.request

from helpers import REPO_ROOT, create_team, create_workspace_team, get_task, read_state, task, write_state
from sprintengine_core.tool.constants import FEEDBACK_COUNT_FIELDS, FEEDBACK_SCORE_FIELDS, FEEDBACK_TEXT_FIELDS
from sprintengine_mcp import McpRequestContext, SprintEngineMcpServer
from sprintengine_mcp.auth import ActorContext
from sprintengine_mcp.http_server import SESSION_HEADER, SprintEngineHttpMcpServer
from sprintengine_mcp.payloads import command_payload_to_namespace
from sprintengine_mcp.schemas import MCP_V1_CONTRACT_SCHEMAS, TOOL_SCHEMAS
from sprintengine_mcp.tool_contracts import MCP_TOOL_CONTRACTS


def actor(agent_id: str, role: str = "product") -> dict[str, object]:
    return {"id": agent_id, "role": role, "mcpAuthorized": True}


def audit_rows(team_dir):
    path = team_dir / "metrics" / "audit-events.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def feedback_rows(team_dir):
    path = team_dir / "metrics" / "agent-feedback.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def write_registry_role(root, role_id: str, *, label: str | None = None, soul: list[dict] | None = None) -> None:
    roles_dir = root / ".sprintengine" / "roles"
    roles_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "id": role_id,
        "label": label or role_id.replace("_", " ").title(),
        "aliases": [role_id.replace("_", "-")],
        "summary": f"{role_id} summary",
        "soul": soul or [{"skill": role_id}],
    }
    (roles_dir / f"{role_id}.json").write_text(json.dumps(payload), encoding="utf-8")


def write_registry_skill(root, skill_id: str, body: str) -> None:
    skill_dir = root / ".sprintengine" / "skills" / skill_id
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(body, encoding="utf-8")


@contextmanager
def run_http_mcp_server(server: SprintEngineMcpServer, *, token: str):
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


def http_post(
    url: str,
    *,
    token: str,
    payload: dict,
    session_id: str | None = None,
    origin: str | None = None,
    expect_error: bool = False,
) -> tuple[int, dict[str, str], dict]:
    data = json.dumps(payload).encode("utf-8")
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    if session_id:
        headers[SESSION_HEADER] = session_id
    if origin:
        headers["Origin"] = origin
    request = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            body = json.loads(response.read().decode("utf-8"))
            return response.status, dict(response.headers.items()), body
    except urllib.error.HTTPError as error:
        if not expect_error:
            raise
        body = json.loads(error.read().decode("utf-8"))
        return error.code, dict(error.headers.items()), body


def register_http_run(
    base_url: str,
    *,
    token: str,
    run_id: str,
    workspace_root,
    state_path,
    allowed_roots,
    actor_id: str = "workspace-user",
) -> dict:
    status, _, body = http_post(
        f"{base_url}/runs",
        token=token,
        payload={
            "runId": run_id,
            "workspaceRoot": str(workspace_root),
            "statePath": str(state_path),
            "allowedRoots": [str(root) for root in allowed_roots],
            "registryRoots": [],
            "actorId": actor_id,
        },
    )
    assert status == 200
    assert body["runId"] == run_id
    assert body["runToken"]
    return body


def http_get(
    url: str,
    *,
    token: str | None = None,
    expect_error: bool = False,
) -> tuple[int, dict]:
    headers = {}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            body = json.loads(response.read().decode("utf-8"))
            return response.status, body
    except urllib.error.HTTPError as error:
        if not expect_error:
            raise
        body = json.loads(error.read().decode("utf-8"))
        return error.code, body


def test_mcp_tool_schemas_cover_swarm_command_groups() -> None:
    expected = {
        "sprintengine.help",
        "sprintengine.handover",
        "sprintengine.init",
        "sprintengine.recover",
        "sprintengine.roster.add",
        "sprintengine.roster.retire",
        "sprintengine.roster.replenish",
        "sprintengine.roster.list",
        "sprintengine.agent.join",
        "sprintengine.agent.next_directive",
        "sprintengine.agent.heartbeat",
        "sprintengine.agent.leave",
        "sprintengine.subscribe",
        "sprintengine.join",
        "sprintengine.summary",
        "sprintengine.dispatch.next",
        "sprintengine.dispatch.ack",
        "sprintengine.triage.needs_input",
        "sprintengine.roles.list",
        "sprintengine.roles.get",
        "sprintengine.soul.get",
        "sprintengine.skills.list",
        "sprintengine.skill.get",
        "sprintengine.task.get",
        "sprintengine.task.next",
        "sprintengine.task.claim",
        "sprintengine.task.status",
        "sprintengine.task.resolve_input",
        "sprintengine.task.release",
        "sprintengine.task.ready",
        "sprintengine.task.log",
        "sprintengine.task.publish",
        "sprintengine.task.note",
        "sprintengine.task.comment",
        "sprintengine.task.comment.list",
        "sprintengine.task.list",
        "sprintengine.task.request_changes",
        "sprintengine.gate.list",
        "sprintengine.gate.next",
        "sprintengine.gate.claim",
        "sprintengine.gate.verdict",
        "sprintengine.gate.publish",
        "sprintengine.gate.skip",
        "sprintengine.plan.add_task",
        "sprintengine.plan.update_task",
        "sprintengine.plan.delete_task",
        "sprintengine.plan.add_dependency",
        "sprintengine.plan.remove_dependency",
        "sprintengine.plan.start_review",
        "sprintengine.plan.review_status",
        "sprintengine.plan.address_reviews",
        "sprintengine.plan.list",
        "sprintengine.plan.read",
        "sprintengine.artifact.add",
        "sprintengine.artifact.list",
        "sprintengine.artifact.ready",
        "sprintengine.artifact.approve",
        "sprintengine.artifact.request_changes",
        "sprintengine.run.get",
        "sprintengine.run.policy.get",
        "sprintengine.run.projection",
        "sprintengine.run.subscribe",
        "sprintengine.feedback.summarize",
        "sprintengine.feedback.recommend_actions",
        "sprintengine.health",
    }

    assert set(TOOL_SCHEMAS) == expected
    assert set(MCP_TOOL_CONTRACTS) == expected
    listed = SprintEngineMcpServer().list_tools()
    assert {tool["name"] for tool in listed} == expected
    assert all("inputSchema" in tool for tool in listed)


def test_mcp_contract_registry_covers_schemas_and_payload_adapters(tmp_path) -> None:
    assert set(MCP_TOOL_CONTRACTS) == set(TOOL_SCHEMAS)
    assert set(MCP_TOOL_CONTRACTS) == set(MCP_V1_CONTRACT_SCHEMAS)

    command_payloads = {
        "sprintengine.handover": {"name": "Run"},
        "sprintengine.init": {},
        "sprintengine.recover": {},
        "sprintengine.roster.add": {"role": "developer", "id": "developer-1"},
        "sprintengine.roster.retire": {"id": "developer-1", "reason": "done"},
        "sprintengine.roster.replenish": {},
        "sprintengine.roster.list": {},
        "sprintengine.agent.next_directive": {"role": "developer", "agentId": "developer-1"},
        "sprintengine.join": {"role": "developer", "id": "developer-1"},
        "sprintengine.summary": {},
        "sprintengine.triage.needs_input": {"id": "architect"},
        "sprintengine.task.next": {"role": "developer", "id": "developer-1"},
        "sprintengine.task.claim": {"taskId": "T1", "id": "developer-1"},
        "sprintengine.task.status": {"taskId": "T1", "status": "done", "id": "developer-1"},
        "sprintengine.task.resolve_input": {"taskId": "T1", "id": "developer-1", "resolution": "resolved"},
        "sprintengine.task.release": {"taskId": "T1", "id": "developer-1", "reason": "released"},
        "sprintengine.task.ready": {"taskId": "T1", "id": "architect"},
        "sprintengine.task.log": {"taskId": "T1", "id": "developer-1"},
        "sprintengine.task.publish": {"taskId": "T1", "id": "developer-1", "summary": "ready"},
        "sprintengine.task.note": {"taskId": "T1", "id": "developer-1", "note": "note"},
        "sprintengine.task.comment": {"taskId": "T1", "id": "developer-1", "body": "comment"},
        "sprintengine.task.comment.list": {"taskId": "T1"},
        "sprintengine.task.list": {},
        "sprintengine.gate.list": {},
        "sprintengine.gate.next": {"role": "tester", "id": "tester"},
        "sprintengine.gate.claim": {"taskId": "T1", "gateId": "tester", "role": "tester", "id": "tester"},
        "sprintengine.gate.verdict": {"taskId": "T1", "gateId": "tester", "role": "tester", "id": "tester", "verdict": "approved", "summary": "ok"},
        "sprintengine.gate.publish": {"taskId": "T1", "gateId": "tester", "role": "tester", "id": "tester", "verdict": "approved", "summary": "ok"},
        "sprintengine.plan.add_task": {"title": "Task", "role": "developer"},
        "sprintengine.plan.update_task": {"taskId": "T1"},
        "sprintengine.plan.delete_task": {"taskId": "T1"},
        "sprintengine.plan.add_dependency": {"taskId": "T1", "dependsOn": ["T0"]},
        "sprintengine.plan.remove_dependency": {"taskId": "T1", "dependsOn": ["T0"]},
        "sprintengine.plan.start_review": {"role": "developer", "id": "developer-1"},
        "sprintengine.plan.review_status": {},
        "sprintengine.plan.address_reviews": {},
        "sprintengine.plan.list": {},
        "sprintengine.artifact.add": {"taskId": "T1", "kind": "plan", "title": "Plan", "path": "plan.md"},
        "sprintengine.artifact.list": {},
        "sprintengine.artifact.ready": {"artifactId": "A1", "id": "developer-1"},
        "sprintengine.artifact.approve": {"artifactId": "A1", "id": "product"},
        "sprintengine.artifact.request_changes": {"artifactId": "A1", "id": "product", "feedback": "revise"},
        "sprintengine.run.projection": {},
    }
    state_path = tmp_path / "run.yaml"
    actor_context = ActorContext(id="workspace-user", role="user", authenticated=True, mcp_authorized=True)

    for tool_name, contract in MCP_TOOL_CONTRACTS.items():
        if not contract.command_backed:
            continue
        assert contract.command_handler is not None, tool_name
        assert contract.payload_adapter is command_payload_to_namespace, tool_name
        assert tool_name in command_payloads, tool_name
        adapted = contract.payload_adapter(tool_name, state_path, command_payloads[tool_name], actor_context)
        assert adapted.state == state_path


def test_mcp_help_returns_versioned_agent_workflow_without_state_path() -> None:
    server = SprintEngineMcpServer()
    response = server.call_tool(
        "sprintengine.help",
        {"role": "architect", "agentId": "architect", "topic": "agent_workflow"},
        actor("workspace-user", "user"),
    )

    assert response["ok"] is True
    result = response["result"]
    assert result["ok"] is True
    assert result["topic"] == "agent_workflow"
    assert result["role"] == "architect"
    assert result["agentId"] == "architect"
    assert "sprintengine.task.next" in result["markdown"]
    assert "needsInputKind" in result["markdown"]
    assert "sprintengine.artifact.add" in result["markdown"]
    assert "sprintengine.gate.verdict" in result["markdown"]
    assert "sprintengine.task.request_changes" in result["markdown"]
    assert "outside an active gate" in result["markdown"]


def test_mcp_v1_contract_schemas_include_planned_lifecycle_and_dispatch_tools() -> None:
    planned = {
        "sprintengine.help",
        "sprintengine.handover",
        "sprintengine.agent.join",
        "sprintengine.agent.next_directive",
        "sprintengine.agent.heartbeat",
        "sprintengine.agent.leave",
        "sprintengine.subscribe",
        "sprintengine.dispatch.next",
        "sprintengine.dispatch.ack",
        "sprintengine.triage.needs_input",
        "sprintengine.roles.list",
        "sprintengine.roles.get",
        "sprintengine.soul.get",
        "sprintengine.skills.list",
        "sprintengine.skill.get",
        "sprintengine.task.get",
        "sprintengine.task.publish",
        "sprintengine.task.request_changes",
        "sprintengine.gate.list",
        "sprintengine.gate.publish",
        "sprintengine.gate.skip",
        "sprintengine.run.get",
        "sprintengine.run.policy.get",
        "sprintengine.run.projection",
        "sprintengine.run.subscribe",
        "sprintengine.plan.list",
        "sprintengine.plan.read",
    }
    active_now = planned

    assert planned <= set(MCP_V1_CONTRACT_SCHEMAS)
    assert active_now <= set(TOOL_SCHEMAS)
    assert MCP_V1_CONTRACT_SCHEMAS["sprintengine.task.status"]["properties"]["status"]["enum"]
    assert MCP_V1_CONTRACT_SCHEMAS["sprintengine.gate.verdict"]["properties"]["verdict"]["enum"]
    assert MCP_V1_CONTRACT_SCHEMAS["sprintengine.gate.publish"]["properties"]["verdict"]["enum"]
    assert "needsInputKind" not in MCP_V1_CONTRACT_SCHEMAS["sprintengine.task.request_changes"]["properties"]


def test_mcp_feedback_schemas_expose_known_feedback_fields() -> None:
    feedback_tools = [
        "sprintengine.task.status",
        "sprintengine.gate.verdict",
        "sprintengine.gate.publish",
        "sprintengine.artifact.ready",
    ]

    for tool_name in feedback_tools:
        schema = MCP_V1_CONTRACT_SCHEMAS[tool_name]
        properties = schema["properties"]
        assert schema["additionalProperties"] is True
        for attr, camel, _ in FEEDBACK_SCORE_FIELDS:
            assert properties[attr]["type"] == "integer"
            assert properties[camel]["maximum"] == 100
        for attr, camel, _ in FEEDBACK_COUNT_FIELDS:
            assert properties[attr]["type"] == "integer"
            assert properties[camel]["minimum"] == 0
        for attr, camel, _ in FEEDBACK_TEXT_FIELDS:
            assert properties[attr]["type"] == "string"
            assert properties[camel]["type"] == "string"
        assert "issue_json" in properties
        assert "issueJson" in properties
        assert "finding_json" in properties
        assert "findingJson" in properties
    for tool_name in ("sprintengine.gate.verdict", "sprintengine.gate.publish"):
        properties = MCP_V1_CONTRACT_SCHEMAS[tool_name]["properties"]
        assert properties["reviewed_difficulty_pct"]["maximum"] == 100
        assert properties["reviewedDifficultyPct"]["type"] == "integer"
        assert "implementation" in properties["reviewed_difficulty_dimension"]["enum"]
        assert "implementation" in properties["reviewedDifficultyDimension"]["enum"]
        assert properties["reviewed_difficulty_reason"]["type"] == "string"
        assert properties["reviewedDifficultyReason"]["type"] == "string"
    for tool_name in ("sprintengine.plan.add_task", "sprintengine.plan.update_task"):
        properties = MCP_V1_CONTRACT_SCHEMAS[tool_name]["properties"]
        assert properties["difficulty_pct"]["maximum"] == 100
        assert properties["difficultyPct"]["type"] == "integer"
        assert properties["difficulty_reason"]["type"] == "string"
        assert properties["difficultyReason"]["type"] == "string"


def test_mcp_valid_task_lifecycle_call_uses_core_and_emits_audit(tmp_path) -> None:
    fixture = create_team(tmp_path, "mcp-task-lifecycle", [task("T1", "Implement MCP", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    claimed = server.call_tool(
        "sprintengine.task.next",
        {"statePath": str(fixture.state_path), "role": "developer", "id": "developer-a"},
        actor("workspace-user", "user"),
    )
    logged = server.call_tool(
        "sprintengine.task.log",
        {
            "statePath": str(fixture.state_path),
            "taskId": "T1",
            "id": "developer-a",
            "summary": "Implemented local MCP boundary",
            "file": ["sprintengine_mcp/server.py"],
            "command": ["pytest tests/sprintengine_tool/test_mcp_server.py"],
            "result": ["passed"],
            "scopeExpansionJson": [
                '{"path":"tests/sprintengine_tool/test_mcp_server.py","reason":"MCP regression test for companion evidence","risk":"low; test-only"}'
            ],
        },
        actor("workspace-user", "user"),
    )

    assert claimed["ok"] is True
    assert claimed["result"]["task"]["status"] == "in_progress"
    assert claimed["result"]["state"] == "dispatched"
    assert claimed["result"]["currentDispatch"]["targetKind"] == "task"
    assert claimed["result"]["latestEventId"] == claimed["result"]["event"]["id"]
    assert claimed["result"]["events"][-1]["id"] == claimed["result"]["event"]["id"]
    assert logged["ok"] is True
    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert task_record["ownerAgentId"] == "developer-a"
    assert task_record["evidence"]["summary"] == "Implemented local MCP boundary"
    assert task_record["evidence"]["scopeExpansions"] == [
        {
            "path": "tests/sprintengine_tool/test_mcp_server.py",
            "reason": "MCP regression test for companion evidence",
            "risk": "low; test-only",
        }
    ]
    rows = audit_rows(fixture.team_dir)
    assert [row["operation_name"] for row in rows] == ["sprintengine.task.next", "sprintengine.task.log"]
    assert rows[0]["actor"] == "workspace-user"
    assert rows[0]["backend_mode"] == "mcp-local"
    assert len(rows[0]["state_digest"]) == 64


def test_mcp_run_and_dispatch_tools_return_role_agnostic_progression_context(tmp_path) -> None:
    fixture = create_team(tmp_path, "mcp-run-dispatch", [task("T1", "Dispatch", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    claimed = server.call_tool(
        "sprintengine.task.next",
        {"statePath": str(fixture.state_path), "role": "developer", "id": "developer-a"},
        actor("workspace-user", "user"),
    )
    dispatch_id = claimed["result"]["currentDispatch"]["dispatchId"]
    dispatch = server.call_tool(
        "sprintengine.dispatch.next",
        {"statePath": str(fixture.state_path), "agentId": "developer-a"},
        actor("workspace-user", "user"),
    )
    ack = server.call_tool(
        "sprintengine.dispatch.ack",
        {"statePath": str(fixture.state_path), "agentId": "developer-a", "dispatchId": dispatch_id},
        actor("workspace-user", "user"),
    )
    run = server.call_tool("sprintengine.run.get", {"statePath": str(fixture.state_path)}, actor("workspace-user", "user"))
    policy = server.call_tool("sprintengine.run.policy.get", {"statePath": str(fixture.state_path)}, actor("workspace-user", "user"))
    projection = server.call_tool("sprintengine.run.projection", {"statePath": str(fixture.state_path)}, actor("workspace-user", "user"))
    events = server.call_tool("sprintengine.run.subscribe", {"statePath": str(fixture.state_path)}, actor("workspace-user", "user"))

    assert dispatch["ok"] is True
    assert dispatch["result"]["state"] == "dispatched"
    assert dispatch["result"]["currentDispatch"]["dispatchId"] == dispatch_id
    assert any(row["id"] == dispatch_id for row in dispatch["result"]["dispatches"])
    assert ack["ok"] is True
    assert ack["result"]["agent"]["subscription"]["lastDispatchId"] == dispatch_id
    assert ack["result"]["agent"]["subscription"]["lastDispatchAckAt"]
    assert ack["result"]["agent"]["subscription"]["lastDispatchOutcome"] == "acknowledged"
    persisted_subscription = read_state(fixture.state_path)["agents"]["developer-a"]["subscription"]
    assert persisted_subscription["lastDispatchId"] == dispatch_id
    assert persisted_subscription["lastDispatchAckAt"] == ack["result"]["agent"]["subscription"]["lastDispatchAckAt"]
    assert persisted_subscription["lastDispatchOutcome"] == "acknowledged"
    assert run["result"]["run"]["name"] == "mcp-run-dispatch"
    assert "cliWatchPolling" in policy["result"]["runner"]
    assert projection["result"]["run"]["name"] == "mcp-run-dispatch"
    assert events["result"]["latestEventId"] == events["result"]["latestEvent"]["id"]
    assert events["result"]["state"] == "events_available"
    assert [row["operation_name"] for row in audit_rows(fixture.team_dir)] == [
        "sprintengine.task.next",
        "sprintengine.dispatch.ack",
    ]


def test_mcp_dispatch_next_returns_only_requested_agent_rows(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "mcp-dispatch-agent-scope",
        [
            task("T1", "First dispatch", "developer"),
            task("T2", "Second dispatch", "developer"),
        ],
    )
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])
    first = server.call_tool(
        "sprintengine.task.claim",
        {"statePath": str(fixture.state_path), "taskId": "T1", "id": "dev-1"},
        actor("workspace-user", "user"),
    )
    second = server.call_tool(
        "sprintengine.task.claim",
        {"statePath": str(fixture.state_path), "taskId": "T2", "id": "dev-2"},
        actor("workspace-user", "user"),
    )
    first_dispatch_id = first["result"]["currentDispatch"]["dispatchId"]
    assert second["result"]["currentDispatch"]["dispatchId"] != first_dispatch_id

    current = server.call_tool(
        "sprintengine.dispatch.next",
        {"statePath": str(fixture.state_path), "agentId": "dev-1"},
        actor("workspace-user", "user"),
    )
    after_seen = server.call_tool(
        "sprintengine.dispatch.next",
        {"statePath": str(fixture.state_path), "agentId": "dev-1", "lastDispatchId": first_dispatch_id},
        actor("workspace-user", "user"),
    )

    assert current["ok"] is True
    assert [record["agentId"] for record in current["result"]["dispatches"]] == ["dev-1"]
    assert current["result"]["currentDispatch"]["dispatchId"] == first_dispatch_id
    assert after_seen["ok"] is True
    assert after_seen["result"]["dispatches"] == []


def test_mcp_gate_claim_and_verdict_use_core_lifecycle_and_audit(tmp_path) -> None:
    task_record = task("T1", "Reviewable", "developer", "review", owner="developer-a")
    task_record["qualityGates"] = [
        {
            "id": "code-review",
            "phase": "review",
            "role": "code_reviewer",
            "status": "pending",
            "required": True,
            "allowSelfReview": True,
            "focus": "Review implementation.",
            "attempts": [],
        }
    ]
    fixture = create_team(tmp_path, "mcp-gate-lifecycle", [task_record])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    listed = server.call_tool(
        "sprintengine.gate.list",
        {"statePath": str(fixture.state_path), "role": "code_reviewer"},
        actor("workspace-user", "user"),
    )
    claimed = server.call_tool(
        "sprintengine.gate.next",
        {"statePath": str(fixture.state_path), "role": "code_reviewer", "id": "reviewer-a"},
        actor("workspace-user", "user"),
    )
    verdict = server.call_tool(
        "sprintengine.gate.verdict",
        {
            "statePath": str(fixture.state_path),
            "taskId": "T1",
            "gateId": "code-review",
            "role": "code_reviewer",
            "id": "reviewer-a",
            "verdict": "approved",
            "summary": "Implementation matches the task card.",
        },
        actor("workspace-user", "user"),
    )

    assert listed["ok"] is True
    assert [gate["id"] for gate in listed["result"]["gates"]] == ["code-review"]
    assert claimed["ok"] is True
    assert claimed["result"]["state"] == "dispatched"
    assert claimed["result"]["currentDispatch"]["targetKind"] == "gate"
    assert claimed["result"]["attempt"]["id"] == "GA-001"
    assert verdict["ok"] is True
    assert verdict["result"]["gate"]["status"] == "approved"
    assert verdict["result"]["progression"]["state"] == "idle"
    assert [row["operation_name"] for row in audit_rows(fixture.team_dir)] == [
        "sprintengine.gate.next",
        "sprintengine.gate.verdict",
    ]


def test_mcp_gate_verdict_forwards_feedback_count_fields_to_metrics(tmp_path) -> None:
    def run_verdict(team_name: str, payload_counts: dict[str, int]) -> tuple[dict, dict]:
        task_record = task("T1", "Reviewable", "developer", "review", owner="developer-a")
        task_record["qualityGates"] = [
            {
                "id": "code-review",
                "phase": "review",
                "role": "code_reviewer",
                "status": "pending",
                "required": True,
                "allowSelfReview": True,
                "focus": "Review implementation.",
                "attempts": [],
            }
        ]
        fixture = create_team(tmp_path, team_name, [task_record])
        server = SprintEngineMcpServer(allowed_roots=[tmp_path])
        claimed = server.call_tool(
            "sprintengine.gate.next",
            {"statePath": str(fixture.state_path), "role": "code_reviewer", "id": "reviewer-a"},
            actor("workspace-user", "user"),
        )
        verdict = server.call_tool(
            "sprintengine.gate.verdict",
            {
                "statePath": str(fixture.state_path),
                "taskId": "T1",
                "gateId": "code-review",
                "role": "code_reviewer",
                "id": "reviewer-a",
                "verdict": "approved",
                "summary": "Implementation matches the task card.",
                **payload_counts,
            },
            actor("workspace-user", "user"),
        )

        assert claimed["ok"] is True
        assert verdict["ok"] is True
        assert verdict["result"]["feedbackRecorded"] is True
        record = feedback_rows(fixture.team_dir)[0]
        reviewed = get_task(read_state(fixture.state_path), "T1")
        return record, reviewed["feedbackAssessments"][0]

    camel_record, camel_assessment = run_verdict(
        "mcp-gate-camel-counts",
        {camel: index + 1 for index, (_, camel, _) in enumerate(FEEDBACK_COUNT_FIELDS)},
    )
    snake_record, snake_assessment = run_verdict(
        "mcp-gate-snake-counts",
        {attr: index + 11 for index, (attr, _, _) in enumerate(FEEDBACK_COUNT_FIELDS)},
    )

    for index, (_, state_key, json_key) in enumerate(FEEDBACK_COUNT_FIELDS):
        assert camel_record["counts"][json_key] == index + 1
        assert camel_assessment["counts"][state_key] == index + 1
        assert snake_record["counts"][json_key] == index + 11
        assert snake_assessment["counts"][state_key] == index + 11


def test_mcp_gate_publish_records_reviewer_difficulty_assessment(tmp_path) -> None:
    task_record = task("T1", "Reviewable", "developer", "review", owner="developer-a")
    task_record["qualityGates"] = [
        {
            "id": "code-review",
            "phase": "review",
            "role": "code_reviewer",
            "status": "pending",
            "required": True,
            "allowSelfReview": True,
            "focus": "Review implementation.",
            "attempts": [],
        }
    ]
    fixture = create_team(tmp_path, "mcp-gate-publish-difficulty", [task_record])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    claimed = server.call_tool(
        "sprintengine.gate.next",
        {"statePath": str(fixture.state_path), "role": "code_reviewer", "id": "reviewer-a"},
        actor("workspace-user", "user"),
    )
    verdict = server.call_tool(
        "sprintengine.gate.publish",
        {
            "statePath": str(fixture.state_path),
            "taskId": "T1",
            "gateId": "code-review",
            "role": "code_reviewer",
            "id": "reviewer-a",
            "verdict": "approved",
            "summary": "Implementation matches the task card.",
            "reviewedDifficultyPct": 74,
            "reviewedDifficultyDimension": "implementation",
            "reviewedDifficultyReason": "MCP gate publish covered several coordination paths.",
            "claimsChecked": 6,
        },
        actor("workspace-user", "user"),
    )

    assert claimed["ok"] is True
    assert verdict["ok"] is True
    assert verdict["result"]["feedbackRecorded"] is True
    reviewed = get_task(read_state(fixture.state_path), "T1")
    assessment = reviewed["difficulty"]["reviewerAssessments"][0]
    assert assessment["pct"] == 74
    assert assessment["dimension"] == "implementation"
    assert assessment["reason"] == "MCP gate publish covered several coordination paths."
    assert assessment["reviewerAgentId"] == "reviewer-a"
    assert assessment["reviewerRole"] == "code_reviewer"
    assert assessment["gateId"] == "code-review"
    assert assessment["gateAttemptId"] == "GA-001"
    assert assessment["capturedAt"]

    record = feedback_rows(fixture.team_dir)[0]
    reviewer_assessment = record["difficulty"]["reviewer_assessments"][0]
    assert reviewer_assessment["pct"] == 74
    assert reviewer_assessment["dimension"] == "implementation"
    assert reviewer_assessment["reviewer_agent_id"] == "reviewer-a"
    assert reviewer_assessment["gate_attempt_id"] == "GA-001"


def test_mcp_task_get_comment_publish_and_request_changes_cover_agent_paths(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "mcp-task-coverage",
        [task("T1", "Publishable", "developer", status="in_progress", owner="developer-a")],
    )
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    comment = server.call_tool(
        "sprintengine.task.comment",
        {"statePath": str(fixture.state_path), "taskId": "T1", "id": "developer-a", "body": "Implementation note.", "paths": ["sprintengine_mcp/server.py"]},
        actor("workspace-user", "user"),
    )
    comments = server.call_tool(
        "sprintengine.task.comment.list",
        {"statePath": str(fixture.state_path), "taskId": "T1"},
        actor("workspace-user", "user"),
    )
    fetched = server.call_tool(
        "sprintengine.task.get",
        {"statePath": str(fixture.state_path), "taskId": "T1"},
        actor("workspace-user", "user"),
    )
    published = server.call_tool(
        "sprintengine.task.publish",
        {"statePath": str(fixture.state_path), "taskId": "T1", "id": "developer-a", "summary": "Ready for review.", "path": ["sprintengine_mcp/server.py"]},
        actor("workspace-user", "user"),
    )
    changes = server.call_tool(
        "sprintengine.task.request_changes",
        {"statePath": str(fixture.state_path), "taskId": "T1", "id": "reviewer-a", "reason": "Add MCP gate coverage."},
        actor("workspace-user", "user"),
    )

    assert comment["ok"] is True
    assert comments["result"]["comments"][0]["body"] == "Implementation note."
    assert fetched["result"]["task"]["id"] == "T1"
    assert published["ok"] is True
    assert published["result"]["nextStatus"] == "done"
    assert published["result"]["progression"]["state"] == "idle"
    assert changes["ok"] is True
    assert changes["result"]["task"]["status"] == "changes_requested"
    assert "needsInput" not in changes["result"]["task"]
    assert changes["result"]["task"]["ownerAgentId"] is None
    assert changes["result"]["comment"]["type"] == "review_feedback"
    assert changes["result"]["comment"]["data"]["status"] == "open"
    assert changes["result"]["comment"]["data"]["reason"] == "Add MCP gate coverage."


def test_mcp_task_request_changes_rejects_needs_input_fields(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "mcp-request-changes-needs-input-fields",
        [task("T1", "Publishable", "developer", status="in_progress", owner="developer-a")],
    )
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    response = server.call_tool(
        "sprintengine.task.request_changes",
        {
            "statePath": str(fixture.state_path),
            "taskId": "T1",
            "id": "reviewer-a",
            "reason": "Compile fails.",
            "needsInputKind": "owner",
            "needsInputQuestion": "Please fix the compile failure.",
        },
        actor("workspace-user", "user"),
    )

    assert response["ok"] is False
    assert response["error"]["code"] == "invalid_payload"
    assert "routes ordinary rework to changes_requested" in response["error"]["message"]
    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert task_record["status"] == "in_progress"
    assert task_record["ownerAgentId"] == "developer-a"


def test_mcp_agent_join_returns_prompt_registry_run_and_dispatch_context(tmp_path) -> None:
    fixture = create_team(tmp_path, "mcp-agent-join-context", [task("T1", "Implement MCP", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path, REPO_ROOT])
    claim = server.call_tool(
        "sprintengine.task.next",
        {"statePath": str(fixture.state_path), "role": "developer", "id": "developer-a"},
        actor("workspace-user", "user"),
    )
    assert claim["ok"] is True

    response = server.call_tool(
        "sprintengine.agent.join",
        {
            "statePath": str(fixture.state_path),
            "workspaceRoot": str(REPO_ROOT),
            "role": "developer",
            "agentId": "developer-a",
            "subscriptionMode": "poll",
        },
        actor("workspace-user", "user"),
    )

    assert response["ok"] is True
    result = response["result"]
    assert result["role"] == "developer"
    assert result["agent"]["subscription"]["mode"] == "poll"
    assert result["currentDispatch"]["taskId"] == "T1"
    assert result["run"]["name"] == "mcp-agent-join-context"
    assert result["roleManifest"]["id"] == "developer"
    assert result["promptContext"]["format"] == "composed_soul_coordination_prompt"
    assert "# SprintEngine Coordination Rules" in result["prompt"]
    assert "Coordinate through the Sprint Engine MCP tools." in result["prompt"]
    assert "# Sprint Engine Workflow" in result["prompt"]
    assert "# Sprint Engine Publish Feedback" in result["prompt"]
    assert "# Sprint Engine Architect Workflow" not in result["prompt"]
    assert "legacyJoin" not in result, "agent.join must not return CLI-laden legacyJoin payload"
    assert [row["operation_name"] for row in audit_rows(fixture.team_dir)] == [
        "sprintengine.task.next",
        "sprintengine.agent.join",
    ]


def test_mcp_agent_join_injects_role_specific_runtime_skills(tmp_path) -> None:
    fixture = create_team(tmp_path, "mcp-agent-join-runtime-skills", [task("T1", "Plan work", "architect")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path, REPO_ROOT])

    architect = server.call_tool(
        "sprintengine.agent.join",
        {
            "statePath": str(fixture.state_path),
            "workspaceRoot": str(REPO_ROOT),
            "role": "architect",
            "agentId": "architect-a",
        },
        actor("workspace-user", "user"),
    )
    reviewer = server.call_tool(
        "sprintengine.agent.join",
        {
            "statePath": str(fixture.state_path),
            "workspaceRoot": str(REPO_ROOT),
            "role": "spec_reviewer",
            "agentId": "spec-reviewer-a",
        },
        actor("workspace-user", "user"),
    )

    assert architect["ok"] is True
    assert "# Sprint Engine Workflow" in architect["result"]["prompt"]
    assert "# Sprint Engine Architect Workflow" in architect["result"]["prompt"]
    assert "difficultyPct" in architect["result"]["prompt"]
    assert "# Sprint Engine Gate Feedback" not in architect["result"]["prompt"]
    assert reviewer["ok"] is True
    assert "# Sprint Engine Workflow" in reviewer["result"]["prompt"]
    assert "# Sprint Engine Gate Feedback" in reviewer["result"]["prompt"]
    assert "reviewedDifficultyPct" in reviewer["result"]["prompt"]
    assert "# Sprint Engine Architect Workflow" not in reviewer["result"]["prompt"]


def assert_directive_has_no_shell_command(result: dict[str, object]) -> None:
    encoded = json.dumps(result, sort_keys=True)
    assert "sprintengine " not in encoded


def next_directive(server: SprintEngineMcpServer, fixture, role: str, agent_id: str, *, attempts: int | None = None) -> dict[str, object]:
    payload: dict[str, object] = {"statePath": str(fixture.state_path), "role": role, "agentId": agent_id}
    if attempts is not None:
        payload["attempts"] = attempts
    response = server.call_tool("sprintengine.agent.next_directive", payload, actor("workspace-user", "user"))
    assert response["ok"] is True
    result = response["result"]
    assert_directive_has_no_shell_command(result)
    return result


def test_mcp_next_directive_matches_join_for_active_and_ready_tasks(tmp_path) -> None:
    fixture = create_team(tmp_path, "mcp-next-directive-task", [task("T1", "Implement MCP", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    ready_join = fixture.cli.run("join", "--role", "developer", "--id", "developer-a")
    ready = next_directive(server, fixture, "developer", "developer-a")
    claim = server.call_tool(
        "sprintengine.task.next",
        {"statePath": str(fixture.state_path), "role": "developer", "id": "developer-a"},
        actor("workspace-user", "user"),
    )
    active_join = fixture.cli.run("join", "--role", "developer", "--id", "developer-a")
    active = next_directive(server, fixture, "developer", "developer-a")

    assert ready_join["action"] == "work"
    assert ready["joinAction"] == ready_join["action"]
    assert ready["directiveType"] == "task_work"
    assert ready["nextMcpToolName"] == "sprintengine.task.next"
    assert ready["nextMcpArguments"] == {"statePath": str(fixture.state_path), "role": "developer", "id": "developer-a"}
    assert claim["ok"] is True
    assert active_join["action"] == "resume"
    assert active["joinAction"] == active_join["action"]
    assert active["directiveType"] == "resume"
    assert active["task"]["id"] == "T1"


def test_mcp_next_directive_matches_join_for_gate_work(tmp_path) -> None:
    task_record = task("T1", "Reviewable task", "developer", "review", owner="developer-a")
    task_record["qualityGates"] = [
        {
            "id": "code-review",
            "phase": "review",
            "role": "code_reviewer",
            "status": "pending",
            "required": True,
            "allowSelfReview": True,
            "focus": "Review implementation.",
            "attempts": [],
        }
    ]
    fixture = create_team(tmp_path, "mcp-next-directive-gate", [task_record])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    joined = fixture.cli.run("join", "--role", "code_reviewer", "--id", "reviewer-a")
    directive = next_directive(server, fixture, "code_reviewer", "reviewer-a")

    assert joined["action"] == "gate_work"
    assert directive["joinAction"] == joined["action"]
    assert directive["directiveType"] == "gate_work"
    assert directive["nextMcpToolName"] == "sprintengine.gate.next"
    assert directive["gate"]["id"] == "code-review"


def test_mcp_next_directive_matches_join_for_needs_input_idle_complete_blocked_and_error(tmp_path) -> None:
    needs_input_task = task("T1", "Needs architect triage", "developer", "needs_input", owner="developer-a")
    needs_input_task["needsInput"] = {
        "kind": "architect",
        "reason": "task_scope",
        "question": "Clarify the scope.",
    }
    needs_fixture = create_team(tmp_path, "mcp-next-directive-needs-input", [needs_input_task])
    idle_fixture = create_team(tmp_path, "mcp-next-directive-idle", [task("T1", "Tester work", "tester")])
    idle_state = read_state(idle_fixture.state_path)
    idle_state["runner"] = {
        "cliWatchPolling": "enabled",
        "pollIntervalSeconds": 10,
        "idleBackoffSeconds": 30,
        "maxBackoffSeconds": 120,
        "stopWhenComplete": True,
    }
    write_state(idle_fixture.state_path, idle_state)
    complete_fixture = create_team(tmp_path, "mcp-next-directive-complete", [task("T1", "Done work", "developer", "done")])
    retired_fixture = create_team(tmp_path, "mcp-next-directive-retired", [task("T1", "Ready work", "developer")])
    retired_state = read_state(retired_fixture.state_path)
    retired_state["agents"] = {"developer-a": {"role": "developer", "status": "retired"}}
    write_state(retired_fixture.state_path, retired_state)
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    needs_join = needs_fixture.cli.run("join", "--role", "architect", "--id", "architect-a")
    needs = next_directive(server, needs_fixture, "architect", "architect-a")
    blocked_owner_join = needs_fixture.cli.run("join", "--role", "developer", "--id", "developer-a")
    blocked_owner = next_directive(server, needs_fixture, "developer", "developer-a")
    triage = server.call_tool(
        "sprintengine.triage.needs_input",
        {"statePath": str(needs_fixture.state_path), "id": "architect-a"},
        actor("workspace-user", "user"),
    )
    idle_join = idle_fixture.cli.run("join", "--role", "developer", "--id", "developer-a")
    idle = next_directive(server, idle_fixture, "developer", "developer-a", attempts=2)
    complete_join = complete_fixture.cli.run("join", "--role", "developer", "--id", "developer-a")
    complete = next_directive(server, complete_fixture, "developer", "developer-a")
    retired_join = retired_fixture.cli.run("join", "--role", "developer", "--id", "developer-a")
    retired = next_directive(server, retired_fixture, "developer", "developer-a")
    error = next_directive(server, idle_fixture, "not_a_role", "developer-a")

    assert needs_join["action"] == "needs_input_triage"
    assert needs["directiveType"] == "needs_input_triage"
    assert needs["nextMcpToolName"] == "sprintengine.triage.needs_input"
    assert blocked_owner_join["action"] == "blocked"
    assert blocked_owner["directiveType"] == "blocked"
    assert blocked_owner["nextMcpToolName"] is None
    assert blocked_owner["blocker"]["reason"] == "needs_input"
    assert blocked_owner["task"]["id"] == "T1"
    assert triage["ok"] is True
    assert triage["result"]["tasks"][0]["id"] == "T1"
    assert idle_join["action"] == "idle"
    assert idle["directiveType"] == "idle"
    assert idle["retryAfterMs"] == 30000
    assert complete_join["action"] == "complete"
    assert complete["directiveType"] == "complete"
    assert retired_join["action"] == "retired"
    assert retired["directiveType"] == "blocked"
    assert error["directiveType"] == "error"
    assert error["nextMcpToolName"] is None


def test_mcp_plan_list_read_and_handover_bootstrap_cover_agent_workflows(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "mcp-plan-read",
        [
            task("T1", "Plan implementation", "developer", owned_paths=["src/core.py"]),
            task("T2", "Review plan", "architect", "done", depends_on=["T1"]),
        ],
    )
    plan_path = fixture.team_dir / "plan.md"
    plan_path.write_text("# Runtime Plan\n\nUse MCP-native agent tools.\n", encoding="utf-8")
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    listed = server.call_tool(
        "sprintengine.plan.list",
        {"statePath": str(fixture.state_path)},
        actor("workspace-user", "user"),
    )
    read = server.call_tool(
        "sprintengine.plan.read",
        {"statePath": str(fixture.state_path)},
        actor("workspace-user", "user"),
    )
    handover_state_path = tmp_path / ".multi-code" / "sprintengine" / "mcp-handover-bootstrap" / "run.yaml"
    handover = server.call_tool(
        "sprintengine.handover",
        {
            "statePath": str(handover_state_path),
            "name": "mcp-handover-bootstrap",
            "goal": "Build with MCP bootstrap.",
            "handoverText": "# Source\n\nBootstrap through MCP.",
            "actor": "workspace-user",
        },
        actor("workspace-user", "user"),
    )
    initialized = server.call_tool(
        "sprintengine.init",
        {"statePath": str(handover_state_path)},
        actor("workspace-user", "user"),
    )

    assert listed["ok"] is True
    assert [row["id"] for row in listed["result"]["tasks"]] == ["T1", "T2"]
    assert listed["result"]["tasks"][0]["pathCount"] == 1
    assert read["ok"] is True
    assert read["result"]["exists"] is True
    assert read["result"]["content"] == "# Runtime Plan\n\nUse MCP-native agent tools.\n"
    assert handover["ok"] is True
    assert "architectStartupPrompt" not in handover["result"]
    assert handover["result"]["bootstrap"] == {
        "owner": "app",
        "nextMcpToolName": "sprintengine.init",
        "nextMcpArguments": {"statePath": str(handover_state_path)},
        "terminalAgentRequired": False,
        "message": "Bootstrap was created through MCP/core. The app should call sprintengine.init through MCP when ready.",
    }
    assert (handover_state_path.parent / "handover.md").read_text(encoding="utf-8") == "# Source\n\nBootstrap through MCP.\n"
    assert initialized["ok"] is True
    assert initialized["result"]["action"] == "initialized"


def test_mcp_agent_join_resolves_workspace_only_custom_role(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    write_registry_role(workspace, "writer", label="Writer", soul=[{"skill": "drafting"}])
    write_registry_skill(workspace, "drafting", "Drafting Soul for {{role}} in {{run_id}}.")
    fixture = create_team(tmp_path, "mcp-custom-role-join", [])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    listed = server.call_tool(
        "sprintengine.roles.list",
        {"workspaceRoot": str(workspace)},
        actor("workspace-user", "user"),
    )
    joined = server.call_tool(
        "sprintengine.agent.join",
        {
            "statePath": str(fixture.state_path),
            "workspaceRoot": str(workspace),
            "role": "writer",
            "agentId": "writer-1",
        },
        actor("workspace-user", "user"),
    )

    assert listed["ok"] is True
    assert any(role["id"] == "writer" for role in listed["result"]["roles"])
    assert joined["ok"] is True
    assert joined["result"]["role"] == "writer"
    assert joined["result"]["roleManifest"]["id"] == "writer"
    assert "Drafting Soul for writer in mcp-custom-role-join." in joined["result"]["prompt"]
    assert "legacyJoin" not in joined["result"], "agent.join must not return CLI-laden legacyJoin payload"
    assert read_state(fixture.state_path)["agents"]["writer-1"]["role"] == "writer"


def test_mcp_agent_join_response_contains_no_cli_command_strings(tmp_path) -> None:
    """Regression: agent.join must instruct via MCP tools only.

    A strict-MCP-native agent must not see any `sprintengine <subcommand>` shell
    invocation or CLI-flag pattern in the join response — that contradicts the
    MCP-first contract and confuses the agent into running shell commands.
    """
    fixture = create_team(tmp_path, "mcp-agent-join-no-cli", [task("T1", "Smoke", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])
    response = server.call_tool(
        "sprintengine.agent.join",
        {
            "statePath": str(fixture.state_path),
            "role": "developer",
            "agentId": "developer-a",
            "workspaceRoot": str(tmp_path),
        },
        actor("workspace-user", "user"),
    )

    assert response["ok"] is True
    serialized = json.dumps(response, sort_keys=True)

    forbidden_subcommands = [
        "sprintengine join ",
        "sprintengine task ",
        "sprintengine gate ",
        "sprintengine artifact ",
        "sprintengine plan ",
        "sprintengine triage ",
        "sprintengine init ",
        "sprintengine handover ",
        "sprintengine recover ",
        "sprintengine roster ",
        "sprintengine handover\\n",
        "sprintengine init\\n",
    ]
    for needle in forbidden_subcommands:
        assert needle not in serialized, (
            f"agent.join response leaked CLI invocation: {needle!r}.\n"
            "The MCP-native contract forbids `sprintengine <subcommand>` shell strings in "
            "any join response field (prompt, promptContext, roleManifest, agent, etc.)."
        )

    # `--watch` and `join --watch` appear in legitimate scoped-deprecation
    # context inside the Soul ("do not run join --watch in MCP-native
    # terminals; use sprintengine.agent.join"). The forbidden_subcommands
    # checks above already prevent any actual CLI invocation; here we focus on
    # flag patterns that would indicate an active CLI call shape.
    forbidden_flag_patterns = [
        "--task-id ",
        "--role developer",
        "--id <your-id>",
        "--artifact-id",
    ]
    for needle in forbidden_flag_patterns:
        assert needle not in serialized, (
            f"agent.join response leaked CLI flag pattern: {needle!r}.\n"
            "Use MCP tool payload field references (e.g. `taskId`, `role`, `agentId`) instead."
        )


def test_mcp_agent_join_prompt_does_not_leak_state_path_or_workspace_root(tmp_path, monkeypatch) -> None:
    """Regression: the join response prompt must not name `statePath` or `workspaceRoot`.

    Both are server-resolvable from the MCP server's launch env
    (`SPRINTENGINE_STATE_PATH`, `SPRINTENGINE_WORKSPACE_ROOT`) and from
    state-path-to-workspace-root derivation. Autonomous agents should never see
    them in the composed prompt — naming them invites the agent to ask the
    user for paths they shouldn't need to know about.
    """
    fixture = create_team(tmp_path, "mcp-join-prompt-no-paths", [task("T1", "Smoke", "developer")])
    monkeypatch.setenv("SPRINTENGINE_STATE_PATH", str(fixture.state_path))
    monkeypatch.setenv("SPRINTENGINE_WORKSPACE_ROOT", str(tmp_path))
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])
    response = server.call_tool(
        "sprintengine.agent.join",
        {"role": "developer", "agentId": "developer-a"},
        actor("workspace-user", "user"),
    )

    assert response["ok"] is True
    prompt = response["result"]["prompt"]
    forbidden_payload_fields = ["statePath", "workspaceRoot"]
    for needle in forbidden_payload_fields:
        assert needle not in prompt, (
            f"agent.join prompt leaked server-resolvable payload field: {needle!r}.\n"
            "The Sprint Engine MCP server resolves statePath and workspaceRoot from its "
            "launch env (SPRINTENGINE_STATE_PATH / SPRINTENGINE_WORKSPACE_ROOT) and from "
            "state-path-to-workspace-root derivation. Autonomous agent prompts must omit "
            "both fields from MCP tool payload examples."
        )
    # Confirm the absolute fixture path didn't leak either (catches accidental string
    # interpolation through the composed prompt, even if the field name was renamed).
    assert str(fixture.state_path) not in prompt, (
        "agent.join prompt leaked the resolved state path literal."
    )


def test_mcp_agent_join_succeeds_with_minimal_payload_from_env(tmp_path, monkeypatch) -> None:
    """Regression: agents can call join with just {role, agentId} when env vars are set.

    Multicode launches the managed Sprint Engine MCP server with
    SPRINTENGINE_STATE_PATH (and optionally SPRINTENGINE_WORKSPACE_ROOT) in its
    process env. Tool calls from autonomous agents must succeed without
    payload-supplied paths.
    """
    fixture = create_team(tmp_path, "mcp-join-env-fallback", [task("T1", "Smoke", "developer")])
    monkeypatch.setenv("SPRINTENGINE_STATE_PATH", str(fixture.state_path))
    monkeypatch.setenv("SPRINTENGINE_WORKSPACE_ROOT", str(tmp_path))

    server = SprintEngineMcpServer(allowed_roots=[tmp_path])
    response = server.call_tool(
        "sprintengine.agent.join",
        {"role": "developer", "agentId": "developer-a"},
        actor("workspace-user", "user"),
    )
    assert response["ok"] is True
    assert response["result"]["role"] == "developer"

    # task.next likewise resolves statePath from env.
    next_response = server.call_tool(
        "sprintengine.task.next",
        {"role": "developer", "id": "developer-a"},
        actor("workspace-user", "user"),
    )
    assert next_response["ok"] is True


def test_mcp_agent_heartbeat_preserves_assignment_state(tmp_path) -> None:
    fixture = create_team(tmp_path, "mcp-agent-heartbeat", [task("T1", "Heartbeat task", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])
    server.call_tool(
        "sprintengine.task.next",
        {"statePath": str(fixture.state_path), "role": "developer", "id": "developer-a"},
        actor("workspace-user", "user"),
    )
    before = read_state(fixture.state_path)["agents"]["developer-a"]

    response = server.call_tool(
        "sprintengine.agent.heartbeat",
        {"statePath": str(fixture.state_path), "agentId": "developer-a"},
        actor("workspace-user", "user"),
    )

    assert response["ok"] is True
    agent = response["result"]["agent"]
    assert agent["currentTaskId"] == before["currentTaskId"]
    assert agent["currentDispatch"] == before["currentDispatch"]
    assert response["result"]["assignmentUnchanged"]["currentDispatch"] is True


def test_mcp_agent_leave_releases_active_task_for_dispatch(tmp_path) -> None:
    fixture = create_team(tmp_path, "mcp-agent-leave-release", [task("T1", "Leave task", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])
    server.call_tool(
        "sprintengine.task.next",
        {"statePath": str(fixture.state_path), "role": "developer", "id": "developer-a"},
        actor("workspace-user", "user"),
    )

    response = server.call_tool(
        "sprintengine.agent.leave",
        {"statePath": str(fixture.state_path), "agentId": "developer-a", "reason": "terminal closed"},
        actor("workspace-user", "user"),
    )

    assert response["ok"] is True
    assert response["result"]["agent"]["status"] == "left"
    assert response["result"]["releasedTargets"] == [
        {"kind": "task", "taskId": "T1", "previousOwnerAgentId": "developer-a", "status": "todo"}
    ]
    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert task_record["status"] == "todo"
    assert task_record["ownerAgentId"] is None
    ready = server.call_tool(
        "sprintengine.task.list",
        {"statePath": str(fixture.state_path), "role": "developer"},
        actor("workspace-user", "user"),
    )
    assert [entry["id"] for entry in ready["result"]["readyTasks"]] == ["T1"]


def test_mcp_agent_leave_releases_active_gate_without_blocked_attempt(tmp_path) -> None:
    task_record = task("T1", "Reviewable task", "developer", "review", owner="developer-a")
    task_record["qualityGates"] = [
        {
            "id": "code-review",
            "phase": "review",
            "role": "code_reviewer",
            "status": "pending",
            "required": True,
            "allowSelfReview": True,
            "focus": "Review implementation.",
            "attempts": [],
        }
    ]
    fixture = create_team(tmp_path, "mcp-agent-leave-gate-release", [task_record])
    fixture.cli.run("task", "gate", "next", "--role", "code_reviewer", "--id", "code-reviewer-a")
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    response = server.call_tool(
        "sprintengine.agent.leave",
        {"statePath": str(fixture.state_path), "agentId": "code-reviewer-a", "reason": "terminal closed"},
        actor("workspace-user", "user"),
    )

    assert response["ok"] is True
    assert response["result"]["releasedTargets"] == [
        {"kind": "gate", "taskId": "T1", "gateId": "code-review", "attemptId": "GA-001"}
    ]
    state = read_state(fixture.state_path)
    gate = get_task(state, "T1")["qualityGates"][0]
    assert gate["status"] == "pending"
    assert gate["attempts"][0]["status"] == "released"
    assert gate["attempts"][0]["status"] != "blocked"

    reclaimed = fixture.cli.run("task", "gate", "next", "--role", "code_reviewer", "--id", "code-reviewer-b")
    assert reclaimed["claimed"] is True
    assert reclaimed["gate"]["status"] == "in_progress"
    assert reclaimed["attempt"]["id"] == "GA-002"


def test_mcp_registry_discovery_returns_roles_skills_soul_and_warnings(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    write_registry_role(workspace, "marketer", label="Growth Marketer", soul=[{"skill": "strategy"}, {"skill": "missing"}])
    write_registry_skill(workspace, "strategy", "---\nname: strategy\n---\n\nPlan for {{role}} in {{run_id}}.")
    write_registry_role(workspace, "writer", label="Writer", soul=[{"skill": "drafting"}])
    write_registry_skill(workspace, "drafting", "Draft for {{role}} in {{run_id}}.")
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    roles = server.call_tool(
        "sprintengine.roles.list",
        {"workspaceRoot": str(workspace), "includeShadowed": True},
        actor("workspace-user", "user"),
    )
    skills = server.call_tool(
        "sprintengine.skills.list",
        {"workspaceRoot": str(workspace)},
        actor("workspace-user", "user"),
    )
    soul = server.call_tool(
        "sprintengine.soul.get",
        {"workspaceRoot": str(workspace), "roleId": "writer", "runId": "run-123"},
        actor("workspace-user", "user"),
    )

    assert roles["ok"] is True
    assert any(role["id"] == "marketer" and role["source"]["layer"] == "workspace" for role in roles["result"]["roles"])
    assert any(warning["code"] == "missing_referenced_skill" for warning in roles["result"]["warnings"])
    assert skills["ok"] is True
    assert {skill["id"] for skill in skills["result"]["skills"]} >= {"strategy", "drafting"}
    assert all("body" not in skill for skill in skills["result"]["skills"])
    assert soul["ok"] is True
    assert soul["result"]["soul"]["content"] == "Draft for writer in run-123."
    assert str(tmp_path) not in json.dumps(roles["result"], sort_keys=True)


def test_mcp_registry_discovery_accepts_plugin_registry_roots(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    plugin_root = tmp_path / "plugin" / "souls"
    write_registry_role(plugin_root, "plugin_writer", label="Plugin Writer", soul=[{"skill": "plugin_writer"}])
    write_registry_skill(plugin_root, "plugin_writer", "Plugin writer Soul.")
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    roles = server.call_tool(
        "sprintengine.roles.list",
        {
            "workspaceRoot": str(workspace),
            "includeShadowed": True,
            "pluginRegistryRoots": [{"id": "writer-plugin", "root": str(plugin_root / ".sprintengine")}],
        },
        actor("workspace-user", "user"),
    )
    skills = server.call_tool(
        "sprintengine.skills.list",
        {
            "workspaceRoot": str(workspace),
            "pluginRegistryRoots": [{"id": "writer-plugin", "root": str(plugin_root / ".sprintengine")}],
        },
        actor("workspace-user", "user"),
    )

    assert roles["ok"] is True
    assert any(role["id"] == "plugin_writer" and role["source"]["layer"] == "plugin:writer-plugin" for role in roles["result"]["roles"])
    assert skills["ok"] is True
    assert any(skill["id"] == "plugin_writer" and skill["source"]["layer"] == "plugin:writer-plugin" for skill in skills["result"]["skills"])


def test_mcp_task_ready_uses_core_and_emits_audit(tmp_path) -> None:
    task_record = task("T1", "Ready through MCP", "developer")
    task_record["dispatch"] = {"mode": "manual", "status": "todo", "triagedBy": "none"}
    fixture = create_team(tmp_path, "mcp-task-ready", [task_record])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    response = server.call_tool(
        "sprintengine.task.ready",
        {"statePath": str(fixture.state_path), "taskId": "T1", "id": "workspace-user", "triagedBy": "user"},
        actor("workspace-user", "user"),
    )

    assert response["ok"] is True
    assert response["result"]["ok"] is True
    assert response["result"]["task"]["dispatch"]["status"] == "ready"
    state = read_state(fixture.state_path)
    assert get_task(state, "T1")["dispatch"]["triagedBy"] == "user"
    assert [row["operation_name"] for row in audit_rows(fixture.team_dir)] == ["sprintengine.task.ready"]


def test_mcp_plan_add_task_can_create_manual_dispatch_local_task(tmp_path) -> None:
    fixture = create_team(tmp_path, "mcp-plan-add-manual-task", [])
    state = read_state(fixture.state_path)
    state["sprintengine"]["rosterConfigured"] = True
    state["agents"] = {
        "developer-a": {"role": "developer", "status": "idle", "currentTaskId": None},
    }
    write_state(fixture.state_path, state)
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    response = server.call_tool(
        "sprintengine.plan.add_task",
        {
            "statePath": str(fixture.state_path),
            "title": "Local manual task",
            "description": "Refined execution brief",
            "role": "developer",
            "acceptance": ["Manual gate remains closed."],
            "note": ["Use the existing board."],
            "taskNote": ["Created locally."],
            "manualDispatch": True,
        },
        actor("workspace-user", "user"),
    )

    assert response["ok"] is True
    task_record = response["result"]["task"]
    assert task_record["dispatch"] == {"mode": "manual", "status": "todo", "triagedBy": "none"}
    assert task_record["notes"] == ["Created locally."]
    state = read_state(fixture.state_path)
    assert get_task(state, task_record["id"])["dispatch"]["status"] == "todo"


def test_mcp_plan_add_and_update_task_forward_needs_triage(tmp_path) -> None:
    fixture = create_team(tmp_path, "mcp-plan-needs-triage", [])
    state = read_state(fixture.state_path)
    state["sprintengine"]["rosterConfigured"] = True
    state["agents"] = {
        "developer-a": {"role": "developer", "status": "idle", "currentTaskId": None},
    }
    write_state(fixture.state_path, state)
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    response = server.call_tool(
        "sprintengine.plan.add_task",
        {
            "statePath": str(fixture.state_path),
            "title": "Candidate task",
            "role": "developer",
            "needsTriage": True,
            "noQualityGates": True,
            "difficultyPct": 42,
            "difficultyReason": "Small scoped task with known files.",
        },
        actor("workspace-user", "user"),
    )

    assert response["ok"] is True
    task_record = response["result"]["task"]
    assert task_record["needsTriage"] is True
    assert task_record["difficulty"]["architectEstimatePct"] == 42

    update = server.call_tool(
        "sprintengine.plan.update_task",
        {
            "statePath": str(fixture.state_path),
            "taskId": task_record["id"],
            "clearNeedsTriage": True,
            "difficultyPct": 55,
            "difficultyReason": "Scope expanded during planning.",
        },
        actor("workspace-user", "user"),
    )

    assert update["ok"] is True
    assert update["result"]["task"]["needsTriage"] is False
    assert update["result"]["task"]["difficulty"]["architectEstimatePct"] == 55


def test_mcp_plan_add_task_forwards_quality_gate_flags(tmp_path) -> None:
    fixture = create_team(tmp_path, "mcp-plan-quality-flags", [])
    state = read_state(fixture.state_path)
    state["sprintengine"]["rosterConfigured"] = True
    state["agents"] = {
        "architect": {"role": "architect", "status": "idle", "currentTaskId": None},
        "code-reviewer": {"role": "code_reviewer", "status": "idle", "currentTaskId": None},
    }
    write_state(fixture.state_path, state)
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    response = server.call_tool(
        "sprintengine.plan.add_task",
        {
            "statePath": str(fixture.state_path),
            "title": "Architect implementation",
            "role": "architect",
            "path": ["docs/sprintengine-cli.md"],
            "producesImplementation": True,
            "requireGate": ["code-reviewer"],
        },
        actor("workspace-user", "user"),
    )

    assert response["ok"] is True
    task_record = response["result"]["task"]
    assert task_record["producesImplementation"] is True
    assert [gate["id"] for gate in task_record["qualityGates"]] == ["code_reviewer"]


def test_mcp_plan_update_task_edits_execution_details_and_preserves_source(tmp_path) -> None:
    task_record = task("T1", "Imported GitHub issue", "developer")
    task_record["source"] = {
        "type": "github",
        "externalId": "123",
        "externalUrl": "https://github.com/example/repo/issues/123",
        "repo": "example/repo",
        "title": "Remote title",
        "body": "Remote body",
        "syncStatus": "clean",
    }
    task_record["dispatch"] = {"mode": "manual", "status": "todo", "triagedBy": "none"}
    fixture = create_team(tmp_path, "mcp-plan-update-details", [task_record])
    state = read_state(fixture.state_path)
    state["sprintengine"]["rosterConfigured"] = True
    state["agents"] = {
        "tester": {"role": "tester", "status": "idle", "currentTaskId": None},
    }
    write_state(fixture.state_path, state)
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    response = server.call_tool(
        "sprintengine.plan.update_task",
        {
            "statePath": str(fixture.state_path),
            "taskId": "T1",
            "title": "Refined task",
            "description": "Local execution brief",
            "role": "tester",
            "acceptance": ["Behavior is verified."],
            "note": ["Implementation note."],
            "taskNote": ["Task note."],
        },
        actor("workspace-user", "user"),
    )

    assert response["ok"] is True
    updated = response["result"]["task"]
    assert updated["title"] == "Refined task"
    assert updated["description"] == "Local execution brief"
    assert updated["role"] == "tester"
    assert updated["acceptanceCriteria"] == ["Behavior is verified."]
    assert updated["implementationNotes"] == ["Implementation note."]
    assert updated["notes"] == ["Task note."]
    assert updated["source"]["externalId"] == "123"
    assert updated["dispatch"]["status"] == "todo"


def test_mcp_health_reports_allowed_root_and_capabilities(tmp_path) -> None:
    fixture = create_team(tmp_path, "mcp-health", [task("T1", "Health", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    response = server.call_tool("sprintengine.health", {"statePath": str(fixture.state_path)}, actor("workspace-user"))

    assert response["ok"] is True
    report = response["result"]
    assert report["backendMode"] == "mcp-local"
    assert report["schemaVersion"] == 1
    assert report["allowedRoot"]["allowed"] is True
    assert report["capabilities"] == {"read": True, "write": True}


def test_stdio_transport_exercises_initialize_read_and_mutating_tool(tmp_path) -> None:
    fixture = create_team(tmp_path, "mcp-stdio-smoke", [task("T1", "Smoke task", "developer")])
    actor_context = actor("workspace-user")
    messages = [
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "clientInfo": {"name": "pytest-smoke", "version": "0"},
            },
        },
        {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": "sprintengine.task.list",
                "arguments": {"statePath": str(fixture.state_path), "role": "developer"},
                "actor": actor_context,
            },
        },
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "sprintengine.task.next",
                "arguments": {"statePath": str(fixture.state_path), "role": "developer", "id": "developer-stdio"},
                "actor": actor_context,
            },
        },
    ]

    completed = subprocess.run(
        [sys.executable, "-m", "sprintengine_mcp", "--allowed-root", str(tmp_path)],
        cwd=REPO_ROOT,
        env={
            **os.environ,
            "SPRINTENGINE_MCP_USER_ID": "workspace-user",
            "SPRINTENGINE_MCP_USER_AUTHORIZED": "1",
        },
        input="\n".join(json.dumps(message) for message in messages) + "\n",
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=10,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    responses = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
    assert [response["id"] for response in responses] == [1, 2, 3]
    assert responses[0]["result"]["capabilities"] == {"tools": {}}
    # tools/call responses are wrapped as MCP CallToolResult: { content, isError }.
    listed_wrapper = responses[1]["result"]
    claimed_wrapper = responses[2]["result"]
    assert listed_wrapper["content"][0]["type"] == "text"
    assert listed_wrapper["isError"] is False
    assert claimed_wrapper["isError"] is False
    listed = json.loads(listed_wrapper["content"][0]["text"])
    claimed = json.loads(claimed_wrapper["content"][0]["text"])
    assert listed["ok"] is True
    assert [entry["id"] for entry in listed["result"]["readyTasks"]] == ["T1"]
    assert claimed["ok"] is True
    assert claimed["result"]["claimed"] is True
    assert claimed["result"]["task"]["id"] == "T1"

    state = read_state(fixture.state_path)
    assert get_task(state, "T1")["ownerAgentId"] == "developer-stdio"
    assert [row["operation_name"] for row in audit_rows(fixture.team_dir)] == ["sprintengine.task.next"]


def test_stdio_transport_silently_accepts_jsonrpc_notifications(tmp_path) -> None:
    # Regression: Claude Code's MCP transport closes with code -32603 if the server
    # replies to a notifications/* message. JSON-RPC 2.0 requires no response to any
    # message that lacks an `id` field.
    fixture = create_team(tmp_path, "mcp-stdio-notifications", [task("T1", "Smoke task", "developer")])
    messages = [
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": "2024-11-05", "clientInfo": {"name": "pytest", "version": "0"}},
        },
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 42}},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
    ]
    completed = subprocess.run(
        [sys.executable, "-m", "sprintengine_mcp", "--allowed-root", str(tmp_path)],
        cwd=REPO_ROOT,
        env={
            **os.environ,
            "SPRINTENGINE_MCP_USER_ID": "workspace-user",
            "SPRINTENGINE_MCP_USER_AUTHORIZED": "1",
        },
        input="\n".join(json.dumps(message) for message in messages) + "\n",
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=10,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    responses = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
    assert [response["id"] for response in responses] == [1, 2], (
        f"notifications must not produce response lines; got: {completed.stdout}"
    )
    assert responses[0]["result"]["serverInfo"]["name"] == "sprintengine-mcp"
    assert responses[1]["result"]["tools"], "tools/list should still return tools after the notifications"
    _ = fixture


def test_stdio_transport_rejects_request_supplied_actor_without_verified_server_user(tmp_path) -> None:
    fixture = create_team(tmp_path, "mcp-stdio-untrusted-actor", [task("T1", "Smoke task", "developer")])
    message = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "sprintengine.task.list",
            "arguments": {"statePath": str(fixture.state_path), "role": "developer"},
            "actor": {"id": "self-attested-user", "authenticated": True, "mcpAuthorized": True},
        },
    }

    env = os.environ.copy()
    env.pop("SPRINTENGINE_MCP_USER_ID", None)
    env.pop("SPRINTENGINE_MCP_USER_AUTHORIZED", None)
    completed = subprocess.run(
        [sys.executable, "-m", "sprintengine_mcp", "--allowed-root", str(tmp_path)],
        cwd=REPO_ROOT,
        env=env,
        input=json.dumps(message) + "\n",
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=10,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    response = json.loads(completed.stdout)
    wrapper = response["result"]
    assert wrapper["isError"] is True
    result = json.loads(wrapper["content"][0]["text"])
    assert result["ok"] is False
    assert result["error"]["code"] == "unauthorized"
    assert "authenticated actor context" in result["error"]["message"]


def test_http_transport_exercises_initialize_tools_list_and_tool_call(tmp_path) -> None:
    fixture = create_team(tmp_path, "mcp-http-smoke", [task("T1", "HTTP task", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    with run_http_mcp_server(server, token="secret-token") as base_url:
        run = register_http_run(
            base_url,
            token="secret-token",
            run_id="launch-session-a",
            workspace_root=tmp_path,
            state_path=fixture.state_path,
            allowed_roots=[tmp_path],
        )
        init_status, init_headers, init_body = http_post(
            base_url,
            token=run["runToken"],
            payload={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {"protocolVersion": "2024-11-05", "clientInfo": {"name": "pytest", "version": "0"}},
            },
        )
        session_id = init_headers[SESSION_HEADER]

        assert init_status == 200
        assert init_body["result"]["serverInfo"]["name"] == "sprintengine-mcp"
        assert session_id

        list_status, _, list_body = http_post(
            base_url,
            token=run["runToken"],
            session_id=session_id,
            payload={"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        )
        assert list_status == 200
        assert any(tool["name"] == "sprintengine.task.list" for tool in list_body["result"]["tools"])

        call_status, _, call_body = http_post(
            base_url,
            token=run["runToken"],
            session_id=session_id,
            payload={
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": "sprintengine.task.list",
                    "arguments": {"role": "developer"},
                },
            },
        )
        wrapper = call_body["result"]
        result = json.loads(wrapper["content"][0]["text"])

        assert call_status == 200
        assert wrapper["isError"] is False
        assert result["ok"] is True
        assert [entry["id"] for entry in result["result"]["readyTasks"]] == ["T1"]


def test_handover_resolves_project_relative_bundle_paths_against_http_workspace_root(tmp_path, monkeypatch) -> None:
    workspace = tmp_path / "workspace"
    server_cwd = tmp_path / "server-cwd"
    (workspace / "product" / ".versions").mkdir(parents=True)
    (workspace / "mockups" / ".versions").mkdir(parents=True)
    server_cwd.mkdir()
    (workspace / "product" / "build-handoff.md").write_text("# Build Handoff\n", encoding="utf-8")
    (workspace / "product" / ".versions" / "brief.md").write_text("# Product Brief\n", encoding="utf-8")
    (workspace / "product" / ".versions" / "plan.md").write_text("# Architecture Plan\n", encoding="utf-8")
    (workspace / "product" / ".versions" / "ui.md").write_text("# UI Direction\n", encoding="utf-8")
    (workspace / "mockups" / ".versions" / "app.html").write_text("<!doctype html><title>Mockup</title>", encoding="utf-8")
    state_path = workspace / ".multi-code" / "sprintengine" / "guided-build" / "run.yaml"
    context = McpRequestContext(
        actor=ActorContext(id="workspace-user", role="user", authenticated=True, mcp_authorized=True),
        state_path=state_path,
        workspace_root=workspace,
        allowed_roots=(workspace,),
    )
    server = SprintEngineMcpServer(allowed_roots=[server_cwd])
    monkeypatch.chdir(server_cwd)

    handover = server.call_tool(
        "sprintengine.handover",
        {
            "name": "guided-build",
            "goal": "Build the accepted guided brief.",
            "handoverPath": "product/build-handoff.md",
            "sourcePlanKind": "unknown",
            "sourceBundle": [
                {"kind": "product_plan", "sourcePath": "product/.versions/brief.md"},
                {"kind": "architect_plan", "sourcePath": "product/.versions/plan.md"},
                {"kind": "design_notes", "sourcePath": "product/.versions/ui.md"},
                {"kind": "html_mockup", "sourcePath": "mockups/.versions/app.html"},
            ],
        },
        context=context,
    )
    initialized = server.call_tool("sprintengine.init", {"goal": "Build the accepted guided brief."}, context=context)

    assert handover["ok"] is True
    assert initialized["ok"] is True
    assert (state_path.parent / "handover.md").read_text(encoding="utf-8") == "# Build Handoff\n"
    assert (state_path.parent / "product-requirements.md").read_text(encoding="utf-8") == "# Product Brief\n"
    assert (state_path.parent / "plan.md").read_text(encoding="utf-8") == "# Architecture Plan\n"
    state = read_state(state_path)
    bundle = state["sourceBundle"]
    assert [item["kind"] for item in bundle] == ["product_plan", "architect_plan", "design_notes", "html_mockup"]
    notes = "\n".join(initialized["result"]["planTask"].get("implementationNotes", []))
    assert "Use design notes" in notes
    assert "Use source mockup" in notes


def test_http_run_tokens_route_to_distinct_registered_state_paths(tmp_path) -> None:
    first = create_workspace_team(tmp_path, "workspace-a", "team-a", [task("T1", "First task", "developer")])
    second = create_workspace_team(tmp_path, "workspace-b", "team-b", [task("T2", "Second task", "developer")])
    server = SprintEngineMcpServer()

    with run_http_mcp_server(server, token="secret-token") as base_url:
        first_run = register_http_run(
            base_url,
            token="secret-token",
            run_id="launch-a",
            workspace_root=tmp_path / "workspace-a",
            state_path=first.state_path,
            allowed_roots=[tmp_path / "workspace-a"],
        )
        second_run = register_http_run(
            base_url,
            token="secret-token",
            run_id="launch-b",
            workspace_root=tmp_path / "workspace-b",
            state_path=second.state_path,
            allowed_roots=[tmp_path / "workspace-b"],
        )

        _, first_headers, _ = http_post(
            base_url,
            token=first_run["runToken"],
            payload={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
        )
        _, second_headers, _ = http_post(
            base_url,
            token=second_run["runToken"],
            payload={"jsonrpc": "2.0", "id": 2, "method": "initialize", "params": {}},
        )

        first_status, _, first_body = http_post(
            base_url,
            token=first_run["runToken"],
            session_id=first_headers[SESSION_HEADER],
            payload={
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": "sprintengine.task.list", "arguments": {"role": "developer"}},
            },
        )
        second_status, _, second_body = http_post(
            base_url,
            token=second_run["runToken"],
            session_id=second_headers[SESSION_HEADER],
            payload={
                "jsonrpc": "2.0",
                "id": 4,
                "method": "tools/call",
                "params": {"name": "sprintengine.task.list", "arguments": {"role": "developer"}},
            },
        )

    first_result = json.loads(first_body["result"]["content"][0]["text"])
    second_result = json.loads(second_body["result"]["content"][0]["text"])
    assert first_status == 200
    assert second_status == 200
    assert [entry["id"] for entry in first_result["result"]["readyTasks"]] == ["T1"]
    assert [entry["id"] for entry in second_result["result"]["readyTasks"]] == ["T2"]


def test_http_run_token_rejects_cross_workspace_state_path(tmp_path) -> None:
    first = create_workspace_team(tmp_path, "workspace-a", "team-a", [task("T1", "First task", "developer")])
    second = create_workspace_team(tmp_path, "workspace-b", "team-b", [task("T2", "Second task", "developer")])
    server = SprintEngineMcpServer()

    with run_http_mcp_server(server, token="secret-token") as base_url:
        run = register_http_run(
            base_url,
            token="secret-token",
            run_id="launch-a",
            workspace_root=tmp_path / "workspace-a",
            state_path=first.state_path,
            allowed_roots=[tmp_path / "workspace-a"],
        )
        _, headers, _ = http_post(
            base_url,
            token=run["runToken"],
            payload={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
        )
        status, _, body = http_post(
            base_url,
            token=run["runToken"],
            session_id=headers[SESSION_HEADER],
            payload={
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "name": "sprintengine.task.list",
                    "arguments": {"statePath": str(second.state_path), "role": "developer"},
                },
            },
        )

    result = json.loads(body["result"]["content"][0]["text"])
    assert status == 200
    assert body["result"]["isError"] is True
    assert result["ok"] is False
    assert result["error"]["code"] == "state_path_not_allowed"


def test_http_run_token_rejects_cross_workspace_root_for_run_tool(tmp_path) -> None:
    first = create_workspace_team(tmp_path, "workspace-a", "team-a", [task("T1", "First task", "developer")])
    create_workspace_team(tmp_path, "workspace-b", "team-b", [task("T2", "Second task", "developer")])
    server = SprintEngineMcpServer()

    with run_http_mcp_server(server, token="secret-token") as base_url:
        run = register_http_run(
            base_url,
            token="secret-token",
            run_id="launch-a",
            workspace_root=tmp_path / "workspace-a",
            state_path=first.state_path,
            allowed_roots=[tmp_path / "workspace-a"],
        )
        _, headers, _ = http_post(
            base_url,
            token=run["runToken"],
            payload={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
        )
        status, _, body = http_post(
            base_url,
            token=run["runToken"],
            session_id=headers[SESSION_HEADER],
            payload={
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "name": "sprintengine.task.list",
                    "arguments": {"workspaceRoot": str(tmp_path / "workspace-b"), "role": "developer"},
                },
            },
        )

    result = json.loads(body["result"]["content"][0]["text"])
    assert status == 200
    assert body["result"]["isError"] is True
    assert result["ok"] is False
    assert result["error"]["code"] == "workspace_root_not_allowed"


def test_http_run_token_allows_different_agent_payload_identities_in_same_run(tmp_path) -> None:
    fixture = create_workspace_team(tmp_path, "workspace-a", "team-a", [task("T1", "First task", "developer")])
    server = SprintEngineMcpServer()

    with run_http_mcp_server(server, token="secret-token") as base_url:
        run = register_http_run(
            base_url,
            token="secret-token",
            run_id="launch-a",
            workspace_root=tmp_path / "workspace-a",
            state_path=fixture.state_path,
            allowed_roots=[tmp_path / "workspace-a"],
        )
        _, headers, _ = http_post(
            base_url,
            token=run["runToken"],
            payload={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
        )
        _, _, task_body = http_post(
            base_url,
            token=run["runToken"],
            session_id=headers[SESSION_HEADER],
            payload={
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {"name": "sprintengine.task.claim", "arguments": {"taskId": "T1", "id": "developer-b"}},
            },
        )

    task_result = json.loads(task_body["result"]["content"][0]["text"])
    assert task_body["result"]["isError"] is False
    assert task_result["ok"] is True
    assert task_result["result"]["task"]["ownerAgentId"] == "developer-b"


def test_http_transport_requires_bearer_token(tmp_path) -> None:
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    with run_http_mcp_server(server, token="secret-token") as base_url:
        status, _, body = http_post(
            base_url,
            token="wrong-token",
            payload={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
            expect_error=True,
        )

    assert status == 401
    assert body == {"error": "unauthorized"}


def test_http_transport_get_requires_bearer_token_before_method_rejection(tmp_path) -> None:
    fixture = create_team(tmp_path, "mcp-http-get", [task("T1", "HTTP task", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    with run_http_mcp_server(server, token="secret-token") as base_url:
        run = register_http_run(
            base_url,
            token="secret-token",
            run_id="launch-get",
            workspace_root=tmp_path,
            state_path=fixture.state_path,
            allowed_roots=[tmp_path],
        )
        unauthorized_status, unauthorized_body = http_get(base_url, expect_error=True)
        admin_status, admin_body = http_get(base_url, token="secret-token", expect_error=True)
        rejected_status, rejected_body = http_get(base_url, token=run["runToken"], expect_error=True)

    assert unauthorized_status == 401
    assert unauthorized_body == {"error": "unauthorized"}
    assert admin_status == 401
    assert admin_body == {"error": "unauthorized"}
    assert rejected_status == 405
    assert rejected_body == {"error": "sse_not_supported"}


def test_http_transport_requires_session_after_initialize(tmp_path) -> None:
    fixture = create_team(tmp_path, "mcp-http-session-required", [task("T1", "HTTP task", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    with run_http_mcp_server(server, token="secret-token") as base_url:
        run = register_http_run(
            base_url,
            token="secret-token",
            run_id="launch-session-required",
            workspace_root=tmp_path,
            state_path=fixture.state_path,
            allowed_roots=[tmp_path],
        )
        status, _, body = http_post(
            base_url,
            token=run["runToken"],
            payload={"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            expect_error=True,
        )

    assert status == 400
    assert body["error"]["code"] == "invalid_session"


def test_http_transport_requires_registered_run_token_for_initialize(tmp_path) -> None:
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    with run_http_mcp_server(server, token="secret-token") as base_url:
        status, _, body = http_post(
            base_url,
            token="secret-token",
            payload={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
            expect_error=True,
        )

    assert status == 401
    assert body == {"error": "unauthorized"}


def test_http_transport_rejects_non_local_origin(tmp_path) -> None:
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    with run_http_mcp_server(server, token="secret-token") as base_url:
        status, _, body = http_post(
            base_url,
            token="secret-token",
            payload={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
            origin="https://example.com",
            expect_error=True,
        )

    assert status == 403
    assert body == {"error": "origin_not_allowed"}


def test_sprintengine_mcp_serve_matches_module_entrypoint_roots_and_extra_dirs(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    outside = tmp_path / "outside"
    fixture = create_team(outside, "mcp-serve-outside", [task("T1", "Outside task", "developer")])
    plugin_root = tmp_path / "plugin"
    registry_root = plugin_root / ".sprintengine"
    write_registry_role(plugin_root, "plugin_writer", label="Plugin Writer", soul=[{"skill": "plugin_writer"}])
    write_registry_skill(plugin_root, "plugin_writer", "Plugin writer Soul.")
    messages = [
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "sprintengine.roles.list",
                "arguments": {"workspaceRoot": str(workspace)},
            },
        },
        {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": "sprintengine.task.list",
                "arguments": {"statePath": str(fixture.state_path), "role": "developer"},
            },
        },
    ]

    completed = subprocess.run(
        [
            str(REPO_ROOT / "scripts" / "sprintengine"),
            "mcp",
            "serve",
            "--workspace",
            str(workspace),
            "--extra-dir",
            str(registry_root),
        ],
        cwd=REPO_ROOT,
        env={
            **os.environ,
            "SPRINTENGINE_MCP_USER_ID": "workspace-user",
            "SPRINTENGINE_MCP_USER_AUTHORIZED": "1",
        },
        input="\n".join(json.dumps(message) for message in messages) + "\n",
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=10,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    responses = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
    roles_wrapper = responses[0]["result"]
    task_wrapper = responses[1]["result"]
    assert roles_wrapper["isError"] is False
    assert task_wrapper["isError"] is True
    roles_result = json.loads(roles_wrapper["content"][0]["text"])
    task_result = json.loads(task_wrapper["content"][0]["text"])
    assert roles_result["ok"] is True
    assert any(role["id"] == "plugin_writer" and role["source"]["layer"] == "plugin:0" for role in roles_result["result"]["roles"])
    assert task_result["ok"] is False
    assert task_result["error"]["code"] == "state_path_not_allowed"


def test_sprintengine_mcp_serve_forwards_http_flags() -> None:
    completed = subprocess.run(
        [
            str(REPO_ROOT / "scripts" / "sprintengine"),
            "mcp",
            "serve",
            "--http",
            "--host",
            "0.0.0.0",
            "--auth-token",
            "secret-token",
        ],
        cwd=REPO_ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=10,
        check=False,
    )

    assert completed.returncode == 2
    assert "only supports host 127.0.0.1" in completed.stderr


def test_mcp_feedback_tools_return_sanitized_summary_and_recommendations(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "mcp-feedback",
        [task("T1", "Feedback", "developer", status="done", owner="developer-a")],
    )
    metrics_dir = fixture.team_dir / "metrics"
    metrics_dir.mkdir(exist_ok=True)
    (metrics_dir / "agent-feedback.jsonl").write_text(
        json.dumps(
            {
                "schema_version": 3,
                "source": "agent_self_report",
                "run_id": "mcp-feedback",
                "agent_id": "developer-a",
                "role": "developer",
                "task_id": "T1",
                "scores": {"task_clarity_pct": 40},
                "top_friction": "pytest dependency split exposed TERMINAL_OUTPUT_SECRET",
            }
        )
        + "\n",
        encoding="utf-8",
    )
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    summary = server.call_tool(
        "sprintengine.feedback.summarize",
        {"statePath": str(fixture.state_path)},
        actor("workspace-user"),
    )
    recommendations = server.call_tool(
        "sprintengine.feedback.recommend_actions",
        {"statePath": str(fixture.state_path)},
        actor("workspace-user"),
    )

    assert summary["ok"] is True
    assert summary["result"]["summary"]["feedbackRecordCount"] == 1
    assert "TERMINAL_OUTPUT_SECRET" not in json.dumps(summary, sort_keys=True)
    assert recommendations["ok"] is True
    assert recommendations["result"]["recommendations"][0]["category"] in {"task_card", "tooling"}


def test_concurrent_mcp_claims_are_serialized_by_core_lock(tmp_path) -> None:
    fixture = create_team(tmp_path, "mcp-concurrent", [task("T1", "Concurrent claim", "developer")])

    code = """
import json
import sys
from sprintengine_mcp import SprintEngineMcpServer

server = SprintEngineMcpServer(allowed_roots=[sys.argv[1]])
payload = {"statePath": sys.argv[2], "taskId": "T1", "id": sys.argv[3]}
actor = {"id": sys.argv[3], "role": "developer"}
print(json.dumps(server.call_tool("sprintengine.task.claim", payload, actor)))
"""
    processes = [
        subprocess.Popen(
            [sys.executable, "-c", code, str(tmp_path), str(fixture.state_path), agent_id],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        for agent_id in ["developer-a", "developer-b"]
    ]
    completed = [process.communicate(timeout=10) for process in processes]
    assert [process.returncode for process in processes] == [0, 0]
    payloads = [json.loads(stdout) for stdout, _stderr in completed]
    successes = [payload for payload in payloads if payload["ok"] is True and payload["result"]["ok"] is True]
    failures = [payload for payload in payloads if payload["ok"] is False or payload["result"].get("ok") is False]

    assert len(successes) == 1
    assert len(failures) == 1
    state = read_state(fixture.state_path)
    assert get_task(state, "T1")["status"] == "in_progress"
    assert sum(row["operation_name"] == "sprintengine.task.claim" for row in audit_rows(fixture.team_dir)) == 2
