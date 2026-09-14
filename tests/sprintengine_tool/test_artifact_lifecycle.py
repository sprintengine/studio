from __future__ import annotations

from helpers import (
    assert_artifact_status,
    assert_event_type,
    assert_task_status,
    create_team,
    create_workspace_team,
    get_artifact,
    get_task,
    read_state,
    task,
    write_state,
)
from sprintengine_core import store
from sprintengine_mcp import SprintEngineMcpServer


def write_team_file(fixture, relative_path: str, content: str = "# Artifact\n") -> None:
    path = fixture.team_dir / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def test_stamp_implementer_from_owner_records_the_departing_owner() -> None:
    # The artifact-approval and input-resolution done-writers complete a task on
    # the user's action and then clear ownerAgentId, so the truthful implementer
    # is the owner being cleared. Stamp it, or the projection's worker derivation
    # forgets the worker entirely (the ghost-seat stall, 2026-07-16).
    from sprintengine_core.tool.artifacts import stamp_implementer_from_owner

    owned = {"ownerAgentId": "product-fixture"}
    stamp_implementer_from_owner(owned)
    assert owned["lastImplementedByAgentId"] == "product-fixture"


def test_stamp_implementer_from_owner_is_a_noop_without_an_owner() -> None:
    # An ownerless done gate genuinely has no implementer, so nothing is stamped —
    # the key must not be invented (a blank/whitespace owner is the same as none).
    from sprintengine_core.tool.artifacts import stamp_implementer_from_owner

    for empty in (None, "", "   "):
        task_record = {"ownerAgentId": empty}
        stamp_implementer_from_owner(task_record)
        assert "lastImplementedByAgentId" not in task_record


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
    ready_task = get_task(ready_state, "T1")
    assert ready_task["needsInput"]["kind"] == "architect"
    assert ready_task["needsInput"]["reason"] == "artifact_review"
    assert ready_task["needsInput"]["artifactId"] == "A1"
    assert ready_task["needsInput"]["question"] == "Artifact A1 (Requirements) is ready for review."

    triage = fixture.cli.run("triage", "needs-input", "--id", "architect")
    assert [entry["id"] for entry in triage["tasks"]] == ["T1"]
    assert triage["tasks"][0]["artifacts"][0]["id"] == "A1"
    assert "artifact_review" in triage["prompt"]

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
    assert "needsInput" not in get_task(changes_state, "T1")
    # Feedback flows through comments now, not the planning-notes bag.
    assert get_task(changes_state, "T1")["notes"] == []
    assert any(
        comment["type"] == "review_feedback"
        and feedback in comment["body"]
        and comment.get("data", {}).get("artifactId") == "A1"
        for comment in get_task(changes_state, "T1")["comments"]
    )

    fixture.cli.run("artifact", "ready", "--artifact-id", "A1", "--id", "product-fixture")
    approved = fixture.cli.run("artifact", "approve", "--artifact-id", "A1", "--id", "user")
    assert approved["taskCompleted"] is True
    approved_state = read_state(fixture.state_path)
    assert_artifact_status(approved_state, "A1", "approved")
    assert_task_status(approved_state, "T1", "done")
    assert "needsInput" not in get_task(approved_state, "T1")
    assert_event_type(approved_state, "artifact_approved")
    notification = approved_state["events"][-1]
    assert notification["type"] == "agent_notification_requested"
    assert notification["targetAgentId"] == "product-fixture"
    assert notification["taskId"] == "T1"
    assert notification["artifactId"] == "A1"
    assert notification["notificationKind"] == "task_completed_after_artifact_approval"

    # Approval completion clears the owner but must stamp the implementer first:
    # the projection derives done-task workers only from lastImplementedByAgentId,
    # and a live terminal with no worker record is a ghost seat the supervisor can
    # neither wake nor replace (multi-repo-sprints architect stall, 2026-07-16).
    approved_task = get_task(approved_state, "T1")
    assert approved_task["ownerAgentId"] is None
    assert approved_task["lastImplementedByAgentId"] == "product-fixture"
    projection = store.build_projection(fixture.state_path.parent, state_path=fixture.state_path)
    worker = projection["workers"]["product-fixture"]
    assert worker["status"] == "idle"
    assert worker["lastOwnedTaskId"] == "T1"

    history_actions = [entry["action"] for entry in get_artifact(approved_state, "A1")["reviewHistory"]]
    assert history_actions == [
        "created",
        "ready_for_review",
        "changes_requested",
        "ready_for_review",
        "approved",
    ]


