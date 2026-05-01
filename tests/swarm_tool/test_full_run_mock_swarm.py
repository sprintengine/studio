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


def test_full_run_mock_swarm_covers_gates_reviews_auto_approval_and_final_follow_up(tmp_path) -> None:
    state_path = tmp_path / "swarm" / "full-run-mock" / "state.yaml"
    cli = SwarmCli(state_path)

    init_payload = cli.run("init", "--goal", "Exercise full swarm harness behavior")
    product_task_id = init_payload["productTask"]["id"]
    plan_task_id = init_payload["planTask"]["id"]
    product_artifact_id = init_payload["productArtifact"]["id"]

    assert_ready_tasks(cli, "architect", [])
    write_team_file(state_path, "product-requirements.md", "# Requirements\n")
    cli.run("artifact", "ready", "--artifact-id", product_artifact_id, "--id", "product")
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
        "code_reviewer",
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
        "Product final acceptance",
        "--role",
        "product",
        "--depends-on",
        "T5",
        "--acceptance",
        "Product final review is approved",
    )
    cli.run(
        "plan",
        "add-task",
        "--task-id",
        "T7",
        "--title",
        "Architect final review",
        "--role",
        "architect",
        "--depends-on",
        "T6",
        "--acceptance",
        "Follow-up work is added as new tasks followed by another architect review",
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
        "swarm_core/tool.py",
        "--command",
        "pytest tests/swarm_tool/test_full_run_mock_swarm.py",
        "--result",
        "Fixture implementation step reached review.",
    )
    cli.run(
        "task",
        "status",
        "--task-id",
        "T3",
        "--status",
        "done",
        "--id",
        "developer-full-run",
        "--confidence-pct",
        "88",
        "--hallucination-risk-pct",
        "5",
    )

    cli.run("task", "next", "--role", "code_reviewer", "--id", "reviewer-full-run")
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

    cli.run("task", "next", "--role", "product", "--id", "product-final")
    add_ready_artifact(
        cli,
        state_path,
        "A5",
        "T6",
        "product_strategy",
        "reviews/product-final.md",
        "Product Final Review",
        "product-final",
    )
    cli.run("artifact", "approve", "--artifact-id", "A5", "--id", "user")
    assert_ready_tasks(cli, "architect", ["T7"])

    cli.run("task", "next", "--role", "architect", "--id", "architect-final")
    cli.run(
        "plan",
        "add-task",
        "--task-id",
        "T8",
        "--title",
        "Address final follow-up",
        "--role",
        "developer",
        "--depends-on",
        "T7",
        "--acceptance",
        "Follow-up work is implemented in a new task",
    )
    cli.run(
        "plan",
        "add-task",
        "--task-id",
        "T9",
        "--title",
        "Architect final review follow-up",
        "--role",
        "architect",
        "--depends-on",
        "T8",
        "--acceptance",
        "Second final review follows new follow-up work",
    )
    cli.run(
        "task",
        "log",
        "--task-id",
        "T7",
        "--id",
        "architect-final",
        "--summary",
        "Converted final review gap into follow-up tasks.",
        "--file",
        "swarm/swarm-tool-mcp-server-and-test-harness/reviews/architect-final-review-1.md",
        "--command",
        "swarm plan add-task --task-id T8 ... and swarm plan add-task --task-id T9 ...",
        "--result",
        "Follow-up developer task and later architect final review task created.",
    )
    cli.run("task", "status", "--task-id", "T7", "--status", "done", "--id", "architect-final")

    final_state = read_state(state_path)
    assert_task_status(final_state, "T3", "done")
    assert_task_status(final_state, "T7", "done")
    assert_task_status(final_state, "T8", "todo")
    assert_task_status(final_state, "T9", "todo")
    assert_board_column(final_state, "T8", "ready")
    assert_board_column(final_state, "T9", "todo")
    assert get_task(final_state, "T9")["dependsOn"] == ["T8"]
