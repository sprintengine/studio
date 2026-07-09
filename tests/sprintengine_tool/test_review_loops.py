"""The review loops that survive MC-1542: artifacts, and phase-advance telemetry.

Quality gates are gone, and with them the reviewer round-trip through
`changes_requested`. Two review loops remain and are pinned here:

- The ARTIFACT loop. A task that produced artifacts completes only when every
  non-superseded artifact is approved, and `artifact request-changes` reopens
  exactly the linked producer task (a planner/operator action, not a rework
  channel an agent can pull on itself).
- The PHASE loop. The task's own owner closes each phase with `task advance`.
  The verdict telemetry the old gate carried (scores, categorical findings) rides
  the advance instead, and stays best-effort: a malformed optional sub-field is
  dropped with a warning, never allowed to block the operational transition.
"""

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
    read_feedback_records,
    read_state,
    task,
    write_state,
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


def reviewing_task() -> dict:
    """A task its owner has already published: `review`, still owned, mid-walk."""
    record = task("T1", "Implementation under review", "developer", "review", owner="developer-1")
    record["startedAt"] = "2026-07-08T00:00:00Z"
    return record


def reviewing_team(tmp_path, name: str):
    fixture = create_team(tmp_path, name, [reviewing_task()])
    state = read_state(fixture.state_path)
    state["sprintengine"]["rosterConfigured"] = True
    state["agents"] = {"developer-1": {"role": "developer", "status": "idle"}}
    write_state(fixture.state_path, state)
    return fixture


# --- the artifact loop --------------------------------------------------------


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
    write_state(fixture.state_path, state)

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
    # Feedback rides on the comments stream; the planning-notes bag stays clean.
    assert get_task(state, "T2")["notes"] == []
    assert any(
        comment["type"] == "review_feedback"
        and feedback in comment["body"]
        and comment.get("data", {}).get("artifactId") == "A2"
        for comment in get_task(state, "T2")["comments"]
    )
    assert_artifact_status(state, "A2", "changes_requested")


