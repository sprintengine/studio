from __future__ import annotations

import json

from helpers import (
    assert_feedback_record,
    create_team,
    get_task,
    read_feedback_records,
    read_state,
    task,
)


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
        "file": "tests/swarm_tool/test_feedback_metrics.py",
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
    assert record["findings"][0]["file"] == "tests/swarm_tool/test_feedback_metrics.py"


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