def _seed_plan_artifact(
    fixture,
    artifact_id: str,
    stored_path: str,
    status: str,
    *,
    created_by: str = "sprintengine",
) -> None:
    """Inject an architect_plan artifact straight into state with a chosen
    stored path string, so tests can reproduce legacy duplicates whose stored
    paths differ (full-prefix vs bare) but resolve to the same file. Registration
    now dedups same-file artifacts, so the duplicate cannot be created via add."""
    state = read_state(fixture.state_path)
    state.setdefault("artifacts", []).append(
        {
            "id": artifact_id,
            "kind": "architect_plan",
            "title": "Architect Plan",
            "path": stored_path,
            "status": status,
            "createdBy": created_by,
            "taskId": "T0",
            "fingerprint": None,
            "reviewHistory": [{"action": "created", "actor": created_by, "timestamp": "2026-06-19T00:00:00Z"}],
            "recommendedTasks": [],
            "createdAt": "2026-06-19T00:00:00Z",
            "updatedAt": "2026-06-19T00:00:00Z",
        }
    )
    write_state(fixture.state_path, state)


def test_approving_duplicate_same_file_artifact_supersedes_stale_blocker(tmp_path) -> None:
    fixture = create_workspace_team(
        tmp_path,
        "workspace",
        "duplicate-plan-artifacts",
        [task("T0", "Review architect plan artifact", "architect", "in_progress", owner="architect")],
    )
    write_team_file(fixture, "plan.md", "# Plan\n")

    # Legacy duplicate state: A1 stored as the full-prefix path, A2 stored bare;
    # both resolve to the same plan.md file.
    _seed_plan_artifact(fixture, "A1", ".sprintengine/sprintengine/duplicate-plan-artifacts/plan.md", "draft")
    _seed_plan_artifact(fixture, "A2", "plan.md", "ready_for_review", created_by="architect")

    approved = fixture.cli.run("artifact", "approve", "--artifact-id", "A2", "--id", "user")

    state = read_state(fixture.state_path)
    assert approved["taskCompleted"] is True
    assert approved["supersededArtifactIds"] == ["A1"]
    assert_artifact_status(state, "A1", "superseded")
    assert_artifact_status(state, "A2", "approved")
    assert_task_status(state, "T0", "done")
    assert get_artifact(state, "A1")["reviewHistory"][-1]["action"] == "superseded"


def test_registering_same_file_plan_artifact_reuses_existing_full_prefix_artifact(tmp_path) -> None:
    import contextlib

    from sprintengine_core.tool.plans import find_architect_plan_gate

    fixture = create_workspace_team(
        tmp_path,
        "workspace",
        "dedup-registration",
        [task("T0", "Review architect plan artifact", "architect", "in_progress", owner="architect")],
    )
    write_team_file(fixture, "plan.md", "# Plan\n")

    # An init-seeded placeholder stored as the full-prefix path.
    _seed_plan_artifact(fixture, "A1", ".sprintengine/sprintengine/dedup-registration/plan.md", "draft")

    # find_architect_plan_gate must resolve the bare plan.md value to the same
    # file and match the full-prefix stored artifact rather than miss it. Run
    # from the project root (as the real runtime does) so path resolution roots
    # at the workspace, not the test runner's worktree.
    with contextlib.chdir(tmp_path / "workspace"):
        gate = find_architect_plan_gate(read_state(fixture.state_path), fixture.state_path)
    assert gate["artifact"]["id"] == "A1"

    # The architect registers the plan with the bare path; registration must
    # reuse A1 instead of creating a second same-file artifact.
    added = fixture.cli.run(
        "artifact",
        "add",
        "--actor",
        "architect",
        "--task-id",
        "T0",
        "--kind",
        "architect_plan",
        "--title",
        "Architect Plan",
        "--path",
        "plan.md",
        "--created-by",
        "architect",
    )
    assert added["reused"] is True
    assert added["artifact"]["id"] == "A1"

    state = read_state(fixture.state_path)
    plan_artifacts = [a for a in state["artifacts"] if a["taskId"] == "T0" and a["kind"] == "architect_plan"]
    assert len(plan_artifacts) == 1
    assert plan_artifacts[0]["createdBy"] == "architect"


