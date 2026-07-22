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
    """A published task in its review phase, still owned by its implementer."""
    record = task("T1", "Implement feature", "developer", "review", owner="developer-fixture")
    record["startedAt"] = "2026-07-08T00:00:00Z"
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
            task("T2", "Review feature", "security", "in_progress", owner="reviewer-fixture"),
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


def test_task_log_records_repeatable_sweep_assessments(tmp_path) -> None:
    """A no-phase sweep never calls task.advance, so task.log is its telemetry
    channel: one reviewer assessment per audited task via the review-target trio,
    repeatable within the one sweep task."""
    fixture = create_team(
        tmp_path,
        "sweep-log-feedback",
        [
            task("T1", "Implement feature", "developer", "done", owner="developer-fixture"),
            task("T2", "Implement surface", "frontend", "done", owner="frontend-fixture"),
            task("T3", "QA sweep", "tester", "in_progress", owner="tester-fixture"),
        ],
    )

    first = fixture.cli.run(
        "task",
        "log",
        "--task-id",
        "T3",
        "--id",
        "tester-fixture",
        "--command",
        "npm test",
        "--review-target-task-id",
        "T1",
        "--review-target-agent-id",
        "developer-fixture",
        "--review-target-execution-id",
        "exec_developer_fixture",
        "--claims-checked",
        "5",
        "--missed-requirements",
        "1",
        "--finding-json",
        json.dumps({"kind": "code_bug", "severity": "medium", "area": "backend", "title": "off-by-one"}),
    )
    # Target task id alone suffices: the audited task's implementer resolves
    # from its record (single-owner invariant).
    second = fixture.cli.run(
        "task",
        "log",
        "--task-id",
        "T3",
        "--id",
        "tester-fixture",
        "--review-target-task-id",
        "T2",
        "--claims-checked",
        "4",
    )

    assert first["feedbackRecorded"] is True
    assert second["feedbackRecorded"] is True

    state = read_state(fixture.state_path)
    # Evidence still logs alongside the assessment.
    assert "npm test" in get_task(state, "T3")["evidence"]["commandsRan"]
    # Each assessment lands on the AUDITED task, attributed to its implementer.
    t1_assessment = get_task(state, "T1")["feedbackAssessments"][0]
    assert t1_assessment["source"] == "reviewer_assessment"
    assert t1_assessment["counts"]["missedRequirements"] == 1
    assert t1_assessment["reviewTarget"]["agentId"] == "developer-fixture"
    t2_assessment = get_task(state, "T2")["feedbackAssessments"][0]
    assert t2_assessment["counts"]["claimsChecked"] == 4
    # Implementer resolved from the audited task record, not passed explicitly.
    assert t2_assessment["reviewTarget"]["agentId"] == "frontend-fixture"

    records = read_feedback_records(fixture.team_dir)
    assert len(records) == 2
    assert {record["review_target_task_id"] for record in records} == {"T1", "T2"}
    assert all(record["reviewer_task_id"] == "T3" for record in records)

    # The analysis attributes the measured signals to each implementer.
    from sprintengine_core.analysis import summarize_feedback_records

    by_agent = summarize_feedback_records(records)["aggregateByAgent"]
    dev = by_agent["developer-fixture"]
    assert dev["measured"]["reviewSampleCount"] == 1
    assert dev["measured"]["counts"]["missedRequirements"] == 1
    assert dev["measured"]["findingsAgainst"]["total"] == 1
    sweep_row = by_agent["tester-fixture"]["sweep"]
    assert sweep_row["tasksAudited"] == 2
    assert sweep_row["assessmentsRecorded"] == 2
    # No phase outcome on a task.log assessment: classified from content —
    # defects found reads as fixed-forward, a defect-free audit as clean.
    assert sweep_row["fixedForward"] == 1
    assert sweep_row["passed"] == 1


