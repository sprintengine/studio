from __future__ import annotations

import json

from helpers import (
    assert_artifact_status,
    assert_board_column,
    assert_ready_tasks,
    assert_task_status,
    create_team,
    get_artifact,
    get_task,
    read_state,
    task,
)


def write_team_file(fixture, relative_path: str, content: str = "# Artifact\n") -> None:
    path = fixture.team_dir / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def add_ready_artifact(fixture, artifact_id: str, task_id: str, kind: str, path: str, title: str) -> None:
    write_team_file(fixture, path)
    fixture.cli.run(
        "artifact",
        "add",
        "--actor",
        "producer",
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
        "producer",
        "--ready",
    )


def test_task_completes_only_after_all_non_superseded_artifacts_are_approved(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "multi-artifact-gate",
        [task("T1", "Produce design package", "frontend", "in_progress", owner="frontend-fixture")],
    )

    add_ready_artifact(fixture, "A1", "T1", "html_mockup", "mockup.html", "Mockup")
    add_ready_artifact(fixture, "A2", "T1", "design_notes", "design.md", "Design Notes")
    add_ready_artifact(fixture, "A3", "T1", "branding", "old-branding.md", "Superseded Branding")

    state = read_state(fixture.state_path)
    get_artifact(state, "A3")["status"] = "superseded"
    fixture.state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")

    first = fixture.cli.run("artifact", "approve", "--artifact-id", "A1", "--id", "user")
    assert first["taskCompleted"] is False
    first_state = read_state(fixture.state_path)
    assert_task_status(first_state, "T1", "needs_input")
    assert_artifact_status(first_state, "A1", "approved")
    assert_artifact_status(first_state, "A2", "ready_for_review")

    second = fixture.cli.run("artifact", "approve", "--artifact-id", "A2", "--id", "user")
    assert second["taskCompleted"] is True
    second_state = read_state(fixture.state_path)
    assert_task_status(second_state, "T1", "done")
    assert_artifact_status(second_state, "A3", "superseded")


def test_change_request_requires_feedback_notes_task_and_reopens_only_linked_producer(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "review-loop-linked-producer",
        [
            task("T1", "Product handoff", "product", "done", owner="product-fixture"),
            task("T2", "Frontend mockup", "frontend", "done", owner="frontend-fixture"),
            task("T3", "Implementation", "developer", "todo", depends_on=["T1", "T2"]),
        ],
    )
    add_ready_artifact(fixture, "A1", "T1", "requirements", "requirements.md", "Requirements")
    fixture.cli.run("artifact", "approve", "--artifact-id", "A1", "--id", "user")
    add_ready_artifact(fixture, "A2", "T2", "html_mockup", "mockup.html", "Mockup")
    fixture.cli.run("artifact", "approve", "--artifact-id", "A2", "--id", "user")
    assert_ready_tasks(fixture.cli, "developer", ["T3"])

    missing_feedback = fixture.cli.run_failure("artifact", "request-changes", "--artifact-id", "A2", "--id", "user", "--feedback", " ")
    assert "Change request feedback cannot be empty" in missing_feedback.stderr

    feedback = "Mockup needs a loading state before implementation proceeds."
    requested = fixture.cli.run(
        "artifact",
        "request-changes",
        "--artifact-id",
        "A2",
        "--id",
        "user",
        "--feedback",
        feedback,
    )
    assert requested["reopenedStatus"] == "todo"

    state = read_state(fixture.state_path)
    assert_task_status(state, "T1", "done")
    assert_task_status(state, "T2", "todo")
    assert_task_status(state, "T3", "todo")
    assert_board_column(state, "T3", "todo")
    assert any(feedback in note for note in get_task(state, "T2")["notes"])
    assert_artifact_status(state, "A2", "changes_requested")


def test_review_artifacts_preserve_recommended_task_metadata(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "review-artifact-metadata",
        [task("T1", "Review implementation", "code_reviewer", "in_progress", owner="code-reviewer")],
    )
    write_team_file(fixture, "reviews/code-review.md", "# Code Review\n")

    added = fixture.cli.run(
        "artifact",
        "add",
        "--actor",
        "code-reviewer",
        "--artifact-id",
        "A1",
        "--task-id",
        "T1",
        "--kind",
        "code_review",
        "--title",
        "Code Review",
        "--path",
        "reviews/code-review.md",
        "--created-by",
        "code-reviewer",
        "--recommended-task",
        "Fix missing validation",
        "--recommended-task",
        "Fix missing validation",
        "--recommended-task",
        "Add regression coverage",
        "--ready",
    )

    assert added["artifact"]["kind"] == "code_review"
    assert added["artifact"]["recommendedTasks"] == ["Fix missing validation", "Add regression coverage"]
    assert added["ready"]["taskStatus"] == "needs_input"

    fixture.cli.run("artifact", "approve", "--artifact-id", "A1", "--id", "user")
    state = read_state(fixture.state_path)
    assert_task_status(state, "T1", "done")
    assert get_artifact(state, "A1")["recommendedTasks"] == ["Fix missing validation", "Add regression coverage"]