def test_review_artifacts_preserve_recommended_task_metadata(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "review-artifact-metadata",
        [task("T1", "Review implementation", "security", "in_progress", owner="code-reviewer")],
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


# --- the phase loop -----------------------------------------------------------


def test_advance_pass_closes_the_only_phase_and_completes_the_task(tmp_path) -> None:
    fixture = reviewing_team(tmp_path, "advance-pass")

    advanced = fixture.cli.run(
        "task", "advance",
        "--task-id", "T1", "--id", "developer-1",
        "--phase", "review", "--outcome", "pass",
        "--summary", "Self-reviewed the diff; nothing to fix.",
    )

    assert advanced["phase"] == "review"
    assert advanced["outcome"] == "pass"
    assert advanced["nextStatus"] == "done"
    assert "nextPhase" not in advanced
    assert "nextDirective" not in advanced  # nothing left to brief the owner on
    state = read_state(fixture.state_path)
    assert_task_status(state, "T1", "done")
    assert get_task(state, "T1")["ownerAgentId"] is None


def test_advance_records_self_review_feedback_telemetry(tmp_path) -> None:
    """The gate verdict's telemetry moved onto the advance. The owner reports on
    its OWN work, so the record's source says so."""
    fixture = reviewing_team(tmp_path, "advance-telemetry")

    fixture.cli.run(
        "task", "advance",
        "--task-id", "T1", "--id", "developer-1",
        "--phase", "review", "--outcome", "pass_with_fixes",
        "--summary", "Found and fixed a missing null check.",
        "--correctness-pct", "80",
    )

    records = read_feedback_records(fixture.team_dir)
    assert len(records) == 1
    record = records[0]
    assert record["source"] == "phase_advance_self_review"
    assert record["phase"] == "review"
    assert record["phase_outcome"] == "pass_with_fixes"
    assert record["scores"]["correctness_pct"] == 80
    # The gate-shaped record keys are gone with the gates.
    for retired in ("gate_phase", "gate_id", "gate_attempt_id", "gate_verdict"):
        assert retired not in record


def test_advance_best_effort_drops_invalid_telemetry_without_blocking(tmp_path) -> None:
    # Decision 4: a malformed optional telemetry sub-field must not block the
    # operational transition; it is dropped with a warning instead of rejecting.
    fixture = reviewing_team(tmp_path, "advance-best-effort")

    advanced = fixture.cli.run(
        "task", "advance",
        "--task-id", "T1", "--id", "developer-1",
        "--phase", "review", "--outcome", "pass_with_fixes",
        "--summary", "Fixed the missing validation I found.",
        "--correctness-pct", "80",
        "--confidence-pct", "101",
        "--finding-json", json.dumps({"kind": "not-a-kind", "severity": "high", "area": "backend"}),
    )

    # The operational transition still commits.
    assert advanced["nextStatus"] == "done"
    assert read_state(fixture.state_path)["tasks"][0]["status"] == "done"
    # Invalid fields surface as warnings, not failures.
    warnings = advanced.get("feedbackWarnings") or []
    assert any("confidence-pct" in warning for warning in warnings)
    assert any("finding.kind" in warning for warning in warnings)

    records = read_feedback_records(fixture.team_dir)
    assert len(records) == 1
    record = records[0]
    # Valid telemetry is kept; the invalid score and finding are dropped.
    assert record["scores"].get("correctness_pct") == 80
    assert "confidence_pct" not in record["scores"]
    assert "findings" not in record


def test_advance_accepts_categorical_only_finding(tmp_path) -> None:
    # Decision 3: findingJson is categorical-only (kind/area/severity); no prose.
    fixture = reviewing_team(tmp_path, "advance-categorical-finding")

    fixture.cli.run(
        "task", "advance",
        "--task-id", "T1", "--id", "developer-1",
        "--phase", "review", "--outcome", "pass_with_fixes",
        "--summary", "1 a11y finding, fixed.",
        "--finding-json", json.dumps({"kind": "accessibility_issue", "severity": "high", "area": "frontend"}),
    )

    records = read_feedback_records(fixture.team_dir)
    assert len(records) == 1
    findings = records[0]["findings"]
    assert len(findings) == 1
    assert findings[0]["kind"] == "accessibility_issue"
    assert findings[0]["area"] == "frontend"
    assert findings[0]["severity"] == "high"
    # No prose is solicited or required for a categorical-only finding.
    assert findings[0].get("detail") is None
    assert findings[0].get("recommendation") is None


def test_advance_escalate_requires_and_records_needs_input(tmp_path) -> None:
    """The gate `blocked` verdict became `--outcome escalate`: same demand for a
    question, same needs_input landing — but the owner keeps the task."""
    fixture = reviewing_team(tmp_path, "advance-escalate")

    missing = fixture.cli.run_failure(
        "task", "advance",
        "--task-id", "T1", "--id", "developer-1",
        "--phase", "review", "--outcome", "escalate",
        "--summary", "Cannot verify the requirement source.",
    )
    assert "requires a needs-input question" in missing.stderr

    escalated = fixture.cli.run(
        "task", "advance",
        "--task-id", "T1", "--id", "developer-1",
        "--phase", "review", "--outcome", "escalate",
        "--summary", "Cannot verify the requirement source.",
        "--needs-input-kind", "architect",
        "--needs-input-reason", "verification",
        "--needs-input-question", "Which requirements artifact should this validate?",
    )

    assert escalated["nextStatus"] == "needs_input"
    assert escalated["comment"]["type"] == "needs_input"
    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert task_record["status"] == "needs_input"
    assert task_record["needsInput"]["reason"] == "verification"
    # Resolution returns the task to the phase it escalated from, not in_progress.
    assert task_record["needsInput"]["originatingStatus"] == "review"
    # The owner stays bound to its blocked task.
    assert task_record["ownerAgentId"] == "developer-1"


def test_advance_is_rejected_for_a_non_owner(tmp_path) -> None:
    fixture = reviewing_team(tmp_path, "advance-not-owner")

    denied = fixture.cli.run_failure(
        "task", "advance",
        "--task-id", "T1", "--id", "developer-2",
        "--phase", "review", "--outcome", "pass",
        "--summary", "Reviewing someone else's task.",
    )
    assert "not_task_owner" in denied.stderr
    assert read_state(fixture.state_path)["tasks"][0]["status"] == "review"
