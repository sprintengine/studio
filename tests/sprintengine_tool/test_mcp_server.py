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
from sprintengine_mcp.http_server import (
    METHOD_HEADER,
    NAME_HEADER,
    PROTOCOL_VERSION_HEADER,
    SESSION_HEADER,
    STATELESS_PROTOCOL_VERSION,
    SprintEngineHttpMcpServer,
)
from sprintengine_mcp.payloads import command_payload_to_namespace
from sprintengine_mcp.protocol import DEFAULT_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS
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


def write_registry_role(root, role_id: str, *, label: str | None = None, implement: list[dict] | None = None) -> None:
    roles_dir = root / ".sprintengine" / "roles"
    roles_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "id": role_id,
        "label": label or role_id.replace("_", " ").title(),
        "aliases": [role_id.replace("_", "-")],
        "summary": f"{role_id} summary",
        "directives": {"implement": implement or [{"skill": role_id}]},
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
    extra_headers: dict[str, str | None] | None = None,
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
    # Merged last so a test can override any built-in header, or drop one with a
    # None value: half the stateless contract is about which headers are ABSENT.
    for name, value in (extra_headers or {}).items():
        if value is None:
            headers.pop(name, None)
        else:
            headers[name] = value
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
        # MC-1591 deleted the roster-growth and dispatch-cursor tools (add/retire/
        # replenish/list, subscribe, dispatch.next/ack): leases replaced the roster.
        # MC-1889 deleted `roster.configure` with the architect-picks formation, so
        # no roster tool remains on the MCP surface at all.
        "sprintengine.agent.join",
        "sprintengine.agent.heartbeat",
        "sprintengine.agent.leave",
        "sprintengine.join",
        "sprintengine.summary",
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
        "sprintengine.task.log",
        "sprintengine.task.publish",
        "sprintengine.task.note",
        "sprintengine.task.comment",
        "sprintengine.task.comment.list",
        "sprintengine.task.list",
        "sprintengine.task.advance",
        "sprintengine.plan.add_task",
        "sprintengine.plan.update_task",
        "sprintengine.plan.delete_task",
        "sprintengine.plan.add_dependency",
        "sprintengine.plan.remove_dependency",
        "sprintengine.plan.list",
        "sprintengine.plan.read",
        "sprintengine.artifact.add",
        "sprintengine.artifact.list",
        "sprintengine.artifact.ready",
        "sprintengine.artifact.approve",
        "sprintengine.artifact.request_changes",
        "sprintengine.vcs.status",
        "sprintengine.vcs.commit",
        "sprintengine.vcs.request_repo",
        "sprintengine.vcs.pr",
        "sprintengine.run.get",
        "sprintengine.run.policy.get",
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
        "sprintengine.join": {"role": "developer", "id": "developer-1"},
        "sprintengine.summary": {},
        "sprintengine.triage.needs_input": {"id": "architect"},
        "sprintengine.task.next": {"role": "developer", "id": "developer-1"},
        "sprintengine.task.claim": {"taskId": "T1", "id": "developer-1"},
        "sprintengine.task.status": {"taskId": "T1", "status": "done", "id": "developer-1"},
        "sprintengine.task.resolve_input": {"taskId": "T1", "id": "developer-1", "resolution": "resolved"},
        "sprintengine.task.release": {"taskId": "T1", "id": "developer-1", "reason": "released"},
        "sprintengine.task.log": {"taskId": "T1", "id": "developer-1"},
        "sprintengine.task.publish": {"taskId": "T1", "id": "developer-1", "summary": "ready"},
        "sprintengine.task.note": {"taskId": "T1", "id": "developer-1", "note": "note"},
        "sprintengine.task.comment": {"taskId": "T1", "id": "developer-1", "body": "comment"},
        "sprintengine.task.comment.list": {"taskId": "T1"},
        "sprintengine.task.list": {},
        "sprintengine.task.advance": {"taskId": "T1", "id": "developer-1", "phase": "review", "outcome": "pass", "summary": "ok"},
        "sprintengine.plan.add_task": {"title": "Task", "role": "developer"},
        "sprintengine.plan.update_task": {"taskId": "T1"},
        "sprintengine.plan.delete_task": {"taskId": "T1"},
        "sprintengine.plan.add_dependency": {"taskId": "T1", "dependsOn": ["T0"]},
        "sprintengine.plan.remove_dependency": {"taskId": "T1", "dependsOn": ["T0"]},
        "sprintengine.plan.list": {},
        "sprintengine.artifact.add": {"taskId": "T1", "kind": "plan", "title": "Plan", "path": "plan.md"},
        "sprintengine.artifact.list": {},
        "sprintengine.artifact.ready": {"artifactId": "A1", "id": "developer-1"},
        "sprintengine.artifact.approve": {"artifactId": "A1", "id": "product"},
        "sprintengine.artifact.request_changes": {"artifactId": "A1", "id": "product", "feedback": "revise"},
        "sprintengine.vcs.status": {},
        "sprintengine.vcs.commit": {"taskId": "T1", "id": "developer-1"},
        "sprintengine.vcs.request_repo": {"root": "../multicode-mobile", "id": "developer-1"},
        "sprintengine.vcs.pr": {},
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
    assert "sprintengine.task.advance" in result["markdown"]
    assert "You own your task from claim to done" in result["markdown"]
    # MC-1614: the commit an agent reads about is per project, not per run — the
    # lock it names is the task's own project's.
    assert "in your task's project worktree, under that project's commit lock" in result["markdown"]
    assert "sprintengine.vcs.commit" in result["markdown"]
    # MC-1542: the retired review protocol must not linger in the workflow an
    # agent reads on every join.
    assert "sprintengine.gate." not in result["markdown"]
    assert "request_changes" not in result["markdown"]


def test_mcp_v1_contract_schemas_include_planned_lifecycle_tools() -> None:
    planned = {
        "sprintengine.help",
        "sprintengine.handover",
        "sprintengine.agent.join",
        "sprintengine.agent.heartbeat",
        "sprintengine.agent.leave",
        "sprintengine.triage.needs_input",
        "sprintengine.roles.list",
        "sprintengine.roles.get",
        "sprintengine.soul.get",
        "sprintengine.skills.list",
        "sprintengine.skill.get",
        "sprintengine.task.get",
        "sprintengine.task.publish",
        "sprintengine.task.advance",
        "sprintengine.run.get",
        "sprintengine.run.policy.get",
        "sprintengine.run.subscribe",
        "sprintengine.plan.list",
        "sprintengine.plan.read",
    }
    active_now = planned

    assert planned <= set(MCP_V1_CONTRACT_SCHEMAS)
    assert active_now <= set(TOOL_SCHEMAS)
    assert MCP_V1_CONTRACT_SCHEMAS["sprintengine.task.status"]["properties"]["status"]["enum"]
    advance = MCP_V1_CONTRACT_SCHEMAS["sprintengine.task.advance"]["properties"]
    assert advance["phase"]["enum"] == ["review"]
    assert advance["outcome"]["enum"] == ["escalate", "pass", "pass_with_fixes"]
    # `escalate` is the only needs-input route out of a phase, so advance carries
    # the needs-input fields the retired request_changes tool refused.
    assert "needsInputKind" in advance
    assert "needsInputQuestion" in advance


