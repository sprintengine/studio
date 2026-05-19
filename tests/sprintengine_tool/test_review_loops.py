from __future__ import annotations

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


def gated_review_task() -> dict:
    record = task("T1", "Implementation under review", "developer", "review", owner="developer-fixture")
    record["qualityGates"] = [
        {
            "id": "code-review",
            "phase": "review",
            "role": "code_reviewer",
            "status": "pending",
            "required": True,
            "allowSelfReview": False,
            "focus": "Code quality",
            "attempts": [],
        },
        {
            "id": "spec-review",
            "phase": "review",
            "role": "spec_reviewer",
            "status": "pending",
            "required": True,
            "allowSelfReview": False,
            "focus": "Spec conformance",
            "attempts": [],
        },
        {
            "id": "test",
            "phase": "testing",
            "role": "tester",
            "status": "pending",
            "required": True,
            "allowSelfReview": False,
            "focus": "Validation",
            "attempts": [],
        },
    ]
    return record


def claim_gate(fixture, role: str, agent_id: str) -> dict:
    return fixture.cli.run("task", "gate", "next", "--role", role, "--id", agent_id)


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


def test_gate_approved_verdict_waits_for_parallel_phase_gates_then_advances(tmp_path) -> None:
    fixture = create_team(tmp_path, "gate-approval-routing", [gated_review_task()])
    claim_gate(fixture, "code_reviewer", "code-reviewer")
    claim_gate(fixture, "spec_reviewer", "spec-reviewer")

    first = fixture.cli.run(
        "task",
        "gate",
        "verdict",
        "--task-id",
        "T1",
        "--gate-id",
        "code-review",
        "--role",
        "code_reviewer",
        "--id",
        "code-reviewer",
        "--verdict",
        "approved",
        "--summary",
        "Code review passed.",
    )
    state = read_state(fixture.state_path)
    state["sprintengine"]["status"] = "planned"
    write_state(fixture.state_path, state)
    second = fixture.cli.run(
        "task",
        "gate",
        "verdict",
        "--task-id",
        "T1",
        "--gate-id",
        "spec-review",
        "--role",
        "spec_reviewer",
        "--id",
        "spec-reviewer",
        "--verdict",
        "approved",
        "--summary",
        "Spec review passed.",
    )

    assert first["nextStatus"] == "review"
    assert second["nextStatus"] == "testing"
    state = read_state(fixture.state_path)
    assert state["sprintengine"]["status"] == "executing"
    task_record = get_task(state, "T1")
    assert task_record["status"] == "testing"
    assert [gate["status"] for gate in task_record["qualityGates"][:2]] == ["approved", "approved"]


def test_gate_failed_verdict_creates_open_feedback_and_routes_to_changes_requested(tmp_path) -> None:
    fixture = create_team(tmp_path, "gate-failed-feedback", [gated_review_task()])
    fixture.cli.run("runner", "set", "--mode", "auto")
    claim_gate(fixture, "code_reviewer", "code-reviewer")
    state = read_state(fixture.state_path)
    state["sprintengine"]["status"] = "planned"
    write_state(fixture.state_path, state)

    verdict = fixture.cli.run(
        "task",
        "gate",
        "verdict",
        "--task-id",
        "T1",
        "--gate-id",
        "code-review",
        "--role",
        "code_reviewer",
        "--id",
        "code-reviewer",
        "--verdict",
        "failed",
        "--summary",
        "Validation branch is missing.",
        "--required-action",
        "Add validation before publish.",
    )

    assert verdict["nextStatus"] == "changes_requested"
    assert verdict["nextCommand"] == "sprintengine join --role code_reviewer --id code-reviewer --watch"
    assert "Auto Mode is on" in verdict["nextAction"]
    assert verdict["comment"]["type"] == "review_feedback"
    assert verdict["comment"]["data"]["status"] == "open"
    assert verdict["comment"]["data"]["requiredActions"] == ["Add validation before publish."]
    state = read_state(fixture.state_path)
    assert state["sprintengine"]["status"] == "executing"
    assert_task_status(state, "T1", "changes_requested")
    assert get_task(state, "T1")["qualityGates"][0]["status"] == "changes_requested"


