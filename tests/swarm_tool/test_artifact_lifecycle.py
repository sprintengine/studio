from __future__ import annotations

import json

from helpers import (
    assert_artifact_status,
    assert_event_type,
    assert_task_status,
    create_team,
    get_artifact,
    get_task,
    read_state,
    task,
)
from swarm_mcp import SwarmMcpServer


def write_team_file(fixture, relative_path: str, content: str = "# Artifact\n") -> None:
    path = fixture.team_dir / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def test_artifact_add_ready_approve_and_request_changes_cover_lifecycle_statuses(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "artifact-statuses",
        [task("T1", "Produce requirements", "product", "in_progress", owner="product-fixture")],
    )
    write_team_file(fixture, "requirements.md", "# Requirements\n")

    added = fixture.cli.run(
        "artifact",
        "add",
        "--actor",
        "product-fixture",
        "--artifact-id",
        "A1",
        "--task-id",
        "T1",
        "--kind",
        "requirements",
        "--title",
        "Requirements",
        "--path",
        "requirements.md",
        "--created-by",
        "product-fixture",
    )
    assert added["artifact"]["status"] == "draft"
    assert_artifact_status(read_state(fixture.state_path), "A1", "draft")

    ready = fixture.cli.run("artifact", "ready", "--artifact-id", "A1", "--id", "product-fixture")
    assert ready["transition"] == {"taskId": "T1", "taskStatus": "needs_input", "artifactStatus": "ready_for_review"}
    ready_state = read_state(fixture.state_path)
    assert_artifact_status(ready_state, "A1", "ready_for_review")
    assert_task_status(ready_state, "T1", "needs_input")

    feedback = "Tighten the requirement language."
    changes = fixture.cli.run(
        "artifact",
        "request-changes",
        "--artifact-id",
        "A1",
        "--id",
        "user",
        "--feedback",
        feedback,
    )
    assert changes["reopenedStatus"] == "in_progress"
    changes_state = read_state(fixture.state_path)
    assert_artifact_status(changes_state, "A1", "changes_requested")
    assert_task_status(changes_state, "T1", "in_progress")
    assert any(feedback in note for note in get_task(changes_state, "T1")["notes"])

    fixture.cli.run("artifact", "ready", "--artifact-id", "A1", "--id", "product-fixture")
    approved = fixture.cli.run("artifact", "approve", "--artifact-id", "A1", "--id", "user")
    assert approved["taskCompleted"] is True
    approved_state = read_state(fixture.state_path)
    assert_artifact_status(approved_state, "A1", "approved")
    assert_task_status(approved_state, "T1", "done")
    assert_event_type(approved_state, "artifact_approved")

    history_actions = [entry["action"] for entry in get_artifact(approved_state, "A1")["reviewHistory"]]
    assert history_actions == [
        "created",
        "ready_for_review",
        "changes_requested",
        "ready_for_review",
        "approved",
    ]


def test_superseded_artifacts_are_not_reviewable_or_approval_blocking(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "superseded-artifacts",
        [task("T1", "Produce plan", "architect", "needs_input", owner="architect-fixture")],
    )
    write_team_file(fixture, "plan.md", "# Plan\n")

    fixture.cli.run(
        "artifact",
        "add",
        "--actor",
        "architect-fixture",
        "--artifact-id",
        "A1",
        "--task-id",
        "T1",
        "--kind",
        "architect_plan",
        "--title",
        "Old Plan",
        "--path",
        "plan.md",
        "--created-by",
        "architect-fixture",
    )

    state = read_state(fixture.state_path)
    old_artifact = get_artifact(state, "A1")
    old_artifact["status"] = "superseded"
    fixture.state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")

    ready_failure = fixture.cli.run_failure("artifact", "ready", "--artifact-id", "A1", "--id", "architect-fixture")
    assert "Superseded artifacts cannot be marked ready" in ready_failure.stderr

    approve_failure = fixture.cli.run_failure("artifact", "approve", "--artifact-id", "A1", "--id", "user")
    assert "Superseded artifacts cannot be approved" in approve_failure.stderr

    # A superseded artifact alone does not keep the producer task in review.
    state_after_failures = read_state(fixture.state_path)
    get_task(state_after_failures, "T1")["status"] = "in_progress"
    fixture.state_path.write_text(json.dumps(state_after_failures, indent=2) + "\n", encoding="utf-8")

    done = fixture.cli.run("task", "status", "--task-id", "T1", "--status", "done", "--id", "architect-fixture")
    assert done["ok"] is True
    assert_task_status(read_state(fixture.state_path), "T1", "done")


def test_authenticated_mcp_user_approval_preserves_payload_actor_and_role_independence(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "mcp-user-artifact-approval",
        [task("T1", "Review artifact", "developer", "needs_input", owner="developer-fixture")],
    )
    write_team_file(fixture, "review.md", "# Review\n")
    state = read_state(fixture.state_path)
    state["artifacts"] = [
        {
            "id": "A1",
            "kind": "code_review",
            "title": "Code Review",
            "path": "review.md",
            "status": "ready_for_review",
            "createdBy": "code-reviewer-fixture",
            "taskId": "T1",
            "reviewHistory": [],
            "recommendedTasks": [],
        }
    ]
    fixture.state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    server = SwarmMcpServer(allowed_roots=[tmp_path])

    approved = server.call_tool(
        "swarm.artifact.approve",
        {"statePath": str(fixture.state_path), "artifactId": "A1", "id": "code-reviewer-fixture"},
        {"id": "workspace-user", "role": "not-a-swarm-role", "authenticated": True, "mcpAuthorized": True},
    )

    assert approved["ok"] is True
    approved_state = read_state(fixture.state_path)
    artifact = get_artifact(approved_state, "A1")
    assert_artifact_status(approved_state, "A1", "approved")
    assert artifact["approvedBy"] == "code-reviewer-fixture"
    assert_task_status(approved_state, "T1", "done")