def test_task_log_feedback_target_failure_degrades_and_keeps_the_evidence(tmp_path) -> None:
    """`task.log` feedback is best-effort telemetry. A review target that names no
    task must NOT abort the whole call: the target failure degrades to a warning
    and the evidence append still lands."""
    fixture = create_team(
        tmp_path,
        "log-target-degrade",
        [task("T3", "QA sweep", "tester", "in_progress", owner="tester-fixture")],
    )

    payload = fixture.cli.run(
        "task",
        "log",
        "--task-id",
        "T3",
        "--id",
        "tester-fixture",
        "--command",
        "npm test",
        "--review-target-task-id",
        "T-does-not-exist",
        "--claims-checked",
        "5",
    )

    # Evidence survived even though the feedback target could not be resolved.
    assert "npm test" in get_task(read_state(fixture.state_path), "T3")["evidence"]["commandsRan"]
    # The failure surfaced as a warning, not a hard error, and nothing was recorded.
    assert payload["feedbackWarnings"]
    assert "feedbackRecorded" not in payload
    assert read_feedback_records(fixture.team_dir) == []


def test_task_log_without_feedback_args_stays_a_plain_evidence_append(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "log-no-feedback",
        [task("T1", "Implement feature", "developer", "in_progress", owner="developer-fixture")],
    )
    payload = fixture.cli.run(
        "task",
        "log",
        "--task-id",
        "T1",
        "--id",
        "developer-fixture",
        "--result",
        "tests passed",
    )
    assert "feedbackRecorded" not in payload
    assert read_feedback_records(fixture.team_dir) == []