def test_mcp_feedback_schemas_expose_known_feedback_fields() -> None:
    feedback_tools = [
        "sprintengine.task.status",
        "sprintengine.task.advance",
        "sprintengine.artifact.ready",
    ]

    # Schemas advertise camelCase only; the snake_case spellings stay accepted
    # by the payload adapter but must not bloat every reviewer's tool listing.
    for tool_name in feedback_tools:
        schema = MCP_V1_CONTRACT_SCHEMAS[tool_name]
        properties = schema["properties"]
        assert schema["additionalProperties"] is True
        for attr, camel, _ in FEEDBACK_SCORE_FIELDS:
            assert attr not in properties
            assert properties[camel]["maximum"] == 100
        for attr, camel, _ in FEEDBACK_COUNT_FIELDS:
            assert attr not in properties
            assert properties[camel]["minimum"] == 0
        for attr, camel, _ in FEEDBACK_TEXT_FIELDS:
            assert attr not in properties
            assert properties[camel]["type"] == "string"
        assert "issue_json" not in properties
        assert "issueJson" in properties
        assert "finding_json" not in properties
        assert "findingJson" in properties
    # MC-1542 deleted the reviewer-difficulty assessment with the reviewer role:
    # a phase advance is the owner reporting on its own work, so there is no
    # second party to score the difficulty of.
    advance_properties = MCP_V1_CONTRACT_SCHEMAS["sprintengine.task.advance"]["properties"]
    assert not [name for name in advance_properties if name.startswith("reviewedDifficulty")]
    for tool_name in ("sprintengine.plan.add_task", "sprintengine.plan.update_task"):
        properties = MCP_V1_CONTRACT_SCHEMAS[tool_name]["properties"]
        assert "difficulty_pct" not in properties
        assert properties["difficultyPct"]["maximum"] == 100
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


