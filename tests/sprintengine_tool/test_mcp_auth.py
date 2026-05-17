from __future__ import annotations

import json
import os

import pytest

from helpers import create_team, read_state, task, write_state
from sprintengine_mcp import SprintEngineMcpServer


def actor(
    agent_id: str,
    role: str = "product",
    authenticated: bool = True,
    mcp_authorized: bool = True,
) -> dict[str, object]:
    return {
        "id": agent_id,
        "role": role,
        "authenticated": authenticated,
        "mcpAuthorized": mcp_authorized,
    }


def test_mcp_call_requires_authenticated_mcp_authorized_actor(tmp_path) -> None:
    fixture = create_team(tmp_path, "mcp-auth-required", [task("T1", "Implement boundary", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    payload = {
        "statePath": str(fixture.state_path),
        "role": "developer",
        "id": "developer-a",
    }

    missing_actor = server.call_tool("sprintengine.task.next", payload)
    unauthenticated_actor = server.call_tool(
        "sprintengine.task.next",
        payload,
        actor("mcp-user", authenticated=False),
    )
    unauthorized_actor = server.call_tool(
        "sprintengine.task.next",
        payload,
        actor("mcp-user", mcp_authorized=False),
    )
    invalid_flag_actor = server.call_tool(
        "sprintengine.task.next",
        payload,
        {"id": "mcp-user", "authenticated": "false", "mcpAuthorized": True},
    )

    assert missing_actor["ok"] is False
    assert missing_actor["error"]["code"] == "unauthorized"
    assert "authenticated actor context" in missing_actor["error"]["message"]
    assert unauthenticated_actor["ok"] is False
    assert unauthenticated_actor["error"]["code"] == "unauthorized"
    assert unauthorized_actor["ok"] is False
    assert unauthorized_actor["error"]["code"] == "unauthorized"
    assert "MCP-authorized actor context" in unauthorized_actor["error"]["message"]
    assert invalid_flag_actor["ok"] is False
    assert invalid_flag_actor["error"]["code"] == "unauthorized"
    assert "must be a boolean" in invalid_flag_actor["error"]["message"]
    state = read_state(fixture.state_path)
    assert state["tasks"][0]["status"] == "todo"


@pytest.mark.parametrize(
    ("tool_name", "payload"),
    [
        ("sprintengine.summary", {}),
        ("sprintengine.roster.list", {}),
        ("sprintengine.task.list", {"role": "developer"}),
        ("sprintengine.artifact.list", {}),
        ("sprintengine.plan.review_status", {}),
        ("sprintengine.feedback.summarize", {}),
        ("sprintengine.feedback.recommend_actions", {}),
        ("sprintengine.health", {}),
    ],
)
def test_every_mcp_read_and_health_tool_requires_authenticated_user(tmp_path, tool_name, payload) -> None:
    fixture = create_team(tmp_path, "mcp-read-auth-required", [task("T1", "Read auth", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    response = server.call_tool(tool_name, {"statePath": str(fixture.state_path), **payload})

    assert response["ok"] is False
    assert response["error"]["code"] == "unauthorized"
    assert "authenticated actor context" in response["error"]["message"]


def test_authenticated_mcp_user_can_invoke_task_tool_with_payload_agent_id(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "mcp-task-owner",
        [task("T1", "Owned implementation", "developer", status="in_progress", owner="developer-a")],
    )
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    response = server.call_tool(
        "sprintengine.task.log",
        {
            "statePath": str(fixture.state_path),
            "taskId": "T1",
            "id": "developer-b",
            "summary": "Tried to overwrite evidence",
        },
        actor("workspace-user", "product"),
    )

    assert response["ok"] is True
    state = read_state(fixture.state_path)
    assert state["tasks"][0]["evidence"]["summary"] == "Tried to overwrite evidence"
    assert state["events"][-1]["actor"] == "developer-b"


def test_authenticated_mcp_user_can_invoke_plan_tool_without_architect_role(tmp_path) -> None:
    fixture = create_team(tmp_path, "mcp-plan-auth", [task("T1", "Existing task", "developer")])
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
            "title": "Payload graph edit",
            "role": "developer",
            "actor": "developer-a",
        },
        actor("workspace-user", "tester"),
    )

    assert response["ok"] is True
    state = read_state(fixture.state_path)
    assert len(state["tasks"]) == 2
    assert state["tasks"][1]["title"] == "Payload graph edit"
    assert state["events"][-1]["actor"] == "developer-a"


def test_allowed_roots_reject_out_of_scope_and_platform_confused_paths(tmp_path) -> None:
    fixture = create_team(tmp_path, "mcp-path-auth", [task("T1", "Path guarded", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path / "allowed"])

    out_of_scope = server.call_tool("sprintengine.summary", {"statePath": str(fixture.state_path)}, actor("workspace-user"))
    platform_confused = server.call_tool("sprintengine.summary", {"statePath": r"C:\workspace\.multi-code\sprintengine\state.yaml"}, actor("workspace-user"))

    assert out_of_scope["ok"] is False
    assert out_of_scope["error"]["code"] == "state_path_not_allowed"
    assert platform_confused["ok"] is False
    if os.name == "nt":
        assert platform_confused["error"]["code"] == "state_path_not_allowed"
    else:
        assert platform_confused["error"]["code"] == "invalid_state_path"
        assert "Windows and POSIX" in platform_confused["error"]["message"]


def test_authenticated_mcp_user_can_invoke_artifact_review_with_payload_actor(tmp_path) -> None:
    artifact_file = tmp_path / ".multi-code" / "sprintengine" / "mcp-artifact-auth" / "review.md"
    artifact_file.parent.mkdir(parents=True)
    artifact_file.write_text("review", encoding="utf-8")
    fixture = create_team(
        tmp_path,
        "mcp-artifact-auth",
        [task("T1", "Review gate", "developer", status="needs_input", owner="developer-a")],
    )
    state = read_state(fixture.state_path)
    state["artifacts"] = [
        {
            "id": "A1",
            "kind": "code_review",
            "title": "Review",
            "path": "review.md",
            "status": "ready_for_review",
            "createdBy": "developer-a",
            "taskId": "T1",
            "reviewHistory": [],
            "recommendedTasks": [],
        }
    ]
    fixture.state_path.write_text(json.dumps(state, indent=2), encoding="utf-8")
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    approved = server.call_tool(
        "sprintengine.artifact.approve",
        {"statePath": str(fixture.state_path), "artifactId": "A1", "id": "review-board"},
        actor("workspace-user", "security"),
    )

    assert approved["ok"] is True
    assert approved["result"]["artifact"]["status"] == "approved"
    assert approved["result"]["artifact"]["approvedBy"] == "review-board"


def test_authenticated_mcp_user_can_invoke_feedback_tool_without_swarm_role(tmp_path) -> None:
    fixture = create_team(tmp_path, "mcp-feedback-auth", [task("T1", "Feedback", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    response = server.call_tool(
        "sprintengine.feedback.summarize",
        {"statePath": str(fixture.state_path)},
        actor("workspace-user", "not-a-sprintengine-role"),
    )

    assert response["ok"] is True
    assert response["result"]["summary"]["feedbackRecordCount"] == 0
