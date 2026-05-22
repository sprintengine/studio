from __future__ import annotations

import json
import os
import subprocess
import sys

from helpers import REPO_ROOT, create_team, get_task, read_state, task, write_state
from sprintengine_mcp import SprintEngineMcpServer
from sprintengine_mcp.schemas import MCP_V1_CONTRACT_SCHEMAS, TOOL_SCHEMAS


def actor(agent_id: str, role: str = "product") -> dict[str, object]:
    return {"id": agent_id, "role": role, "mcpAuthorized": True}


def audit_rows(team_dir):
    path = team_dir / "metrics" / "audit-events.jsonl"
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


def test_mcp_tool_schemas_cover_swarm_command_groups() -> None:
    expected = {
        "sprintengine.init",
        "sprintengine.recover",
        "sprintengine.roster.add",
        "sprintengine.roster.retire",
        "sprintengine.roster.replenish",
        "sprintengine.roster.list",
        "sprintengine.agent.join",
        "sprintengine.agent.heartbeat",
        "sprintengine.agent.leave",
        "sprintengine.subscribe",
        "sprintengine.join",
        "sprintengine.summary",
        "sprintengine.dispatch.next",
        "sprintengine.dispatch.ack",
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
    listed = SprintEngineMcpServer().list_tools()
    assert {tool["name"] for tool in listed} == expected
    assert all("inputSchema" in tool for tool in listed)


def test_mcp_v1_contract_schemas_include_planned_lifecycle_and_dispatch_tools() -> None:
    planned = {
        "sprintengine.agent.join",
        "sprintengine.agent.heartbeat",
        "sprintengine.agent.leave",
        "sprintengine.subscribe",
        "sprintengine.dispatch.next",
        "sprintengine.dispatch.ack",
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
    }
    active_now = planned

    assert planned <= set(MCP_V1_CONTRACT_SCHEMAS)
    assert active_now <= set(TOOL_SCHEMAS)


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
    assert "mode" in policy["result"]["runner"]
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
    assert changes["result"]["task"]["status"] == "needs_input"
    assert changes["result"]["task"]["needsInput"]["kind"] == "owner"


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
    assert result["legacyJoin"]["action"] == "resume"
    assert [row["operation_name"] for row in audit_rows(fixture.team_dir)] == [
        "sprintengine.task.next",
        "sprintengine.agent.join",
    ]


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
    assert joined["result"]["legacyJoin"]["ok"] is False
    assert read_state(fixture.state_path)["agents"]["writer-1"]["role"] == "writer"


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
        },
        actor("workspace-user", "user"),
    )

    assert response["ok"] is True
    task_record = response["result"]["task"]
    assert task_record["needsTriage"] is True

    update = server.call_tool(
        "sprintengine.plan.update_task",
        {
            "statePath": str(fixture.state_path),
            "taskId": task_record["id"],
            "clearNeedsTriage": True,
        },
        actor("workspace-user", "user"),
    )

    assert update["ok"] is True
    assert update["result"]["task"]["needsTriage"] is False


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
    roles_result = responses[0]["result"]
    task_result = responses[1]["result"]
    assert roles_result["ok"] is True
    assert any(role["id"] == "plugin_writer" and role["source"]["layer"] == "plugin:0" for role in roles_result["result"]["roles"])
    assert task_result["ok"] is False
    assert task_result["error"]["code"] == "state_path_not_allowed"


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