def test_mcp_run_tools_return_role_agnostic_dispatch_context(tmp_path) -> None:
    # MC-1591 deleted the dispatch.next/ack delivery tools. The run-level tools
    # stay role-agnostic; the claim response still carries the denormalized
    # currentDispatch mirror (removed in T4 when the roster is lease-derived).
    fixture = create_team(tmp_path, "mcp-run-dispatch", [task("T1", "Dispatch", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    claimed = server.call_tool(
        "sprintengine.task.next",
        {"statePath": str(fixture.state_path), "role": "developer", "id": "developer-a"},
        actor("workspace-user", "user"),
    )
    run = server.call_tool("sprintengine.run.get", {"statePath": str(fixture.state_path)}, actor("workspace-user", "user"))
    policy = server.call_tool("sprintengine.run.policy.get", {"statePath": str(fixture.state_path)}, actor("workspace-user", "user"))
    # The run projection is deliberately not reachable over MCP: it exists
    # for the UI, which reads projection.json from disk.
    projection = server.call_tool("sprintengine.run.projection", {"statePath": str(fixture.state_path)}, actor("workspace-user", "user"))
    events = server.call_tool("sprintengine.run.subscribe", {"statePath": str(fixture.state_path)}, actor("workspace-user", "user"))

    assert claimed["result"]["currentDispatch"]["taskId"] == "T1"
    assert claimed["result"]["state"] == "dispatched"
    assert run["result"]["run"]["name"] == "mcp-run-dispatch"
    assert "cliWatchPolling" in policy["result"]["runner"]
    assert projection["ok"] is False
    assert projection["error"]["code"] == "unknown_tool"
    assert events["result"]["latestEventId"] == events["result"]["latestEvent"]["id"]
    assert events["result"]["state"] == "events_available"
    assert [row["operation_name"] for row in audit_rows(fixture.team_dir)] == [
        "sprintengine.task.next",
    ]


def reviewing_task() -> dict:
    """A published task in its review phase, still owned by its implementer."""
    record = task("T1", "Reviewable", "developer", "review", owner="developer-a")
    record["startedAt"] = "2026-07-08T00:00:00Z"
    return record


def test_mcp_task_advance_uses_core_lifecycle_and_audit(tmp_path) -> None:
    fixture = create_team(tmp_path, "mcp-advance-lifecycle", [reviewing_task()])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    advanced = server.call_tool(
        "sprintengine.task.advance",
        {
            "statePath": str(fixture.state_path),
            "taskId": "T1",
            "id": "developer-a",
            "phase": "review",
            "outcome": "pass",
            "summary": "Implementation matches the task card.",
        },
        actor("workspace-user", "user"),
    )

    assert advanced["ok"] is True
    assert advanced["result"]["phase"] == "review"
    assert advanced["result"]["outcome"] == "pass"
    assert advanced["result"]["nextStatus"] == "done"
    # Terminal phase: no next phase, so no directive to hand back.
    assert "nextPhase" not in advanced["result"]
    assert "nextDirective" not in advanced["result"]
    assert [row["operation_name"] for row in audit_rows(fixture.team_dir)] == ["sprintengine.task.advance"]

    persisted = get_task(read_state(fixture.state_path), "T1")
    assert persisted["status"] == "done"
    assert persisted["ownerAgentId"] is None


def test_mcp_task_advance_forwards_feedback_count_fields_to_metrics(tmp_path) -> None:
    def run_advance(team_name: str, payload_counts: dict[str, int]) -> tuple[dict, dict]:
        fixture = create_team(tmp_path, team_name, [reviewing_task()])
        server = SprintEngineMcpServer(allowed_roots=[tmp_path])
        advanced = server.call_tool(
            "sprintengine.task.advance",
            {
                "statePath": str(fixture.state_path),
                "taskId": "T1",
                "id": "developer-a",
                "phase": "review",
                "outcome": "pass",
                "summary": "Implementation matches the task card.",
                **payload_counts,
            },
            actor("workspace-user", "user"),
        )

        assert advanced["ok"] is True
        assert advanced["result"]["feedbackRecorded"] is True
        record = feedback_rows(fixture.team_dir)[0]
        # A phase advance is the OWNER reporting on its own work, so the feedback
        # lands as a self-report, not as a reviewer assessment of someone else.
        assert record["source"] == "phase_advance_self_review"
        assert record["phase"] == "review"
        assert record["phase_outcome"] == "pass"
        reviewed = get_task(read_state(fixture.state_path), "T1")
        assert "feedbackAssessments" not in reviewed
        return record, reviewed["feedback"]

    camel_record, camel_feedback = run_advance(
        "mcp-advance-camel-counts",
        {camel: index + 1 for index, (_, camel, _) in enumerate(FEEDBACK_COUNT_FIELDS)},
    )
    snake_record, snake_feedback = run_advance(
        "mcp-advance-snake-counts",
        {attr: index + 11 for index, (attr, _, _) in enumerate(FEEDBACK_COUNT_FIELDS)},
    )

    for index, (_, state_key, json_key) in enumerate(FEEDBACK_COUNT_FIELDS):
        assert camel_record["counts"][json_key] == index + 1
        assert camel_feedback["counts"][state_key] == index + 1
        assert snake_record["counts"][json_key] == index + 11
        assert snake_feedback["counts"][state_key] == index + 11


def test_mcp_task_advance_records_the_phase_on_the_state_feedback(tmp_path) -> None:
    fixture = create_team(tmp_path, "mcp-advance-phase-context", [reviewing_task()])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    advanced = server.call_tool(
        "sprintengine.task.advance",
        {
            "statePath": str(fixture.state_path),
            "taskId": "T1",
            "id": "developer-a",
            "phase": "review",
            "outcome": "pass_with_fixes",
            "summary": "Fixed a null guard I missed.",
            "claimsChecked": 6,
        },
        actor("workspace-user", "user"),
    )

    assert advanced["ok"] is True
    feedback = get_task(read_state(fixture.state_path), "T1")["feedback"]
    assert feedback["source"] == "phase_advance_self_review"
    assert feedback["phase"] == {"phase": "review", "outcome": "pass_with_fixes"}
    assert feedback["counts"]["claimsChecked"] == 6


def test_mcp_task_get_comment_publish_and_advance_cover_agent_paths(tmp_path) -> None:
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

    assert comment["ok"] is True
    assert comments["result"]["comments"][0]["body"] == "Implementation note."
    assert fetched["result"]["task"]["id"] == "T1"
    assert published["ok"] is True
    # The task produced a diff, so publish routes it into review and the owner
    # keeps it — the phase directive rides back inline.
    assert published["result"]["nextStatus"] == "review"
    assert published["result"]["nextDirective"]
    # Mutation tools return acks, not task echoes.
    assert "task" not in published["result"]
    assert published["result"]["taskId"] == "T1"
    mid_walk = get_task(read_state(fixture.state_path), "T1")
    assert mid_walk["status"] == "review"
    assert mid_walk["ownerAgentId"] == "developer-a"

    advanced = server.call_tool(
        "sprintengine.task.advance",
        {
            "statePath": str(fixture.state_path),
            "taskId": "T1",
            "id": "developer-a",
            "phase": "review",
            "outcome": "pass_with_fixes",
            "summary": "Found and fixed a missing MCP path.",
        },
        actor("workspace-user", "user"),
    )

    assert advanced["ok"] is True
    assert "task" not in advanced["result"]
    assert advanced["result"]["taskId"] == "T1"
    assert advanced["result"]["nextStatus"] == "done"
    assert advanced["result"]["comment"]["type"] == "implementation_summary"
    persisted = get_task(read_state(fixture.state_path), "T1")
    assert persisted["status"] == "done"
    assert "needsInput" not in persisted
    assert persisted["ownerAgentId"] is None


def test_mcp_task_advance_is_owner_only(tmp_path) -> None:
    """The single-owner replacement for the reviewer-only gate.verdict guard."""
    fixture = create_team(tmp_path, "mcp-advance-owner-only", [reviewing_task()])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    response = server.call_tool(
        "sprintengine.task.advance",
        {
            "statePath": str(fixture.state_path),
            "taskId": "T1",
            "id": "reviewer-a",
            "phase": "review",
            "outcome": "pass",
            "summary": "Looks fine to me.",
        },
        actor("workspace-user", "user"),
    )

    assert response["ok"] is False
    assert "not_task_owner" in response["error"]["message"]
    task_record = get_task(read_state(fixture.state_path), "T1")
    assert task_record["status"] == "review"
    assert task_record["ownerAgentId"] == "developer-a"


def test_mcp_task_advance_escalate_requires_a_question(tmp_path) -> None:
    fixture = create_team(tmp_path, "mcp-advance-escalate-guard", [reviewing_task()])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    response = server.call_tool(
        "sprintengine.task.advance",
        {
            "statePath": str(fixture.state_path),
            "taskId": "T1",
            "id": "developer-a",
            "phase": "review",
            "outcome": "escalate",
            "summary": "The plan contradicts the contract.",
        },
        actor("workspace-user", "user"),
    )

    assert response["ok"] is False
    assert "needs-input question" in response["error"]["message"]
    task_record = get_task(read_state(fixture.state_path), "T1")
    assert task_record["status"] == "review"
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
        },
        actor("workspace-user", "user"),
    )

    assert response["ok"] is True
    result = response["result"]
    assert result["role"] == "developer"
    # MC-1591: no agents map. The join echoes the joining worker's lease-derived
    # view — developer-a claimed T1 above, so it resolves back to that active
    # lease — and currentDispatch is rebuilt from the dispatch ledger.
    assert result["agent"]["currentTaskId"] == "T1"
    assert result["agent"]["status"] == "running"
    assert result["currentDispatch"]["taskId"] == "T1"
    assert result["run"]["name"] == "mcp-agent-join-context"
    assert result["roleManifest"]["id"] == "developer"
    assert result["promptContext"]["format"] == "composed_soul_coordination_prompt"
    assert "# SprintEngine Coordination Rules" in result["prompt"]
    # The MCP-coordination rule lives in the shared sprintengine_workflow skill;
    # role prompts no longer restate it.
    assert "Coordinate through Sprint Engine MCP tools; never edit run-store files directly" in result["prompt"]
    assert "# Sprint Engine Workflow" in result["prompt"]
    assert "# Sprint Engine Publish Feedback" in result["prompt"]
    assert "# Sprint Engine Architect Workflow" not in result["prompt"]
    assert "legacyJoin" not in result, "agent.join must not return CLI-laden legacyJoin payload"
    assert [row["operation_name"] for row in audit_rows(fixture.team_dir)] == [
        "sprintengine.task.next",
        "sprintengine.agent.join",
    ]


def test_mcp_run_metadata_carries_configured_roles(tmp_path) -> None:
    # Join and run.get responses expose the run's enabled role set so headless
    # agents can self-check without the renderer-composed prompt. Configured
    # runs carry the list; legacy runs omit the field.
    configured = create_team(tmp_path, "mcp-configured-roles", [task("T1", "Build", "developer")])
    state = read_state(configured.state_path)
    state["configuredRoles"] = ["architect", "developer", "security", "tester"]
    write_state(configured.state_path, state)
    server = SprintEngineMcpServer(allowed_roots=[tmp_path, REPO_ROOT])

    joined = server.call_tool(
        "sprintengine.agent.join",
        {
            "statePath": str(configured.state_path),
            "workspaceRoot": str(REPO_ROOT),
            "role": "developer",
            "agentId": "developer-a",
        },
        actor("workspace-user", "user"),
    )
    run = server.call_tool(
        "sprintengine.run.get",
        {"statePath": str(configured.state_path)},
        actor("workspace-user", "user"),
    )

    assert joined["result"]["run"]["configuredRoles"] == [
        "architect",
        "developer",
        "security",
        "tester",
    ]
    assert run["result"]["run"]["configuredRoles"] == [
        "architect",
        "developer",
        "security",
        "tester",
    ]

    legacy = create_team(tmp_path, "mcp-legacy-roles", [task("T1", "Build", "developer")])
    assert "configuredRoles" not in read_state(legacy.state_path)
    legacy_join = server.call_tool(
        "sprintengine.agent.join",
        {
            "statePath": str(legacy.state_path),
            "workspaceRoot": str(REPO_ROOT),
            "role": "developer",
            "agentId": "developer-b",
        },
        actor("workspace-user", "user"),
    )
    legacy_run = server.call_tool(
        "sprintengine.run.get",
        {"statePath": str(legacy.state_path)},
        actor("workspace-user", "user"),
    )
    assert "configuredRoles" not in legacy_join["result"]["run"]
    assert "configuredRoles" not in legacy_run["result"]["run"]


def test_mcp_agent_join_injects_role_specific_runtime_skills_without_gate_context(tmp_path) -> None:
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
            "role": "security",
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
    assert "# Sprint Engine Gate Feedback" not in reviewer["result"]["prompt"]
    assert "# Sprint Engine Architect Workflow" not in reviewer["result"]["prompt"]


def test_join_routes_a_ready_task_then_resumes_the_same_agent(tmp_path) -> None:
    fixture = create_team(tmp_path, "join-route-task", [task("T1", "Implement MCP", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    ready = fixture.cli.run("join", "--role", "developer", "--id", "developer-a")
    claim = server.call_tool(
        "sprintengine.task.next",
        {"statePath": str(fixture.state_path), "role": "developer", "id": "developer-a"},
        actor("workspace-user", "user"),
    )
    active = fixture.cli.run("join", "--role", "developer", "--id", "developer-a")

    assert ready["action"] == "work"
    assert ready["readyTaskCount"] == 1
    assert claim["ok"] is True
    assert active["action"] == "resume"
    assert active["task"]["id"] == "T1"


def test_join_resumes_the_owner_of_a_task_in_review(tmp_path) -> None:
    """MC-1542 Flow 6: a task in `review` stays owned, so its owner rejoining is a
    plain resume — there is no separate reviewer to route a gate directive to."""
    fixture = create_team(tmp_path, "join-route-review", [reviewing_task()])

    joined = fixture.cli.run("join", "--role", "developer", "--id", "developer-a")

    assert joined["action"] == "resume"
    assert joined["task"]["id"] == "T1"
    assert joined["task"]["status"] == "review"
    assert "gate" not in joined


def test_join_routes_needs_input_triage_blocked_idle_complete_and_unknown_role(tmp_path) -> None:
    needs_input_task = task("T1", "Needs architect triage", "developer", "needs_input", owner="developer-a")
    needs_input_task["needsInput"] = {
        "kind": "architect",
        "reason": "task_scope",
        "question": "Clarify the scope.",
    }
    needs_fixture = create_team(tmp_path, "join-route-needs-input", [needs_input_task])
    idle_fixture = create_team(tmp_path, "join-route-idle", [task("T1", "Tester work", "tester")])
    complete_fixture = create_team(tmp_path, "join-route-complete", [task("T1", "Done work", "developer", "done")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    needs = needs_fixture.cli.run("join", "--role", "architect", "--id", "architect-a")
    blocked_owner = needs_fixture.cli.run("join", "--role", "developer", "--id", "developer-a")
    triage = server.call_tool(
        "sprintengine.triage.needs_input",
        {"statePath": str(needs_fixture.state_path), "id": "architect-a"},
        actor("workspace-user", "user"),
    )
    idle = idle_fixture.cli.run("join", "--role", "developer", "--id", "developer-a")
    complete = complete_fixture.cli.run("join", "--role", "developer", "--id", "developer-a")
    unknown_role = idle_fixture.cli.run_failure("join", "--role", "not_a_role", "--id", "developer-a")

    assert needs["action"] == "needs_input_triage"
    assert blocked_owner["action"] == "blocked"
    assert blocked_owner["blocker"]["reason"] == "needs_input"
    assert blocked_owner["task"]["id"] == "T1"
    assert triage["ok"] is True
    assert triage["result"]["tasks"][0]["id"] == "T1"
    assert idle["action"] == "idle"
    assert complete["action"] == "complete"
    assert "not_a_role" in unknown_role.stderr


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


def test_mcp_epic_reference_handover_and_init_over_mcp_route(tmp_path) -> None:
    # Exercise the MCP payload adapter (which bypasses argparse `choices`) for a
    # reference-based epic launch: the epic and its children must be recorded as
    # references (no copies), and init must mint the review-in-place plan task.
    workspace = tmp_path / "workspace"
    (workspace / "backlog" / "epics").mkdir(parents=True, exist_ok=True)
    # Marked as ordering-planned (MC-2137) so this stays a DIRECT-intake fixture:
    # an unmarked epic now plans first, which is a different route than the one
    # this test exists to walk.
    (workspace / "backlog" / "epics" / "auth-revamp.md").write_text(
        "---\ntype: epic\ndependenciesPlanned: true\n---\n\n# Auth revamp\n", encoding="utf-8"
    )
    (workspace / "backlog" / "login-form.md").write_text("---\nepic: auth-revamp\n---\n# Login\n", encoding="utf-8")
    (workspace / "backlog" / "session-store.md").write_text("---\nepic: auth-revamp\n---\n# Session\n", encoding="utf-8")
    state_path = workspace / ".multi-code" / "sprintengine" / "auth-revamp" / "run.yaml"
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    handover = server.call_tool(
        "sprintengine.handover",
        {
            "statePath": str(state_path),
            "workspaceRoot": str(workspace),
            "name": "auth-revamp",
            "goal": "Revamp authentication",
            "handoverPath": "backlog/epics/auth-revamp.md",
            "sourcePlanKind": "epic",
            "reference": True,
            "sourceBundle": [
                {"kind": "generic_context", "sourcePath": "backlog/login-form.md"},
                {"kind": "generic_context", "sourcePath": "backlog/session-store.md"},
            ],
            "actor": "workspace-user",
        },
        actor("workspace-user", "user"),
    )
    assert handover["ok"] is True
    team_dir = state_path.parent
    assert not (team_dir / "handover.md").exists()
    assert not (team_dir / "sources").exists()

    state = read_state(state_path)
    assert state["source"]["origin"] == "reference"
    assert state["source"]["planKind"] == "epic"
    # In-process server inherits pytest's cwd, so the repo-root derivation stores an
    # absolute path here; production resolves it relative. Assert on the suffix.
    assert state["source"]["path"].endswith("backlog/epics/auth-revamp.md")
    assert [item["path"].rsplit("/backlog/", 1)[-1] for item in state["sourceBundle"]] == ["login-form.md", "session-store.md"]
    assert all(item["origin"] == "reference" for item in state["sourceBundle"])

    initialized = server.call_tool(
        "sprintengine.init",
        {"statePath": str(state_path)},
        actor("workspace-user", "user"),
    )
    assert initialized["ok"] is True
    # An epic source takes the direct intake by default (MC-2128): no plan gate and
    # no planning session. Nothing is imported HERE because this fixture's children
    # sit outside the derived repo root (see the absolute-path note above), which is
    # the guard doing its job — a child with no project-relative path gets a named
    # warning instead of an unreferencable task or a failed init.
    assert initialized["result"]["intake"] == "direct"
    assert initialized["result"]["planTask"] is None
    assert initialized["result"].get("productTask") is None
    assert initialized["result"]["importedTasks"] == []
    assert len(initialized["result"]["warnings"]) == 2
    assert all("resolves outside this project" in warning for warning in initialized["result"]["warnings"])
    assert not (team_dir / "plan.md").exists()

    # The opt-in planner is still one param away, over the same MCP route.
    planned_state_path = workspace / ".multi-code" / "sprintengine" / "auth-revamp-planned" / "run.yaml"
    server.call_tool(
        "sprintengine.handover",
        {
            "statePath": str(planned_state_path),
            "workspaceRoot": str(workspace),
            "name": "auth-revamp-planned",
            "goal": "Revamp authentication",
            "handoverPath": "backlog/epics/auth-revamp.md",
            "sourcePlanKind": "epic",
            "reference": True,
            "sourceBundle": [{"kind": "generic_context", "sourcePath": "backlog/login-form.md"}],
            "actor": "workspace-user",
        },
        actor("workspace-user", "user"),
    )
    planned = server.call_tool(
        "sprintengine.init",
        {"statePath": str(planned_state_path), "intake": "planned"},
        actor("workspace-user", "user"),
    )
    assert planned["ok"] is True
    assert planned["result"]["planTask"]["title"] == "Sequence the epic's child items into a task graph"


def test_mcp_agent_join_resolves_workspace_only_custom_role(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    write_registry_role(workspace, "writer", label="Writer", implement=[{"skill": "drafting"}])
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
    # No agents map (MC-1591): a join records nothing, so the store carries no
    # `agents` key and writer-1 (which claimed nothing) has no worker view.
    assert "agents" not in read_state(fixture.state_path)
    assert joined["result"]["agent"] is None


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
    before_task = get_task(read_state(fixture.state_path), "T1")
    before_heartbeat = before_task["lease"]["heartbeatAt"]

    response = server.call_tool(
        "sprintengine.agent.heartbeat",
        {"statePath": str(fixture.state_path), "agentId": "developer-a", "role": "developer"},
        actor("workspace-user", "user"),
    )

    assert response["ok"] is True
    # Heartbeat is pure liveness: a two-field ack, no roster-record echo and no
    # assignment payload. With no agents map (MC-1591) it renews the lease
    # heartbeat of the worker's owned task; assignment travels via task.next.
    assert response["result"] == {"ok": True, "known": True}
    after_task = get_task(read_state(fixture.state_path), "T1")
    assert after_task["ownerAgentId"] == "developer-a"
    assert after_task["status"] == "in_progress"
    assert after_task["lease"]["workerId"] == "developer-a"
    assert after_task["lease"]["heartbeatAt"] >= before_heartbeat


def test_mcp_agent_heartbeat_unknown_agent_does_not_create_roster_entry(tmp_path) -> None:
    fixture = create_team(tmp_path, "mcp-agent-heartbeat-unknown", [])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    response = server.call_tool(
        "sprintengine.agent.heartbeat",
        {"statePath": str(fixture.state_path), "agentId": "developer-a", "role": "developer"},
        actor("workspace-user", "user"),
    )

    assert response["ok"] is True
    assert response["result"] == {"ok": True, "known": False}
    assert "developer-a" not in read_state(fixture.state_path).get("agents", {})


def test_mcp_agent_leave_preserves_needs_input_ownership(tmp_path) -> None:
    """Leaving must not release tasks blocked on a human: the needs_input
    question and owner survive so input resolution can route the answer back
    to the owner (mirrors the expiry sweep's exclusion)."""
    record = task("T1", "Blocked on user", "developer", status="needs_input", owner="developer-a")
    record["needsInput"] = {"kind": "user", "reason": "product_decision", "question": "Which auth provider?"}
    fixture = create_team(tmp_path, "mcp-agent-leave-needs-input", [record])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    response = server.call_tool(
        "sprintengine.agent.leave",
        {"statePath": str(fixture.state_path), "agentId": "developer-a", "role": "developer", "reason": "terminal disposed"},
        actor("workspace-user", "user"),
    )

    assert response["ok"] is True
    # The needs_input lease stays bound to its owner, so the worker view still
    # resolves to T1 (a lease-derived view, no agents map).
    assert response["result"]["releasedTargets"] == []
    assert response["result"]["agent"]["currentTaskId"] == "T1"
    assert response["result"]["agent"]["status"] == "needs_input"
    persisted = get_task(read_state(fixture.state_path), "T1")
    assert persisted["status"] == "needs_input"
    assert persisted["needsInput"]["question"] == "Which auth provider?"
    assert persisted["ownerAgentId"] == "developer-a"


def test_mcp_agent_leave_unknown_agent_does_not_create_roster_entry(tmp_path) -> None:
    fixture = create_team(tmp_path, "mcp-agent-leave-unknown", [])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    response = server.call_tool(
        "sprintengine.agent.leave",
        {"statePath": str(fixture.state_path), "agentId": "developer-a", "role": "developer", "reason": "terminal disposed"},
        actor("workspace-user", "user"),
    )

    assert response["ok"] is True
    assert response["result"]["known"] is False
    assert response["result"]["agent"] is None
    assert response["result"]["releasedTargets"] == []
    assert "developer-a" not in read_state(fixture.state_path).get("agents", {})


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
        {"statePath": str(fixture.state_path), "agentId": "developer-a", "role": "developer", "reason": "terminal closed"},
        actor("workspace-user", "user"),
    )

    assert response["ok"] is True
    # The in_progress lease is released, so the departing worker holds no lease
    # and has no worker view.
    assert response["result"]["agent"] is None
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


def test_mcp_agent_leave_releases_owned_active_task_when_agent_ref_is_stale(tmp_path) -> None:
    fixture = create_team(tmp_path, "mcp-agent-leave-release-stale-ref", [task("T1", "Leave task", "developer", "in_progress", owner="developer-a")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    response = server.call_tool(
        "sprintengine.agent.leave",
        {"statePath": str(fixture.state_path), "agentId": "developer-a", "role": "developer", "reason": "terminal closed"},
        actor("workspace-user", "user"),
    )

    assert response["ok"] is True
    assert response["result"]["releasedTargets"] == [
        {"kind": "task", "taskId": "T1", "previousOwnerAgentId": "developer-a", "status": "todo"}
    ]
    task_record = get_task(read_state(fixture.state_path), "T1")
    assert task_record["status"] == "todo"
    assert task_record["ownerAgentId"] is None


def test_mcp_agent_leave_keeps_a_review_task_bound_to_its_owner(tmp_path) -> None:
    """MC-1542 Flow 6: releasing a `review` task to `todo` would hand a stranger a
    task whose diff is already published. The owner is revived under the same id."""
    fixture = create_team(tmp_path, "mcp-agent-leave-review", [reviewing_task()])
    state = read_state(fixture.state_path)
    state["agents"] = {"developer-a": {"role": "developer", "status": "running", "currentTaskId": "T1"}}
    write_state(fixture.state_path, state)
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    response = server.call_tool(
        "sprintengine.agent.leave",
        {"statePath": str(fixture.state_path), "agentId": "developer-a", "reason": "terminal closed"},
        actor("workspace-user", "user"),
    )

    assert response["ok"] is True
    assert response["result"]["releasedTargets"] == []
    task_record = get_task(read_state(fixture.state_path), "T1")
    assert task_record["status"] == "review"
    assert task_record["ownerAgentId"] == "developer-a"


def test_mcp_registry_discovery_returns_roles_skills_brief_and_warnings(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    write_registry_role(workspace, "marketer", label="Growth Marketer", implement=[{"skill": "strategy"}, {"skill": "missing"}])
    write_registry_skill(workspace, "strategy", "---\nname: strategy\n---\n\nPlan for {{role}} in {{run_id}}.")
    write_registry_role(workspace, "writer", label="Writer", implement=[{"skill": "drafting"}])
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
    assert soul["result"]["soul"]["content"].startswith("<soul-legend>")
    assert '<skill name="drafting">\nDraft for writer in run-123.\n</skill>' in soul["result"]["soul"]["content"]
    assert str(tmp_path) not in json.dumps(roles["result"], sort_keys=True)


def test_mcp_registry_discovery_accepts_plugin_registry_roots(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    plugin_root = tmp_path / "plugin" / "souls"
    write_registry_role(plugin_root, "plugin_writer", label="Plugin Writer", implement=[{"skill": "plugin_writer"}])
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
    task_id = response["result"]["taskId"]
    task_record = get_task(read_state(fixture.state_path), task_id)
    assert task_record["needsTriage"] is True
    assert task_record["difficulty"]["architectEstimatePct"] == 42

    update = server.call_tool(
        "sprintengine.plan.update_task",
        {
            "statePath": str(fixture.state_path),
            "taskId": task_id,
            "clearNeedsTriage": True,
            "difficultyPct": 55,
            "difficultyReason": "Scope expanded during planning.",
        },
        actor("workspace-user", "user"),
    )

    assert update["ok"] is True
    assert update["result"]["taskId"] == task_id
    updated_record = get_task(read_state(fixture.state_path), task_id)
    assert updated_record["needsTriage"] is False
    assert updated_record["difficulty"]["architectEstimatePct"] == 55


def test_mcp_plan_add_task_forwards_phases(tmp_path) -> None:
    fixture = create_team(tmp_path, "mcp-plan-phases", [])
    state = read_state(fixture.state_path)
    state["sprintengine"]["rosterConfigured"] = True
    state["agents"] = {"architect": {"role": "architect", "status": "idle", "currentTaskId": None}}
    write_state(fixture.state_path, state)
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    trimmed = server.call_tool(
        "sprintengine.plan.add_task",
        {
            "statePath": str(fixture.state_path),
            "title": "Docs only",
            "role": "architect",
            "path": ["docs/sprintengine-cli.md"],
            "producesImplementation": True,
            # `[]` is an explicit "no review phase", not an absent key.
            "phases": [],
        },
        actor("workspace-user", "user"),
    )

    assert trimmed["ok"] is True
    trimmed_record = get_task(read_state(fixture.state_path), trimmed["result"]["taskId"])
    assert trimmed_record["producesImplementation"] is True
    assert trimmed_record["phases"] == []
    assert "qualityGates" not in trimmed_record

    inherited = server.call_tool(
        "sprintengine.plan.add_task",
        {"statePath": str(fixture.state_path), "title": "Real work", "role": "architect"},
        actor("workspace-user", "user"),
    )

    assert inherited["ok"] is True
    # An absent `phases` inherits the run default rather than pinning a copy.
    inherited_record = get_task(read_state(fixture.state_path), inherited["result"]["taskId"])
    assert "phases" not in inherited_record


def test_mcp_plan_add_task_rejects_a_phase_outside_the_run_ceiling(tmp_path) -> None:
    fixture = create_team(tmp_path, "mcp-plan-phase-ceiling", [])
    state = read_state(fixture.state_path)
    state["sprintengine"]["rosterConfigured"] = True
    state["agents"] = {"architect": {"role": "architect", "status": "idle", "currentTaskId": None}}
    state["defaultPhases"] = []
    write_state(fixture.state_path, state)
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    response = server.call_tool(
        "sprintengine.plan.add_task",
        {"statePath": str(fixture.state_path), "title": "Sneaky review", "role": "architect", "phases": ["review"]},
        actor("workspace-user", "user"),
    )

    assert response["ok"] is False
    assert "phase_not_configured_for_run" in response["error"]["message"]


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
    assert "task" not in response["result"]
    updated = get_task(read_state(fixture.state_path), "T1")
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

    response = server.call_tool("sprintengine.health", {"statePath": str(fixture.state_path)}, actor("workspace-user", "user"))

    assert response["ok"] is True
    report = response["result"]
    assert report["backendMode"] == "mcp-local"
    assert report["schemaVersion"] == 1
    assert report["allowedRoot"]["allowed"] is True
    assert report["capabilities"] == {"read": True, "write": True}


def test_stdio_transport_exercises_initialize_read_and_mutating_tool(tmp_path) -> None:
    fixture = create_team(tmp_path, "mcp-stdio-smoke", [task("T1", "Smoke task", "developer")])
    actor_context = actor("workspace-user", "user")
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


def test_stdio_transport_negotiates_the_protocol_version_instead_of_echoing_it(tmp_path) -> None:
    # The engine used to answer initialize with whatever protocolVersion the client
    # asked for, which told a spec-tracking client (one asking for 2026-07-28 today)
    # that we speak a spec we do not implement.
    # Supported → itself; unsupported, malformed, or absent → our default.
    # The probe is a far-future date deliberately: a real upcoming spec version would
    # have to be re-pointed here the moment we start serving it, and the subject of
    # this test is the downgrade rule, not any one version.
    unsupported = "2099-01-01"
    assert unsupported not in SUPPORTED_PROTOCOL_VERSIONS, "this test needs a version we do NOT serve"
    messages = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26"}},
        {"jsonrpc": "2.0", "id": 2, "method": "initialize", "params": {"protocolVersion": unsupported}},
        {"jsonrpc": "2.0", "id": 3, "method": "initialize", "params": {}},
        {"jsonrpc": "2.0", "id": 4, "method": "initialize", "params": {"protocolVersion": 20260728}},
        # The head of the set, asked for by name: the version the HTTP transport
        # earned by serving session-less requests must be answerable as itself,
        # not merely reachable as the default.
        {"jsonrpc": "2.0", "id": 5, "method": "initialize", "params": {"protocolVersion": "2026-07-28"}},
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
    answered = {response["id"]: response["result"]["protocolVersion"] for response in responses}
    assert answered == {
        1: "2025-03-26",
        2: DEFAULT_PROTOCOL_VERSION,
        3: DEFAULT_PROTOCOL_VERSION,
        4: DEFAULT_PROTOCOL_VERSION,
        5: "2026-07-28",
    }
    assert unsupported not in completed.stdout, "the requested version must never come back to the caller"
    # The TypeScript gateway pins the same literal (automation.test.ts); that pair is
    # what keeps the two servers' declared maximum from drifting apart again. It rose
    # to 2026-07-28 when the HTTP transport started serving session-less requests —
    # the version is claimed by the commit that implements it, never before.
    assert DEFAULT_PROTOCOL_VERSION == "2026-07-28", "both servers must answer the same default/maximum"


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
    plan_description = initialized["result"]["planTask"]["description"]
    assert "Incoming source context for this run:" in plan_description
    assert "product/.versions/brief.md" in plan_description
    assert "product/.versions/plan.md" in plan_description
    assert "product/.versions/ui.md" in plan_description
    assert "mockups/.versions/app.html" in plan_description
    assert str(workspace) not in plan_description


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
    assert task_result["result"]["task"]["id"] == "T1"
    assert get_task(read_state(fixture.state_path), "T1")["ownerAgentId"] == "developer-b"


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


def test_http_transport_serves_a_session_less_tool_call_at_the_stateless_version(tmp_path) -> None:
    # The whole point of 2026-07-28 (SEP-2575/SEP-2567): no initialize, no session,
    # one round trip. Everything a session held — actor and McpRequestContext — was
    # already copied from the registered run, so the bearer token resolves it.
    fixture = create_team(tmp_path, "mcp-http-stateless", [task("T1", "HTTP task", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    with run_http_mcp_server(server, token="secret-token") as base_url:
        run = register_http_run(
            base_url,
            token="secret-token",
            run_id="launch-stateless",
            workspace_root=tmp_path,
            state_path=fixture.state_path,
            allowed_roots=[tmp_path],
        )
        # No initialize call precedes this: no session exists on this run to send.
        status, headers, body = http_post(
            base_url,
            token=run["runToken"],
            payload={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "sprintengine.task.list",
                    "arguments": {"role": "developer"},
                    "_meta": {"clientInfo": {"name": "pytest", "version": "0"}, "capabilities": {}},
                },
            },
            extra_headers={
                PROTOCOL_VERSION_HEADER: STATELESS_PROTOCOL_VERSION,
                METHOD_HEADER: "tools/call",
                NAME_HEADER: "sprintengine.task.list",
                # Stated, not merely omitted: the request must carry no session id.
                SESSION_HEADER: None,
            },
        )

    wrapper = body["result"]
    result = json.loads(wrapper["content"][0]["text"])
    # Proof the session-less path ran, not a session one: this run never called
    # initialize, so it owns no session — and any session id this request had
    # carried would have been rejected as invalid_session (pinned by
    # test_http_transport_rejects_an_unknown_or_foreign_session_instead_of_falling_back)
    # rather than answered 200.
    assert status == 200
    assert wrapper["isError"] is False
    assert result["ok"] is True
    # The real tool ran against the registered run's state, not a stub.
    assert [entry["id"] for entry in result["result"]["readyTasks"]] == ["T1"]
    assert SESSION_HEADER not in headers, "a session-less request must not be answered with a session"


def test_http_tools_list_declares_a_cache_ttl(tmp_path) -> None:
    # SEP-2549. The listing is byte-budgeted precisely because it rides into every
    # agent context; telling the client how long it may keep it is the cheap half.
    fixture = create_team(tmp_path, "mcp-http-ttl", [task("T1", "HTTP task", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    with run_http_mcp_server(server, token="secret-token") as base_url:
        run = register_http_run(
            base_url,
            token="secret-token",
            run_id="launch-ttl",
            workspace_root=tmp_path,
            state_path=fixture.state_path,
            allowed_roots=[tmp_path],
        )
        status, _, body = http_post(
            base_url,
            token=run["runToken"],
            payload={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
            extra_headers={PROTOCOL_VERSION_HEADER: STATELESS_PROTOCOL_VERSION, METHOD_HEADER: "tools/list"},
        )

    assert status == 200
    assert body["result"]["ttlMs"] == 3_600_000
    assert any(tool["name"] == "sprintengine.task.list" for tool in body["result"]["tools"])


def test_http_transport_rejects_an_unknown_or_foreign_session_instead_of_falling_back(tmp_path) -> None:
    # Sessions became OPTIONAL, not ignored: a client that sends one is asserting the
    # session exists. Serving it at run scope would hide a real client bug.
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
        unknown_status, _, unknown_body = http_post(
            base_url,
            token=first_run["runToken"],
            session_id="not-a-live-session",
            payload={"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            expect_error=True,
        )
        foreign_status, _, foreign_body = http_post(
            base_url,
            token=second_run["runToken"],
            session_id=first_headers[SESSION_HEADER],
            payload={"jsonrpc": "2.0", "id": 3, "method": "tools/list"},
            expect_error=True,
        )

    assert unknown_status == 400
    assert unknown_body["error"]["code"] == "invalid_session"
    assert foreign_status == 400
    assert foreign_body["error"]["code"] == "invalid_session"


def test_http_transport_rejects_a_protocol_version_it_does_not_serve(tmp_path) -> None:
    # Over HTTP the client has already committed to the version it declares, so the
    # initialize-time downgrade is not available: the honest answer is a refusal.
    fixture = create_team(tmp_path, "mcp-http-version", [task("T1", "HTTP task", "developer")])
    unsupported = "2099-01-01"
    assert unsupported not in SUPPORTED_PROTOCOL_VERSIONS, "this test needs a version we do NOT serve"
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    with run_http_mcp_server(server, token="secret-token") as base_url:
        run = register_http_run(
            base_url,
            token="secret-token",
            run_id="launch-version",
            workspace_root=tmp_path,
            state_path=fixture.state_path,
            allowed_roots=[tmp_path],
        )
        header_status, _, header_body = http_post(
            base_url,
            token=run["runToken"],
            payload={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
            extra_headers={PROTOCOL_VERSION_HEADER: unsupported},
            expect_error=True,
        )
        meta_status, _, meta_body = http_post(
            base_url,
            token=run["runToken"],
            payload={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {"_meta": {"protocolVersion": unsupported}}},
            expect_error=True,
        )
        # Declaring nothing is not the same as declaring something we do not serve:
        # the spec reads a version-less HTTP request as the legacy assumption.
        legacy_status, _, legacy_body = http_post(
            base_url,
            token=run["runToken"],
            payload={"jsonrpc": "2.0", "id": 3, "method": "tools/list"},
        )

    assert header_status == 400
    assert header_body["error"] == "unsupported_protocol_version"
    assert meta_status == 400
    assert meta_body["error"] == "unsupported_protocol_version"
    assert legacy_status == 200
    assert legacy_body["result"]["tools"]


def test_http_transport_rejects_routing_headers_that_contradict_the_body(tmp_path) -> None:
    # SEP-2243's headers exist so an intermediary can route without parsing the body.
    # A header that disagrees with the body would make routing and execution diverge.
    fixture = create_team(tmp_path, "mcp-http-headers", [task("T1", "HTTP task", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])
    call = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": "sprintengine.task.list", "arguments": {"role": "developer"}},
    }

    with run_http_mcp_server(server, token="secret-token") as base_url:
        run = register_http_run(
            base_url,
            token="secret-token",
            run_id="launch-headers",
            workspace_root=tmp_path,
            state_path=fixture.state_path,
            allowed_roots=[tmp_path],
        )
        method_status, _, method_body = http_post(
            base_url,
            token=run["runToken"],
            payload=call,
            extra_headers={METHOD_HEADER: "tools/list", NAME_HEADER: "sprintengine.task.list"},
            expect_error=True,
        )
        name_status, _, name_body = http_post(
            base_url,
            token=run["runToken"],
            payload=call,
            extra_headers={METHOD_HEADER: "tools/call", NAME_HEADER: "sprintengine.task.claim"},
            expect_error=True,
        )

    assert method_status == 400
    assert method_body["error"] == "header_body_mismatch"
    assert name_status == 400
    assert name_body["error"] == "header_body_mismatch"


def test_http_transport_requires_routing_headers_only_at_the_stateless_version(tmp_path) -> None:
    fixture = create_team(tmp_path, "mcp-http-required-headers", [task("T1", "HTTP task", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])
    call = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": "sprintengine.task.list", "arguments": {"role": "developer"}},
    }
    stateless = {PROTOCOL_VERSION_HEADER: STATELESS_PROTOCOL_VERSION}

    with run_http_mcp_server(server, token="secret-token") as base_url:
        run = register_http_run(
            base_url,
            token="secret-token",
            run_id="launch-required-headers",
            workspace_root=tmp_path,
            state_path=fixture.state_path,
            allowed_roots=[tmp_path],
        )
        no_method_status, _, no_method_body = http_post(
            base_url,
            token=run["runToken"],
            payload=call,
            extra_headers=stateless,
            expect_error=True,
        )
        no_name_status, _, no_name_body = http_post(
            base_url,
            token=run["runToken"],
            payload=call,
            extra_headers={**stateless, METHOD_HEADER: "tools/call"},
            expect_error=True,
        )
        # `Mcp-Name` is required only where the method names a target.
        list_status, _, _ = http_post(
            base_url,
            token=run["runToken"],
            payload={"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            extra_headers={**stateless, METHOD_HEADER: "tools/list"},
        )
        # Below 2026-07-28 the same headerless request is still legal.
        legacy_status, _, _ = http_post(base_url, token=run["runToken"], payload=call)

    assert no_method_status == 400
    assert no_method_body["error"] == "missing_required_header"
    assert no_name_status == 400
    assert no_name_body["error"] == "missing_required_header"
    assert list_status == 200
    assert legacy_status == 200


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
    write_registry_role(plugin_root, "plugin_writer", label="Plugin Writer", implement=[{"skill": "plugin_writer"}])
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
        actor("workspace-user", "user"),
    )
    recommendations = server.call_tool(
        "sprintengine.feedback.recommend_actions",
        {"statePath": str(fixture.state_path)},
        actor("workspace-user", "user"),
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
