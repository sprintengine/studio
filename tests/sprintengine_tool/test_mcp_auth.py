from __future__ import annotations
import os

import pytest

from helpers import create_team, create_workspace_team, read_state, task, write_state
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
        ("sprintengine.task.list", {"role": "developer"}),
        ("sprintengine.artifact.list", {}),
        ("sprintengine.plan.list", {}),
        ("sprintengine.plan.read", {}),
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


@pytest.mark.parametrize(
    ("tool_name", "payload"),
    [
        ("sprintengine.task.publish", {"taskId": "T1", "id": "developer-a", "summary": "Done"}),
        ("sprintengine.handover", {"name": "mcp-handover-auth", "handoverText": "Build it."}),
        (
            "sprintengine.task.advance",
            {
                "taskId": "T1",
                "id": "developer-a",
                "phase": "review",
                "outcome": "pass",
                "summary": "Looks good.",
            },
        ),
    ],
)
def test_new_mcp_mutating_lifecycle_and_dispatch_tools_require_authenticated_user(tmp_path, tool_name, payload) -> None:
    fixture = create_team(tmp_path, "mcp-new-mutating-auth-required", [task("T1", "Auth", "developer")])
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


def test_plan_tool_is_architect_or_operator_surface(tmp_path) -> None:
    fixture = create_team(tmp_path, "mcp-plan-auth", [task("T1", "Existing task", "developer")])
    state = read_state(fixture.state_path)
    state["sprintengine"]["rosterConfigured"] = True
    state["agents"] = {
        "developer-a": {"role": "developer", "status": "idle", "currentTaskId": None},
    }
    write_state(fixture.state_path, state)
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    # Role capability policy: plan tools are architect/operator surface. A
    # tester-role actor is rejected; the operator (user) actor edits the graph
    # with the payload actor id still independent of the authenticated id.
    rejected = server.call_tool(
        "sprintengine.plan.add_task",
        {
            "statePath": str(fixture.state_path),
            "title": "Payload graph edit",
            "role": "developer",
            "actor": "developer-a",
        },
        actor("workspace-user", "tester"),
    )
    assert rejected["ok"] is False
    assert rejected["error"]["code"] == "tool_not_permitted_for_role"

    response = server.call_tool(
        "sprintengine.plan.add_task",
        {
            "statePath": str(fixture.state_path),
            "title": "Payload graph edit",
            "role": "developer",
            "actor": "developer-a",
        },
        actor("workspace-user", "user"),
    )

    assert response["ok"] is True
    state = read_state(fixture.state_path)
    assert len(state["tasks"]) == 2
    assert state["tasks"][1]["title"] == "Payload graph edit"
    assert state["events"][-1]["actor"] == "developer-a"