def test_marking_ready_supersedes_stale_same_file_duplicate(tmp_path) -> None:
    fixture = create_workspace_team(
        tmp_path,
        "workspace",
        "ready-self-heal",
        [task("T0", "Review architect plan artifact", "architect", "in_progress", owner="architect")],
    )
    write_team_file(fixture, "plan.md", "# Plan\n")

    # Stale full-prefix draft placeholder plus a bare-path real plan; both
    # resolve to the same file. Marking the real plan ready must self-heal the
    # stale duplicate so it cannot deadlock the auto-approval gate.
    _seed_plan_artifact(fixture, "A1", ".sprintengine/sprintengine/ready-self-heal/plan.md", "draft")
    _seed_plan_artifact(fixture, "A2", "plan.md", "draft", created_by="architect")

    fixture.cli.run("artifact", "ready", "--artifact-id", "A2", "--id", "architect")

    state = read_state(fixture.state_path)
    assert_artifact_status(state, "A1", "superseded")
    assert_artifact_status(state, "A2", "ready_for_review")
    assert get_artifact(state, "A1")["reviewHistory"][-1]["action"] == "superseded"


def test_marking_ready_does_not_supersede_duplicate_resolving_to_different_file(tmp_path) -> None:
    fixture = create_workspace_team(
        tmp_path,
        "workspace",
        "ready-distinct-file",
        [task("T0", "Review architect plan artifact", "architect", "in_progress", owner="architect")],
    )
    write_team_file(fixture, "plan.md", "# Plan\n")
    write_team_file(fixture, "plan-old.md", "# Old Plan\n")

    # A genuinely different file must not be superseded when a same-task,
    # same-kind sibling is marked ready.
    _seed_plan_artifact(fixture, "A1", "plan-old.md", "draft", created_by="architect")
    _seed_plan_artifact(fixture, "A2", "plan.md", "draft", created_by="architect")

    fixture.cli.run("artifact", "ready", "--artifact-id", "A2", "--id", "architect")

    state = read_state(fixture.state_path)
    assert_artifact_status(state, "A1", "draft")
    assert_artifact_status(state, "A2", "ready_for_review")


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
    store.sync_state_to_store(fixture.team_dir, state, state_path=fixture.state_path)

    ready_failure = fixture.cli.run_failure("artifact", "ready", "--artifact-id", "A1", "--id", "architect-fixture")
    assert "Superseded artifacts cannot be marked ready" in ready_failure.stderr

    approve_failure = fixture.cli.run_failure("artifact", "approve", "--artifact-id", "A1", "--id", "user")
    assert "Superseded artifacts cannot be approved" in approve_failure.stderr

        # A superseded artifact alone does not keep the producer task in review.
    state_after_failures = read_state(fixture.state_path)
    state_after_failures["sprintengine"]["qualityPolicy"] = {"enabled": False}
    task_record = get_task(state_after_failures, "T1")
    task_record["status"] = "in_progress"
    task_record.pop("qualityGates", None)
    write_state(fixture.state_path, state_after_failures)

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
    write_state(fixture.state_path, state)
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    # Role capability policy: artifact.approve is architect/operator surface.
    # An actor declaring an unrecognized role gets the worker surface and is
    # rejected; the operator (user) actor approves with the payload actor id
    # still independent of the authenticated identity.
    rejected = server.call_tool(
        "sprintengine.artifact.approve",
        {"statePath": str(fixture.state_path), "artifactId": "A1", "id": "code-reviewer-fixture"},
        {"id": "workspace-user", "role": "not-a-sprintengine-role", "authenticated": True, "mcpAuthorized": True},
    )
    assert rejected["ok"] is False
    assert rejected["error"]["code"] == "tool_not_permitted_for_role"

    approved = server.call_tool(
        "sprintengine.artifact.approve",
        {"statePath": str(fixture.state_path), "artifactId": "A1", "id": "code-reviewer-fixture"},
        {"id": "workspace-user", "role": "user", "authenticated": True, "mcpAuthorized": True},
    )

    assert approved["ok"] is True
    approved_state = read_state(fixture.state_path)
    artifact = get_artifact(approved_state, "A1")
    assert_artifact_status(approved_state, "A1", "approved")
    assert artifact["approvedBy"] == "code-reviewer-fixture"
    assert_task_status(approved_state, "T1", "done")


