from __future__ import annotations

import json

from helpers import (
    assert_feedback_record,
    create_team,
    get_task,
    read_state,
    read_feedback_records,
    task,
)


def review_phase_task() -> dict:
    record = task("T1", "Implement gated feature", "developer", "review", owner="developer-fixture")
    record["qualityGates"] = [
        {
            "id": "code_reviewer",
            "phase": "review",
            "role": "code_reviewer",
            "status": "pending",
            "required": True,
            "allowSelfReview": False,
            "focus": "code quality",
            "attempts": [],
        }
    ]
    return record


def test_done_status_records_feedback_scores_issues_findings_and_metrics_jsonl(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "feedback-metrics",
        [task("T1", "Implement feature", "developer", "in_progress", owner="developer-fixture")],
    )
    issue = {
        "category": "task_card",
        "severity": "medium",
        "title": "Acceptance gap",
        "detail": "The task did not state which command proves completion.",
        "target": "T1",
        "suggestedProcessChange": "Include one focused verification command.",
    }
    finding = {
        "kind": "test_gap",
        "severity": "low",
        "area": "testing",
        "title": "Missing edge case",
        "detail": "The suite needs a negative-path assertion.",
        "recommendation": "Add the rejection case.",
        "file": "tests/sprintengine_tool/test_feedback_metrics.py",
    }

    payload = fixture.cli.run(
        "task",
        "status",
        "--task-id",
        "T1",
        "--status",
        "done",
        "--id",
        "developer-fixture",
        "--confidence-pct",
        "91",
        "--hallucination-risk-pct",
        "7",
        "--top-friction",
        "Fixture setup was the slowest part.",
        "--suggested-improvement",
        "Document feedback JSON examples in task prompts.",
        "--issue-json",
        json.dumps(issue),
        "--finding-json",
        json.dumps(finding),
    )
    assert payload["feedbackRecorded"] is True

    state = read_state(fixture.state_path)
    feedback = get_task(state, "T1")["feedback"]
    assert feedback["scores"]["confidencePct"] == 91
    assert feedback["scores"]["hallucinationRiskPct"] == 7
    assert feedback["issues"][0]["id"] == "T1-I1"
    assert feedback["issues"][0]["status"] == "new"
    assert feedback["findings"][0]["id"] == "T1-F1"
    assert feedback["findings"][0]["status"] == "open"

    record = assert_feedback_record(fixture.team_dir, "T1", "developer-fixture")
    assert record["scores"] == {"confidence_pct": 91, "hallucination_risk_pct": 7}
    assert record["top_friction"] == "Fixture setup was the slowest part."
    assert record["issues"][0]["suggested_process_change"] == "Include one focused verification command."
    assert record["findings"][0]["file"] == "tests/sprintengine_tool/test_feedback_metrics.py"


def test_artifact_ready_records_feedback_metrics_for_artifact_producer(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "artifact-ready-feedback",
        [task("T1", "Produce validation report", "tester", "in_progress", owner="tester-fixture")],
    )
    report_path = fixture.team_dir / "reports" / "validation.md"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text("# Validation\n", encoding="utf-8")

    fixture.cli.run(
        "artifact",
        "add",
        "--actor",
        "tester-fixture",
        "--artifact-id",
        "A1",
        "--task-id",
        "T1",
        "--kind",
        "validation_report",
        "--title",
        "Validation Report",
        "--path",
        "reports/validation.md",
        "--created-by",
        "tester-fixture",
    )
    payload = fixture.cli.run(
        "artifact",
        "ready",
        "--artifact-id",
        "A1",
        "--id",
        "tester-fixture",
        "--task-clarity-pct",
        "88",
        "--issue-json",
        json.dumps({
            "category": "validation",
            "severity": "low",
            "title": "Manual step",
            "detail": "One check still needed a manual fixture.",
        }),
    )

    assert payload["feedbackRecorded"] is True
    records = read_feedback_records(fixture.team_dir)
    assert len(records) == 1
    assert records[0]["task_id"] == "T1"
    assert records[0]["scores"] == {"task_clarity_pct": 88}


def test_done_status_records_reviewer_target_feedback_on_reviewed_task(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "reviewer-target-feedback",
        [
            task("T1", "Implement feature", "developer", "done", owner="developer-fixture"),
            task("T2", "Review feature", "code_reviewer", "in_progress", owner="reviewer-fixture"),
        ],
    )

    payload = fixture.cli.run(
        "task",
        "status",
        "--task-id",
        "T2",
        "--status",
        "done",
        "--id",
        "reviewer-fixture",
        "--review-target-task-id",
        "T1",
        "--review-target-agent-id",
        "developer-fixture",
        "--review-target-execution-id",
        "exec_developer_fixture",
        "--correctness-pct",
        "84",
        "--evidence-quality-pct",
        "72",
        "--claims-checked",
        "12",
        "--hallucinated-claims",
        "3",
        "--implementation-mistakes",
        "2",
        "--top-friction",
        "Evidence was missing one command.",
    )

    assert payload["feedbackRecorded"] is True
    state = read_state(fixture.state_path)
    reviewed = get_task(state, "T1")
    reviewer = get_task(state, "T2")
    assessment = reviewed["feedbackAssessments"][0]
    assert "feedback" not in reviewed
    assert reviewer["status"] == "done"
    assert assessment["source"] == "reviewer_assessment"
    assert assessment["scores"]["correctnessPct"] == 84
    assert assessment["counts"]["claimsChecked"] == 12
    assert assessment["reviewTarget"] == {
        "taskId": "T1",
        "agentId": "developer-fixture",
        "executionId": "exec_developer_fixture",
    }
    assert assessment["reviewer"]["taskId"] == "T2"

    record = assert_feedback_record(fixture.team_dir, "T1", "reviewer-fixture")
    assert record["source"] == "reviewer_assessment"
    assert record["review_target_task_id"] == "T1"
    assert record["reviewer_task_id"] == "T2"
    assert record["counts"]["claims_checked"] == 12
    assert "hallucination_pct" not in record


