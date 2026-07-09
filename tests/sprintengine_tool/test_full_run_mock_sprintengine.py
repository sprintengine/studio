from __future__ import annotations

from fixtures import (
    SwarmCli,
    artifact_by_kind,
    assert_board_column,
    assert_ready_tasks,
    assert_task_status,
    get_task,
    read_state,
)
from helpers import assert_artifact_status, get_artifact


def write_team_file(state_path, relative_path: str, content: str = "# Artifact\n") -> None:
    path = state_path.parent / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def add_ready_artifact(
    cli: SwarmCli,
    state_path,
    artifact_id: str,
    task_id: str,
    kind: str,
    path: str,
    title: str,
    actor: str,
    *extra_args: str,
) -> None:
    write_team_file(state_path, path)
    cli.run(
        "artifact",
        "add",
        "--actor",
        actor,
        "--artifact-id",
        artifact_id,
        "--task-id",
        task_id,
        "--kind",
        kind,
        "--title",
        title,
        "--path",
        path,
        "--created-by",
        actor,
        *extra_args,
        "--ready",
    )


def test_full_run_mock_swarm_covers_phase_walk_review_scheduling_auto_approval_and_final_follow_up(tmp_path) -> None:
    state_path = tmp_path / ".multi-code" / "sprintengine" / "full-run-mock" / "run.yaml"
    cli = SwarmCli(state_path)

    init_payload = cli.run(
        "init",
        "--goal",
        "Exercise full sprintengine harness behavior",
        "--agent",
        "product:product-intake",
        "--agent",
        "architect:architect-planner",
        "--agent",
        "architect:architect-scheduler",
        "--agent",
        "architect:architect-final",
        "--agent",
        "developer:developer-full-run",
        "--agent",
        "security:reviewer-full-run",
        "--agent",
        "tester:tester-full-run",
        "--agent",
        "product:product-final",
    )
    product_task_id = init_payload["productTask"]["id"]
    plan_task_id = init_payload["planTask"]["id"]
    product_artifact_id = init_payload["productArtifact"]["id"]

    assert_ready_tasks(cli, "product", [product_task_id])
    assert_ready_tasks(cli, "architect", [])
    cli.run("task", "next", "--role", "product", "--id", "product-intake")
    write_team_file(state_path, "product-requirements.md", "# Requirements\n")
    cli.run("artifact", "ready", "--artifact-id", product_artifact_id, "--id", "product-intake")
    cli.run("artifact", "approve", "--artifact-id", product_artifact_id, "--id", "user")
    assert_ready_tasks(cli, "architect", [plan_task_id])

    cli.run("task", "next", "--role", "architect", "--id", "architect-planner")
    cli.run(
        "plan",
        "add-task",
        "--task-id",
        "T3",
        "--title",
        "Implement behavior",
        "--role",
        "developer",
        "--depends-on",
        plan_task_id,
        "--acceptance",
        "Implementation evidence is logged",
    )
    cli.run(
        "plan",
        "add-task",
        "--task-id",
        "T4",
        "--title",
        "Review implementation",
        "--role",
        "security",
        "--depends-on",
        "T3",
        "--acceptance",
        "Review artifact records verdict and recommended follow-up",
    )
    cli.run(
        "plan",
        "add-task",
        "--task-id",
        "T5",
        "--title",
        "Validate implementation",
        "--role",
        "tester",
        "--depends-on",
        "T4",
        "--acceptance",
        "Validation report is approved through the normal artifact path",
    )
    cli.run(
        "plan",
        "add-task",
        "--task-id",
        "T6",
        "--title",
        "Schedule final reviews",
        "--role",
        "architect",
        "--depends-on",
        "T5",
        "--acceptance",
        "Selected final reviews are added with skip rationale for unneeded reviews",
    )

    plan_artifact = artifact_by_kind(read_state(state_path), "architect_plan")
    write_team_file(state_path, "plan.md", "# Plan\n")
    cli.run("artifact", "ready", "--artifact-id", plan_artifact["id"], "--id", "architect-planner")
    cli.run("artifact", "approve", "--artifact-id", plan_artifact["id"], "--id", "user")

    state_after_gates = read_state(state_path)
    assert_task_status(state_after_gates, product_task_id, "done")
    assert_task_status(state_after_gates, plan_task_id, "done")
    assert_board_column(state_after_gates, "T3", "ready")

    cli.run("task", "next", "--role", "developer", "--id", "developer-full-run")
    cli.run(
        "task",
        "log",
        "--task-id",
        "T3",
        "--id",
        "developer-full-run",
        "--summary",
        "Implemented behavior for full-run fixture.",
        "--file",
        "sprintengine_core/tool.py",
        "--command",
        "pytest tests/sprintengine_tool/test_full_run_mock_swarm.py",
        "--result",
        "Fixture implementation step reached review.",
    )
    published = cli.run(
        "task",
        "publish",
        "--task-id",
        "T3",
        "--id",
        "developer-full-run",
        "--summary",
        "Implementation ready for review.",
    )
    # Publish detects the diff and routes T3 into its review phase, owner intact.
    assert published["nextStatus"] == "review"
    assert published["producedChanges"] is True
    assert published["nextDirective"]
    state_in_review = read_state(state_path)
    assert_task_status(state_in_review, "T3", "review")
    assert get_task(state_in_review, "T3")["ownerAgentId"] == "developer-full-run"
    # A task in review is still owned, so it is not offered to the next claimer.
    assert_ready_tasks(cli, "security", [])

    advanced = cli.run(
        "task",
        "advance",
        "--task-id",
        "T3",
        "--id",
        "developer-full-run",
        "--phase",
        "review",
        "--outcome",
        "pass_with_fixes",
        "--summary",
        "Self-reviewed; tightened one assertion.",
        "--confidence-pct",
        "88",
        "--hallucination-risk-pct",
        "5",
    )
    assert advanced["nextStatus"] == "done"
    assert advanced["feedbackRecorded"] is True

    cli.run("task", "next", "--role", "security", "--id", "reviewer-full-run")
    add_ready_artifact(
        cli,
        state_path,
        "A3",
        "T4",
        "code_review",
        "reviews/code-review.md",
        "Code Review",
        "reviewer-full-run",
        "--recommended-task",
        "Add follow-up hardening",
    )
    cli.run(
        "artifact",
        "request-changes",
        "--artifact-id",
        "A3",
        "--id",
        "user",
        "--feedback",
        "Clarify the review verdict before downstream validation proceeds.",
    )
    state_after_changes = read_state(state_path)
    assert_artifact_status(state_after_changes, "A3", "changes_requested")
    assert_task_status(state_after_changes, "T4", "in_progress")
    assert_board_column(state_after_changes, "T5", "todo")

    write_team_file(state_path, "reviews/code-review.md", "# Code Review\n\nVerdict: approved\n")
    cli.run("artifact", "ready", "--artifact-id", "A3", "--id", "reviewer-full-run")
    cli.run("artifact", "approve", "--artifact-id", "A3", "--id", "user")
    state_after_review = read_state(state_path)
    assert_task_status(state_after_review, "T4", "done")
    assert get_artifact(state_after_review, "A3")["recommendedTasks"] == ["Add follow-up hardening"]

    cli.run("task", "next", "--role", "tester", "--id", "tester-full-run")
    add_ready_artifact(
        cli,
        state_path,
        "A4",
        "T5",
        "validation_report",
        "validation/report.md",
        "Validation Report",
        "tester-full-run",
    )
    cli.run("artifact", "approve", "--artifact-id", "A4", "--id", "auto-run")
    state_after_auto_approval = read_state(state_path)
    assert_task_status(state_after_auto_approval, "T5", "done")
    assert get_artifact(state_after_auto_approval, "A4")["approvedBy"] == "auto-run"
    assert_board_column(state_after_auto_approval, "T6", "ready")

    cli.run("task", "next", "--role", "architect", "--id", "architect-scheduler")
    cli.run(
        "plan",
        "add-task",
        "--task-id",
        "T7",
        "--title",
        "Product final acceptance",
        "--role",
        "product",
        "--depends-on",
        "T6",
        "--acceptance",
        "Product final review is approved",
    )
    cli.run(
        "plan",
        "add-task",
        "--task-id",
        "T8",
        "--title",
        "Architect final review",
        "--role",
        "architect",
        "--depends-on",
        "T7",
        "--acceptance",
        "Follow-up work is added as new tasks followed by another architect review",
    )
    cli.run(
        "task",
        "log",
        "--task-id",
        "T6",
        "--id",
        "architect-scheduler",
        "--summary",
        "Scheduled product final review and skipped security/performance for this fixture.",
        "--file",
        ".multi-code/sprintengine/sprintengine-tool-mcp-server-and-test-harness/reviews/final-review-schedule-1.md",
        "--command",
        "Sprint Engine plan add-task --task-id T7 ... and Sprint Engine plan add-task --task-id T8 ...",
        "--result",
        "Selected product final review; skipped security and performance with rationale.",
    )
    cli.run(
        "task",
        "status",
        "--task-id",
        "T6",
        "--status",
        "done",
        "--id",
        "architect-scheduler",
    )
    assert_ready_tasks(cli, "product", ["T7"])

    cli.run("task", "next", "--role", "product", "--id", "product-final")
    add_ready_artifact(
        cli,
        state_path,
        "A5",
        "T7",
        "product_strategy",
        "reviews/product-final.md",
        "Product Final Review",
        "product-final",
    )
    cli.run("artifact", "approve", "--artifact-id", "A5", "--id", "user")
    assert_ready_tasks(cli, "architect", ["T8"])

    cli.run("task", "next", "--role", "architect", "--id", "architect-final")
    cli.run(
        "plan",
        "add-task",
        "--task-id",
        "T9",
        "--title",
        "Address final follow-up",
        "--role",
        "developer",
        "--depends-on",
        "T8",
        "--acceptance",
        "Follow-up work is implemented in a new task",
    )
    cli.run(
        "plan",
        "add-task",
        "--task-id",
        "T10",
        "--title",
        "Architect final review follow-up",
        "--role",
        "architect",
        "--depends-on",
        "T9",
        "--acceptance",
        "Second final review follows new follow-up work",
    )
    cli.run(
        "task",
        "log",
        "--task-id",
        "T8",
        "--id",
        "architect-final",
        "--summary",
        "Converted final review gap into follow-up tasks.",
        "--file",
        ".multi-code/sprintengine/sprintengine-tool-mcp-server-and-test-harness/reviews/architect-final-review-1.md",
        "--command",
        "Sprint Engine plan add-task --task-id T9 ... and Sprint Engine plan add-task --task-id T10 ...",
        "--result",
        "Follow-up developer task and later architect final review task created.",
    )
    cli.run(
        "task",
        "status",
        "--task-id",
        "T8",
        "--status",
        "done",
        "--id",
        "architect-final",
    )

    final_state = read_state(state_path)
    assert_task_status(final_state, "T3", "done")
    assert_task_status(final_state, "T6", "done")
    assert_task_status(final_state, "T7", "done")
    assert_task_status(final_state, "T8", "done")
    assert_task_status(final_state, "T9", "todo")
    assert_task_status(final_state, "T10", "todo")
    assert_board_column(final_state, "T9", "ready")
    assert_board_column(final_state, "T10", "todo")
    assert get_task(final_state, "T10")["dependsOn"] == ["T9"]