def test_late_parallel_gate_approval_does_not_escape_changes_requested(tmp_path) -> None:
    fixture = create_team(tmp_path, "parallel-approval-after-changes", [gated_review_task()])
    claim_gate(fixture, "code_reviewer", "code-reviewer")
    claim_gate(fixture, "spec_reviewer", "spec-reviewer")

    fixture.cli.run(
        "task",
        "gate",
        "verdict",
        "--task-id",
        "T1",
        "--gate-id",
        "code-review",
        "--role",
        "code_reviewer",
        "--id",
        "code-reviewer",
        "--verdict",
        "changes_requested",
        "--summary",
        "Implementation misses the changes requested route.",
        "--required-action",
        "Keep the task in changes_requested until implementation republishes.",
    )
    approved = fixture.cli.run(
        "task",
        "gate",
        "verdict",
        "--task-id",
        "T1",
        "--gate-id",
        "spec-review",
        "--role",
        "spec_reviewer",
        "--id",
        "spec-reviewer",
        "--verdict",
        "approved",
        "--summary",
        "Spec review passed independently.",
    )

    assert approved["nextStatus"] == "changes_requested"
    state = read_state(fixture.state_path)
    assert_task_status(state, "T1", "changes_requested")
    task_record = get_task(state, "T1")
    assert [gate["status"] for gate in task_record["qualityGates"][:2]] == ["changes_requested", "approved"]


def test_gate_blocked_verdict_requires_and_records_needs_input(tmp_path) -> None:
    fixture = create_team(tmp_path, "gate-blocked-needs-input", [gated_review_task()])
    claim_gate(fixture, "spec_reviewer", "spec-reviewer")

    missing = fixture.cli.run_failure(
        "task",
        "gate",
        "verdict",
        "--task-id",
        "T1",
        "--gate-id",
        "spec-review",
        "--role",
        "spec_reviewer",
        "--id",
        "spec-reviewer",
        "--verdict",
        "blocked",
        "--summary",
        "Cannot verify requirement source.",
    )
    assert "Blocked gate verdicts require --needs-input-question" in missing.stderr

    blocked = fixture.cli.run(
        "task",
        "gate",
        "verdict",
        "--task-id",
        "T1",
        "--gate-id",
        "spec-review",
        "--role",
        "spec_reviewer",
        "--id",
        "spec-reviewer",
        "--verdict",
        "blocked",
        "--summary",
        "Cannot verify requirement source.",
        "--needs-input-kind",
        "architect",
        "--needs-input-reason",
        "verification",
        "--needs-input-question",
        "Which requirements artifact should this gate validate?",
    )

    assert blocked["nextStatus"] == "needs_input"
    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert task_record["status"] == "needs_input"
    assert task_record["needsInput"]["reason"] == "verification"
    assert task_record["qualityGates"][1]["status"] == "blocked"
    assert blocked["comment"]["type"] == "needs_input"


def test_gate_skip_rationale_and_recorded_artifact_do_not_block(tmp_path) -> None:
    fixture = create_team(tmp_path, "gate-skip-recorded-artifact", [gated_review_task()])
    write_team_file(fixture, "reviews/spec.md", "# Spec Review\n")
    claim_gate(fixture, "code_reviewer", "code-reviewer")
    claim_gate(fixture, "spec_reviewer", "spec-reviewer")

    fixture.cli.run(
        "task",
        "gate",
        "verdict",
        "--task-id",
        "T1",
        "--gate-id",
        "code-review",
        "--role",
        "code_reviewer",
        "--id",
        "code-reviewer",
        "--verdict",
        "approved",
        "--summary",
        "Code review passed.",
    )
    skipped = fixture.cli.run(
        "task",
        "gate",
        "verdict",
        "--task-id",
        "T1",
        "--gate-id",
        "spec-review",
        "--role",
        "spec_reviewer",
        "--id",
        "spec-reviewer",
        "--verdict",
        "skipped",
        "--summary",
        "Spec reviewer is redundant for this documented follow-up.",
        "--artifact-path",
        "reviews/spec.md",
        "--artifact-title",
        "Spec review notes",
        "--artifact-kind",
        "spec_review",
    )

    assert skipped["nextStatus"] == "testing"
    assert skipped["artifact"]["status"] == "recorded"
    state = read_state(fixture.state_path)
    artifact = get_artifact(state, skipped["artifact"]["id"])
    assert artifact["status"] == "recorded"
    assert get_task(state, "T1")["qualityGates"][1]["skipRationale"] == "Spec reviewer is redundant for this documented follow-up."
    assert_task_status(state, "T1", "testing")


def test_join_routes_review_roles_to_gate_next_when_only_gate_is_ready(tmp_path) -> None:
    fixture = create_team(tmp_path, "join-gate-directive", [gated_review_task()])

    payload = fixture.cli.run("join", "--role", "code_reviewer", "--id", "code-reviewer")

    assert payload["action"] == "gate_work"
    assert payload["readyGateCount"] == 1
    assert payload["gate"]["id"] == "code-review"
    assert "sprintengine task gate next --role code_reviewer --id code-reviewer" in payload["prompt"]
    assert payload["prompt"].rfind("sprintengine task gate next --role code_reviewer --id code-reviewer") > payload["prompt"].rfind("sprintengine task next --role code_reviewer")