def test_phase_advance_records_queryable_feedback_metrics(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "phase-advance-feedback",
        [review_phase_task()],
    )

    payload = fixture.cli.run(
        "task",
        "advance",
        "--task-id",
        "T1",
        "--id",
        "developer-fixture",
        "--phase",
        "review",
        "--outcome",
        "pass",
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
    # The owner reviewed its own work: a self-report, not a reviewer assessment.
    assert "feedbackAssessments" not in reviewed
    feedback = reviewed["feedback"]
    assert feedback["source"] == "phase_advance_self_review"
    assert feedback["phase"] == {"phase": "review", "outcome": "pass"}
    assert feedback["scores"]["correctnessPct"] == 93
    assert feedback["counts"]["claimsChecked"] == 7

    record = assert_feedback_record(fixture.team_dir, "T1", "developer-fixture")
    assert record["source"] == "phase_advance_self_review"
    assert record["task_id"] == "T1"
    assert record["agent_id"] == "developer-fixture"
    assert record["phase"] == "review"
    assert record["phase_outcome"] == "pass"
    assert record["role"] == "developer"
    assert record["scores"]["correctness_pct"] == 93
    assert record["counts"]["claims_checked"] == 7
    # The retired gate keys must not survive under new spellings.
    for retired in ("gate", "gate_phase", "gate_id", "gate_attempt_id", "gate_verdict"):
        assert retired not in record


def test_phase_advance_feedback_is_best_effort_and_never_blocks_the_transition(tmp_path) -> None:
    """Decision 4: a bad telemetry sub-field is dropped with a warning; the
    operational transition still lands. The self-report path is the only one that
    relaxes strict validation."""
    fixture = create_team(tmp_path, "phase-advance-best-effort", [review_phase_task()])

    payload = fixture.cli.run(
        "task",
        "advance",
        "--task-id",
        "T1",
        "--id",
        "developer-fixture",
        "--phase",
        "review",
        "--outcome",
        "pass_with_fixes",
        "--summary",
        "Fixed a null guard.",
        "--finding-json",
        json.dumps({"kind": "code_bug", "severity": "not-a-severity", "area": "backend", "title": "x"}),
    )

    assert payload["nextStatus"] == "done"
    assert payload["feedbackWarnings"]
    assert get_task(read_state(fixture.state_path), "T1")["status"] == "done"


def test_feedback_metrics_include_difficulty_snapshot_when_recorded(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "difficulty-feedback-snapshot",
        [task("T1", "Implement feature", "developer", "in_progress", owner="developer-fixture")],
    )

    payload = fixture.cli.run(
        "task",
        "status",
        "--task-id",
        "T1",
        "--status",
        "done",
        "--id",
        "developer-fixture",
        "--actual-difficulty-pct",
        "64",
        "--actual-difficulty-reason",
        "Touched several state transition paths.",
        "--confidence-pct",
        "91",
    )

    assert payload["feedbackRecorded"] is True
    state = read_state(fixture.state_path)
    assert get_task(state, "T1")["difficulty"] == {
        "implementerActualPct": 64,
        "implementerActualReason": "Touched several state transition paths.",
    }
    record = assert_feedback_record(fixture.team_dir, "T1", "developer-fixture")
    assert record["difficulty"]["implementer_actual_pct"] == 64
    assert record["difficulty"]["implementer_actual_reason"] == "Touched several state transition paths."


def test_reviewer_target_feedback_rejects_missing_target_task(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "reviewer-target-missing",
        [task("T1", "Review feature", "security", "in_progress", owner="reviewer-fixture")],
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


def test_reviewer_target_feedback_requires_target_task_id(tmp_path) -> None:
    # A target agent without a target task is ambiguous: an assessment must name
    # the audited task. (Task id alone is fine — the implementer resolves from
    # the task record.)
    fixture = create_team(
        tmp_path,
        "reviewer-target-partial",
        [
            task("T1", "Implement feature", "developer", "done", owner="developer-fixture"),
            task("T2", "Review feature", "security", "in_progress", owner="reviewer-fixture"),
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

    assert "Reviewer assessments require --review-target-task-id" in rejected.stderr
    state = read_state(fixture.state_path)
    assert "feedbackAssessments" not in get_task(state, "T2")
    assert read_feedback_records(fixture.team_dir) == []


def test_review_target_flags_are_rejected_on_non_done_status(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "reviewer-target-status-gate",
        [task("T1", "Review feature", "security", "todo", owner="reviewer-fixture")],
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


def test_difficulty_percentages_reject_invalid_values(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "difficulty-rejections",
        [task("T1", "Implement feature", "developer", "in_progress", owner="developer-fixture")],
    )

    invalid_actual = fixture.cli.run_failure(
        "task",
        "status",
        "--task-id",
        "T1",
        "--status",
        "done",
        "--id",
        "developer-fixture",
        "--actual-difficulty-pct",
        "101",
    )
    assert "--actual-difficulty-pct must be an integer from 0 to 100" in invalid_actual.stderr

    invalid_bool = fixture.cli.run_failure(
        "task",
        "status",
        "--task-id",
        "T1",
        "--status",
        "done",
        "--id",
        "developer-fixture",
        "--actual-difficulty-pct",
        "true",
    )
    assert "invalid int value" in invalid_bool.stderr

    state = read_state(fixture.state_path)
    assert "difficulty" not in get_task(state, "T1")
    assert read_feedback_records(fixture.team_dir) == []


# --- MC-1755: observed metrics are truthful ---------------------------------


def test_elapsed_ms_measures_in_flight_tasks_from_start_to_now() -> None:
    from sprintengine_core.tool.feedback import elapsed_ms

    in_flight = {"startedAt": "2026-07-22T12:00:00Z", "completedAt": None}
    duration = elapsed_ms(in_flight)
    assert duration is not None and duration > 0, "an in-flight capture still measures a duration"

    completed = {"startedAt": "2026-07-22T12:00:00Z", "completedAt": "2026-07-22T12:10:00Z"}
    assert elapsed_ms(completed) == 10 * 60 * 1000

    assert elapsed_ms({"completedAt": "2026-07-22T12:10:00Z"}) is None


def test_files_touched_count_floors_at_diff_evidence() -> None:
    from sprintengine_core.tool.feedback import observed_task_metrics

    task = {
        "status": "done",
        "evidence": {
            "summary": "",
            "touchedFiles": [],
            "commandsRan": ["npm test"],
            "results": [],
            "diffs": [{"path": "a.ts"}, {"path": "b.ts"}, {"path": "c.ts"}],
        },
    }
    observed = observed_task_metrics(task)
    assert observed["files_touched_count"] == 3, "diff evidence is the observed floor"

    task["evidence"]["touchedFiles"] = ["a.ts", "b.ts", "c.ts", "d.md", "e.md"]
    assert observed_task_metrics(task)["files_touched_count"] == 5, "the explicit log can only add"