def test_mcp_artifact_add_rejects_unknown_kind_with_corrective_error(tmp_path) -> None:
    # Regression: the MCP payload adapter bypasses the CLI argparse choices,
    # so an agent could register an invented kind (e.g. "frontend_design").
    # The stored unknown kind then broke artifact review surfaces and
    # auto-approval downstream. Kind must be validated at the mutation path.
    fixture = create_team(
        tmp_path,
        "mcp-artifact-kind-validation",
        [task("T1", "Design notes", "frontend", "in_progress", owner="frontend-fixture")],
    )
    write_team_file(fixture, "design.md", "# Design\n")
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])
    actor_context = {"id": "frontend-fixture", "role": "frontend", "authenticated": True, "mcpAuthorized": True}

    rejected = server.call_tool(
        "sprintengine.artifact.add",
        {
            "statePath": str(fixture.state_path),
            "taskId": "T1",
            "kind": "frontend_design",
            "title": "Design notes",
            "path": "design.md",
            "createdBy": "frontend-fixture",
        },
        actor_context,
    )
    assert rejected["ok"] is False
    assert "Invalid artifact kind: frontend_design" in rejected["error"]["message"]
    # The error must teach the caller the valid vocabulary so the agent can
    # immediately re-register with a correct kind.
    assert "design_notes" in rejected["error"]["message"]
    assert read_state(fixture.state_path).get("artifacts", []) == []

    accepted = server.call_tool(
        "sprintengine.artifact.add",
        {
            "statePath": str(fixture.state_path),
            "taskId": "T1",
            "kind": "design_notes",
            "title": "Design notes",
            "path": "design.md",
            "createdBy": "frontend-fixture",
        },
        actor_context,
    )
    assert accepted["ok"] is True
    assert accepted["result"]["artifact"]["kind"] == "design_notes"


def _approve_with_mode(base_path, approval_mode: str) -> dict:
    """Seed a ready code_review artifact and CLI-approve it with approvalMode."""
    fixture_task = task("T1", "Review artifact", "developer", "needs_input", owner="developer-fixture")
    fixture = create_team(base_path, f"artifact-approval-mode-{approval_mode}", [fixture_task])
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
    write_state(fixture.state_path, state)
    fixture.cli.run("artifact", "approve", "--artifact-id", "A1", "--id", "user", "--approval-mode", approval_mode)
    return get_artifact(read_state(fixture.state_path), "A1")


def test_artifact_approve_persists_approval_mode_for_both_values(tmp_path) -> None:
    for approval_mode in ("manual", "policy"):
        artifact = _approve_with_mode(tmp_path / approval_mode, approval_mode)
        assert artifact["status"] == "approved"
        assert artifact["approvalMode"] == approval_mode
        approved_history = [entry for entry in artifact["reviewHistory"] if entry["action"] == "approved"]
        assert approved_history[-1]["note"] == f"Approval mode: {approval_mode}."


def test_artifact_approve_without_mode_stays_back_compatible(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "artifact-approval-no-mode",
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
    write_state(fixture.state_path, state)

    fixture.cli.run("artifact", "approve", "--artifact-id", "A1", "--id", "user")

    artifact = get_artifact(read_state(fixture.state_path), "A1")
    assert artifact["status"] == "approved"
    # Legacy back-compat: an approval without a mode omits the field entirely and
    # its approve history entry carries no mode note.
    assert "approvalMode" not in artifact
    approved_history = [entry for entry in artifact["reviewHistory"] if entry["action"] == "approved"]
    assert "note" not in approved_history[-1]


def test_mcp_artifact_approve_forwards_and_validates_approval_mode(tmp_path) -> None:
    # The MCP payload adapter builds the argparse namespace directly and bypasses
    # the CLI choices, so approvalMode must be validated at the mutation path
    # (mirrors the artifact-kind validation regression).
    fixture = create_team(
        tmp_path,
        "mcp-artifact-approval-mode",
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
    write_state(fixture.state_path, state)
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])
    actor_context = {"id": "workspace-user", "role": "user", "authenticated": True, "mcpAuthorized": True}

    rejected = server.call_tool(
        "sprintengine.artifact.approve",
        {"statePath": str(fixture.state_path), "artifactId": "A1", "id": "user", "approvalMode": "auto"},
        actor_context,
    )
    assert rejected["ok"] is False
    assert "Invalid approvalMode: auto" in rejected["error"]["message"]
    assert_artifact_status(read_state(fixture.state_path), "A1", "ready_for_review")

    approved = server.call_tool(
        "sprintengine.artifact.approve",
        {"statePath": str(fixture.state_path), "artifactId": "A1", "id": "user", "approvalMode": "policy"},
        actor_context,
    )
    assert approved["ok"] is True
    artifact = get_artifact(read_state(fixture.state_path), "A1")
    assert artifact["approvalMode"] == "policy"