def test_gate_verdict_records_queryable_feedback_metrics(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "gate-verdict-feedback",
        [review_phase_task()],
    )
    fixture.cli.run("task", "gate", "next", "--role", "code_reviewer", "--id", "reviewer-fixture")

    payload = fixture.cli.run(
        "task",
        "gate",
        "verdict",
        "--task-id",
        "T1",
        "--gate-id",
        "code_reviewer",
        "--role",
        "code_reviewer",
        "--id",
        "reviewer-fixture",
        "--verdict",
        "approved",
        "--summary",
        "Implementation is correct.",
        "--correctness-pct",
        "93",
        "--evidence-quality-pct",
        "89",
        "--claims-checked",
        "7",
        "--top-friction",
        "Evidence was concise.",
    )

    assert payload["feedbackRecorded"] is True
    state = read_state(fixture.state_path)
    reviewed = get_task(state, "T1")
    assessment = reviewed["feedbackAssessments"][0]
    assert assessment["source"] == "gate_verdict_assessment"
    assert assessment["gate"] == {
        "phase": "review",
        "gateId": "code_reviewer",
        "attemptId": "GA-001",
        "verdict": "approved",
    }
    assert assessment["scores"]["correctnessPct"] == 93
    assert assessment["counts"]["claimsChecked"] == 7

    record = assert_feedback_record(fixture.team_dir, "T1", "reviewer-fixture")
    assert record["source"] == "gate_verdict_assessment"
    assert record["task_id"] == "T1"
    assert record["agent_id"] == "reviewer-fixture"
    assert record["gate_phase"] == "review"
    assert record["gate_id"] == "code_reviewer"
    assert record["gate_attempt_id"] == "GA-001"
    assert record["gate_verdict"] == "approved"
    assert record["reviewer_role"] == "code_reviewer"
    assert record["scores"]["correctness_pct"] == 93
    assert record["counts"]["claims_checked"] == 7


def test_reviewer_target_feedback_rejects_missing_target_task(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "reviewer-target-missing",
        [task("T1", "Review feature", "code_reviewer", "in_progress", owner="reviewer-fixture")],
    )

    rejected = fixture.cli.run_failure(
        "task",
        "status",
        "--task-id",
        "T1",
        "--status",
        "done",
        "--id",
        "reviewer-fixture",
        "--review-target-task-id",
        "missing",
        "--review-target-agent-id",
        "developer-fixture",
        "--review-target-execution-id",
        "exec_missing",
        "--correctness-pct",
        "80",
    )

    assert "Task not found: missing" in rejected.stderr
    assert read_feedback_records(fixture.team_dir) == []


def test_reviewer_target_feedback_requires_complete_target_metadata(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "reviewer-target-partial",
        [
            task("T1", "Implement feature", "developer", "done", owner="developer-fixture"),
            task("T2", "Review feature", "code_reviewer", "in_progress", owner="reviewer-fixture"),
        ],
    )

    rejected = fixture.cli.run_failure(
        "task",
        "status",
        "--task-id",
        "T2",
        "--status",
        "done",
        "--id",
        "reviewer-fixture",
        "--review-target-agent-id",
        "developer-fixture",
        "--correctness-pct",
        "80",
    )

    assert "Reviewer assessments require all review target fields" in rejected.stderr
    state = read_state(fixture.state_path)
    assert "feedbackAssessments" not in get_task(state, "T2")
    assert read_feedback_records(fixture.team_dir) == []


def test_review_target_flags_are_rejected_on_non_done_status(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "reviewer-target-status-gate",
        [task("T1", "Review feature", "code_reviewer", "todo", owner="reviewer-fixture")],
    )

    rejected = fixture.cli.run_failure(
        "task",
        "status",
        "--task-id",
        "T1",
        "--status",
        "in_progress",
        "--id",
        "reviewer-fixture",
        "--review-target-task-id",
        "T2",
    )

    assert "Feedback flags on `sprintengine task status` are only supported with --status done" in rejected.stderr
    assert read_feedback_records(fixture.team_dir) == []


def test_feedback_rejects_invalid_percentages_and_malformed_json(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "feedback-rejections",
        [task("T1", "Implement feature", "developer", "in_progress", owner="developer-fixture")],
    )

    invalid_percent = fixture.cli.run_failure(
        "task",
        "status",
        "--task-id",
        "T1",
        "--status",
        "done",
        "--id",
        "developer-fixture",
        "--confidence-pct",
        "101",
    )
    assert "--confidence-pct must be an integer from 0 to 100" in invalid_percent.stderr

    malformed_issue = fixture.cli.run_failure(
        "task",
        "status",
        "--task-id",
        "T1",
        "--status",
        "done",
        "--id",
        "developer-fixture",
        "--issue-json",
        "{not-json",
    )
    assert "--issue-json must be valid JSON" in malformed_issue.stderr

    malformed_finding = fixture.cli.run_failure(
        "task",
        "status",
        "--task-id",
        "T1",
        "--status",
        "done",
        "--id",
        "developer-fixture",
        "--finding-json",
        json.dumps({"kind": "not-a-kind"}),
    )
    assert "finding.kind must be one of" in malformed_finding.stderr

    state = read_state(fixture.state_path)
    assert get_task(state, "T1")["status"] == "in_progress"
    assert read_feedback_records(fixture.team_dir) == []
