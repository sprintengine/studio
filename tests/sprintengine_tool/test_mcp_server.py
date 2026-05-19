from __future__ import annotations

import json
import os
import subprocess
import sys

from helpers import REPO_ROOT, create_team, get_task, read_state, task, write_state
from sprintengine_mcp import SprintEngineMcpServer
from sprintengine_mcp.schemas import TOOL_SCHEMAS


def actor(agent_id: str, role: str = "product") -> dict[str, object]:
    return {"id": agent_id, "role": role, "mcpAuthorized": True}


def audit_rows(team_dir):
    path = team_dir / "metrics" / "audit-events.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def test_mcp_tool_schemas_cover_swarm_command_groups() -> None:
    expected = {
        "sprintengine.init",
        "sprintengine.recover",
        "sprintengine.roster.add",
        "sprintengine.roster.retire",
        "sprintengine.roster.replenish",
        "sprintengine.roster.list",
        "sprintengine.join",
        "sprintengine.summary",
        "sprintengine.task.next",
        "sprintengine.task.claim",
        "sprintengine.task.status",
        "sprintengine.task.resolve_input",
        "sprintengine.task.release",
        "sprintengine.task.ready",
        "sprintengine.task.log",
        "sprintengine.task.note",
        "sprintengine.task.comment",
        "sprintengine.task.list",
        "sprintengine.plan.add_task",
        "sprintengine.plan.update_task",
        "sprintengine.plan.delete_task",
        "sprintengine.plan.add_dependency",
        "sprintengine.plan.remove_dependency",
        "sprintengine.plan.start_review",
        "sprintengine.plan.review_status",
        "sprintengine.plan.address_reviews",
        "sprintengine.artifact.add",
        "sprintengine.artifact.list",
        "sprintengine.artifact.ready",
        "sprintengine.artifact.approve",
        "sprintengine.artifact.request_changes",
        "sprintengine.feedback.summarize",
        "sprintengine.feedback.recommend_actions",
        "sprintengine.health",
    }

    assert set(TOOL_SCHEMAS) == expected
    listed = SprintEngineMcpServer().list_tools()
    assert {tool["name"] for tool in listed} == expected
    assert all("inputSchema" in tool for tool in listed)


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
    listed = responses[1]["result"]
    claimed = responses[2]["result"]
    assert listed["ok"] is True
    assert [entry["id"] for entry in listed["result"]["readyTasks"]] == ["T1"]
    assert claimed["ok"] is True
    assert claimed["result"]["claimed"] is True
    assert claimed["result"]["task"]["id"] == "T1"

    state = read_state(fixture.state_path)
    assert get_task(state, "T1")["ownerAgentId"] == "developer-stdio"
    assert [row["operation_name"] for row in audit_rows(fixture.team_dir)] == ["sprintengine.task.next"]


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
    result = response["result"]
    assert result["ok"] is False
    assert result["error"]["code"] == "unauthorized"
    assert "authenticated actor context" in result["error"]["message"]


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