def test_allowed_roots_reject_out_of_scope_and_platform_confused_paths(tmp_path) -> None:
    fixture = create_team(tmp_path, "mcp-path-auth", [task("T1", "Path guarded", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path / "allowed"])

    out_of_scope = server.call_tool("sprintengine.summary", {"statePath": str(fixture.state_path)}, actor("workspace-user", "user"))
    platform_confused = server.call_tool("sprintengine.summary", {"statePath": r"C:\workspace\.multi-code\sprintengine\run.yaml"}, actor("workspace-user", "user"))
    handover_file = tmp_path / "handover.md"
    handover_file.write_text("Outside allowed root.", encoding="utf-8")
    out_of_scope_handover = server.call_tool(
        "sprintengine.handover",
        {
            "statePath": str(tmp_path / "allowed" / ".multi-code" / "sprintengine" / "mcp-handover" / "run.yaml"),
            "name": "mcp-handover",
            "handoverPath": str(handover_file),
        },
        actor("workspace-user", "user"),
    )

    assert out_of_scope["ok"] is False
    assert out_of_scope["error"]["code"] == "state_path_not_allowed"
    assert platform_confused["ok"] is False
    if os.name == "nt":
        assert platform_confused["error"]["code"] == "state_path_not_allowed"
    else:
        assert platform_confused["error"]["code"] == "invalid_state_path"
        assert "Windows and POSIX" in platform_confused["error"]["message"]
    assert out_of_scope_handover["ok"] is False
    assert out_of_scope_handover["error"]["code"] == "input_path_not_allowed"


def test_allowed_roots_contain_traversal_symlink_and_prefix_collision_escapes(tmp_path) -> None:
    """The three ways out of a declared root that are not a plain outside path.

    MC-1611 widened allowedRoots past the workspace to declared sibling repos, which
    makes this boundary the only thing standing between a confused agent and a tree
    nobody declared. Every escape below points at a REAL run with a real state file:
    if containment regressed, the call would answer with that run's summary rather
    than fail, so a pass here cannot be an artifact of the path simply not existing.
    """
    inside = create_workspace_team(tmp_path, "allowed", "inside-run", [task("T1", "Inside", "developer")])
    outside = create_workspace_team(tmp_path, "outside", "outside-run", [task("T1", "Outside", "developer")])
    # `allowed-evil` is a string-prefix sibling of `allowed`: a containment check
    # written as a startswith() on the root would authorize it.
    prefix_collision = create_workspace_team(tmp_path, "allowed-evil", "evil-run", [task("T1", "Evil", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path / "allowed"])

    def summary(state_path) -> dict[str, object]:
        return server.call_tool("sprintengine.summary", {"statePath": str(state_path)}, actor("workspace-user", "user"))

    # Baseline: the declared root itself resolves, so a denial below is containment
    # talking and not a broken fixture.
    assert summary(inside.state_path)["ok"] is True

    traversal = summary(tmp_path / "allowed" / ".." / "outside" / ".multi-code" / "sprintengine" / "outside-run" / "run.yaml")
    assert traversal["ok"] is False
    assert traversal["error"]["code"] == "state_path_not_allowed"

    collision = summary(prefix_collision.state_path)
    assert collision["ok"] is False
    assert collision["error"]["code"] == "state_path_not_allowed"

    if os.name != "nt":
        # A symlink planted inside the declared root pointing at a tree outside it.
        # The boundary resolves links before judging, so the real target is what gets
        # compared — following the link must not launder the escape.
        link = tmp_path / "allowed" / "escape-hatch"
        link.symlink_to(tmp_path / "outside", target_is_directory=True)
        symlinked = summary(link / ".multi-code" / "sprintengine" / "outside-run" / "run.yaml")
        assert symlinked["ok"] is False
        assert symlinked["error"]["code"] == "state_path_not_allowed"
        # The escape targeted a real run: prove it, so this can never pass vacuously.
        assert outside.state_path.exists()


def test_artifact_approval_is_operator_surface_with_payload_actor_independence(tmp_path) -> None:
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
    write_state(fixture.state_path, state)
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    # artifact.approve is architect/operator surface; the security reviewer
    # role cannot approve, the operator can, and the payload actor id stays
    # independent of the authenticated identity.
    rejected = server.call_tool(
        "sprintengine.artifact.approve",
        {"statePath": str(fixture.state_path), "artifactId": "A1", "id": "review-board"},
        actor("workspace-user", "security"),
    )
    assert rejected["ok"] is False
    assert rejected["error"]["code"] == "tool_not_permitted_for_role"

    approved = server.call_tool(
        "sprintengine.artifact.approve",
        {"statePath": str(fixture.state_path), "artifactId": "A1", "id": "review-board"},
        actor("workspace-user", "user"),
    )

    assert approved["ok"] is True
    assert approved["result"]["artifact"]["status"] == "approved"
    assert approved["result"]["artifact"]["approvedBy"] == "review-board"


def test_feedback_summarize_is_architect_or_operator_surface(tmp_path) -> None:
    fixture = create_team(tmp_path, "mcp-feedback-auth", [task("T1", "Feedback", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    # feedback.summarize is architect/operator surface; an unrecognized role
    # falls back to the worker surface and is rejected.
    rejected = server.call_tool(
        "sprintengine.feedback.summarize",
        {"statePath": str(fixture.state_path)},
        actor("workspace-user", "not-a-sprintengine-role"),
    )
    assert rejected["ok"] is False
    assert rejected["error"]["code"] == "tool_not_permitted_for_role"

    response = server.call_tool(
        "sprintengine.feedback.summarize",
        {"statePath": str(fixture.state_path)},
        actor("workspace-user", "user"),
    )

    assert response["ok"] is True
    assert response["result"]["summary"]["feedbackRecordCount"] == 0
