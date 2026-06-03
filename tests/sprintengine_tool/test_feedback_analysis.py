from __future__ import annotations

import json

from helpers import create_team, task, write_state
from sprintengine_core.analysis import build_recommendations, summarize_feedback_records
from sprintengine_core.feedback import load_feedback_records


PRIVATE_MARKERS = [
    "RAW_PROMPT_SECRET",
    "TRANSCRIPT_SECRET",
    "ARTIFACT_BODY_SECRET",
    "SOURCE_CONTENT_SECRET",
    "TERMINAL_OUTPUT_SECRET",
]


def test_feedback_summary_aggregates_scores_friction_issues_and_findings_without_raw_content(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "analysis",
        [
            task("T1", "Implement backend", "developer", "done"),
            task("T2", "Review security", "security", "done"),
        ],
    )
    state = {
        "sprintengine": {"name": "analysis"},
        "tasks": [
            {
                **task("T1", "Implement backend", "developer", "done"),
                "evidence": {
                    "summary": "TERMINAL_OUTPUT_SECRET",
                    "touchedFiles": ["sprintengine_core/analysis.py"],
                    "commandsRan": ["pytest tests/sprintengine_tool/test_feedback_analysis.py"],
                    "results": ["passed"],
                },
            }
        ],
        "artifacts": [{"id": "A1", "status": "approved", "body": "ARTIFACT_BODY_SECRET"}],
    }
    write_state(fixture.state_path, state)
    metrics_path = fixture.team_dir / "metrics" / "agent-feedback.jsonl"
    metrics_path.parent.mkdir(parents=True, exist_ok=True)
    records = [
        {
            "source": "agent_self_report",
            "role": "developer",
            "task_id": "T1",
            "scores": {
                "task_clarity_pct": 62,
                "confidence_pct": 91,
                "hallucination_risk_pct": 41,
                "correctness_pct": 66,
            },
            "counts": {
                "claims_checked": 8,
                "hallucinated_claims": 2,
            },
            "top_friction": "pytest terminal output included TERMINAL_OUTPUT_SECRET",
            "issues": [
                {
                    "category": "task_card",
                    "severity": "medium",
                    "status": "new",
                    "detail": "prompt copied RAW_PROMPT_SECRET",
                }
            ],
            "findings": [
                {
                    "kind": "test_gap",
                    "severity": "low",
                    "area": "testing",
                    "status": "open",
                    "detail": "transcript copied TRANSCRIPT_SECRET",
                    "file": "SOURCE_CONTENT_SECRET.py",
                }
            ],
        },
        {
            "source": "reviewer_assessment",
            "role": "security",
            "task_id": "T2",
            "scores": {"task_clarity_pct": 82, "confidence_pct": 76},
            "top_friction": "permission boundary was unclear",
        },
    ]
    metrics_path.write_text("\n".join(json.dumps(record) for record in records) + "\n", encoding="utf-8")

    summary = summarize_feedback_records(load_feedback_records(metrics_path), state)

    assert summary["source"] == "agent_feedback"
    assert summary["sourceCounts"] == {"agent_self_report": 1, "reviewer_assessment": 1}
    assert summary["privacy"] == "sanitized_aggregates_only"
    assert summary["aggregateScoresByRole"]["developer"]["task_clarity_pct"]["averagePct"] == 62
    assert summary["aggregateCountsByRole"]["developer"]["claims_checked"] == 8
    assert summary["aggregateCountsByRole"]["developer"]["hallucinated_claims"] == 2
    assert summary["aggregateCountsByRole"]["developer"]["hallucination_rate_pct"] == 25.0
    assert summary["benchmarkRates"] == {
        "claims_checked": 8,
        "claim_hallucination_rate_pct": 25.0,
    }
    assert summary["difficultyAnalytics"] == {}
    assert summary["lowScoreDimensions"] == [
        {
            "role": "developer",
            "dimension": "correctness_pct",
            "label": "Correctness",
            "averagePct": 66.0,
            "sampleCount": 1,
            "thresholdPct": 70,
            "direction": "higher_is_better",
        },
        {
            "role": "developer",
            "dimension": "hallucination_risk_pct",
            "label": "Hallucination risk",
            "averagePct": 41.0,
            "sampleCount": 1,
            "thresholdPct": 30,
            "direction": "lower_is_better",
        },
        {
            "role": "developer",
            "dimension": "task_clarity_pct",
            "label": "Task clarity",
            "averagePct": 62.0,
            "sampleCount": 1,
            "thresholdPct": 70,
            "direction": "higher_is_better",
        },
    ]
    assert summary["groupedFriction"] == [
        {"category": "permissions", "count": 1, "affectedRoles": ["security"]},
        {"category": "tooling", "count": 1, "affectedRoles": ["developer"]},
    ]
    assert summary["issueCounts"]["byCategory"] == {"task_card": 1}
    assert summary["findingCounts"]["byKind"] == {"test_gap": 1}
    assert summary["objectiveEvidence"]["commandEvidenceCount"] == 1
    assert summary["objectiveEvidence"]["approvedArtifactCount"] == 1

    encoded = json.dumps(summary, sort_keys=True)
    for marker in PRIVATE_MARKERS:
        assert marker not in encoded


def test_feedback_summary_reports_benchmark_rates_and_difficulty_analytics() -> None:
    records = [
        {
            "source": "agent_self_report",
            "role": "developer",
            "task_id": "T1",
            "counts": {
                "claims_checked": 10,
                "hallucinated_claims": 1,
                "factual_errors": 2,
                "missed_requirements": 3,
                "implementation_mistakes": 4,
                "regression_count": 1,
                "unsafe_changes": 0,
            },
            "difficulty": {
                "architect_estimate_pct": 70,
                "implementer_actual_pct": 60,
                "reviewer_assessments": [
                    {
                        "pct": 80,
                        "dimension": "implementation",
                        "reviewer_agent_id": "code-reviewer",
                        "reviewer_role": "code_reviewer",
                        "gate_id": "code_reviewer",
                        "gate_attempt_id": "GA-001",
                    },
                    {
                        "pct": 60,
                        "dimension": "implementation",
                        "reviewer_agent_id": "architect",
                        "reviewer_role": "architect",
                        "gate_id": "architect_review",
                        "gate_attempt_id": "GA-001",
                    },
                ],
            },
        },
        {
            "source": "reviewer_assessment",
            "role": "developer",
            "task_id": "T2",
            "counts": {
                "claims_checked": 5,
                "hallucinated_claims": 0,
                "factual_errors": 1,
                "missed_requirements": 0,
                "implementation_mistakes": 1,
                "regression_count": 2,
                "unsafe_changes": 1,
            },
            "difficulty": {
                "architect_estimate_pct": 40,
                "implementer_actual_pct": 50,
                "reviewer_assessments": [
                    {
                        "pct": 55,
                        "dimension": "review",
                        "reviewer_agent_id": "spec-reviewer",
                        "reviewer_role": "spec_reviewer",
                        "gate_id": "spec_reviewer",
                        "gate_attempt_id": "GA-001",
                    }
                ],
            },
        },
    ]

    summary = summarize_feedback_records(records)

    assert summary["benchmarkRates"] == {
        "claims_checked": 15,
        "claim_hallucination_rate_pct": 6.7,
        "factual_error_rate_pct": 20.0,
        "missed_requirement_rate_pct": 20.0,
        "implementation_mistake_rate_pct": 33.3,
        "regression_rate_pct": 20.0,
        "unsafe_change_rate_pct": 6.7,
    }
    assert summary["difficultyAnalytics"]["architect"] == {
        "sampleCount": 2,
        "mean_absolute_error_pct": 10.0,
        "bias_pct": 0.0,
    }
    reviewer = summary["difficultyAnalytics"]["reviewer"]
    assert reviewer["sampleCount"] == 3
    assert reviewer["mean_difficulty_pct"] == 65.0
    assert reviewer["byDimension"]["implementation"] == {"sampleCount": 2, "mean_difficulty_pct": 70.0}
    assert reviewer["byTaskRole"]["developer"] == {"sampleCount": 3, "mean_difficulty_pct": 65.0}
    assert reviewer["byGateRole"]["code_reviewer"] == {"sampleCount": 1, "mean_difficulty_pct": 80.0}
    assert reviewer["disagreement"] == {"sampleCount": 1, "mean_range_pct": 20.0, "max_range_pct": 20}


def test_feedback_summary_deduplicates_cumulative_difficulty_snapshots() -> None:
    first_snapshot = {
        "architect_estimate_pct": 70,
        "implementer_actual_pct": 60,
        "reviewer_assessments": [
            {
                "pct": 80,
                "dimension": "implementation",
                "reviewer_agent_id": "architect",
                "reviewer_role": "architect",
                "gate_id": "architect_review",
                "gate_attempt_id": "GA-001",
            }
        ],
    }
    cumulative_snapshot = {
        **first_snapshot,
        "reviewer_assessments": [
            *first_snapshot["reviewer_assessments"],
            {
                "pct": 60,
                "dimension": "implementation",
                "reviewer_agent_id": "code-reviewer",
                "reviewer_role": "code_reviewer",
                "gate_id": "code_reviewer",
                "gate_attempt_id": "GA-001",
            },
        ],
    }

    summary = summarize_feedback_records(
        [
            {"role": "developer", "task_id": "T1", "difficulty": first_snapshot},
            {"role": "developer", "task_id": "T1", "difficulty": cumulative_snapshot},
        ]
    )

    assert summary["difficultyAnalytics"]["architect"] == {
        "sampleCount": 1,
        "mean_absolute_error_pct": 10.0,
        "bias_pct": 10.0,
    }
    reviewer = summary["difficultyAnalytics"]["reviewer"]
    assert reviewer["sampleCount"] == 2
    assert reviewer["mean_difficulty_pct"] == 70.0
    assert reviewer["byReviewerRole"] == {
        "architect": {"sampleCount": 1, "mean_difficulty_pct": 80.0},
        "code_reviewer": {"sampleCount": 1, "mean_difficulty_pct": 60.0},
    }
    assert reviewer["disagreement"] == {"sampleCount": 1, "mean_range_pct": 20.0, "max_range_pct": 20}


def test_feedback_summary_omits_rates_when_denominator_is_zero_and_ignores_partial_difficulty() -> None:
    summary = summarize_feedback_records(
        [
            {
                "role": "developer",
                "counts": {
                    "claims_checked": 0,
                    "hallucinated_claims": 2,
                    "factual_errors": 1,
                },
                "difficulty": {
                    "architect_estimate_pct": 40,
                    "reviewer_assessments": [{"pct": 51, "dimension": "review"}],
                },
            },
            {
                "role": "tester",
                "counts": {"claims_checked": True, "unsafe_changes": False},
                "difficulty": {"reviewer_assessments": [{"pct": True, "dimension": "review"}]},
            },
            {"role": "legacy", "scores": {"confidence_pct": 90}},
        ]
    )

    assert summary["benchmarkRates"] == {}
    assert "hallucination_rate_pct" not in summary["aggregateCountsByRole"]["developer"]
    assert "architect" not in summary["difficultyAnalytics"]
    assert summary["difficultyAnalytics"]["reviewer"]["sampleCount"] == 1
    assert summary["difficultyAnalytics"]["reviewer"]["mean_difficulty_pct"] == 51.0


def test_feedback_summary_handles_empty_records() -> None:
    summary = summarize_feedback_records([])

    assert summary["schemaVersion"] == 2
    assert summary["feedbackRecordCount"] == 0
    assert summary["benchmarkRates"] == {}
    assert summary["difficultyAnalytics"] == {}
    assert summary["aggregateCountsByRole"] == {}


def test_feedback_recommendations_include_actionable_ownership_fields_without_raw_content() -> None:
    summary = {
        "lowScoreDimensions": [
            {
                "role": "developer",
                "dimension": "task_clarity_pct",
                "sampleCount": 2,
            }
        ],
        "groupedFriction": [
            {"category": "tooling", "count": 3, "affectedRoles": ["developer", "tester"]}
        ],
        "issueCounts": {
            "byCategory": {"acceptance_criteria": 1},
            "bySeverity": {"high": 1},
        },
        "findingCounts": {
            "byKind": {"security_issue": 1},
            "bySeverity": {"critical": 1},
        },
    }

    recommendations = build_recommendations(summary)

    assert {
        "category",
        "severity",
        "evidenceCount",
        "affectedRoles",
        "suggestedOwner",
        "proposedChange",
    } <= set(recommendations[0])
    assert any(item["category"] == "tooling" and item["suggestedOwner"] == "developer" for item in recommendations)
    assert any(item["category"] == "security_issue" and item["suggestedOwner"] == "security" for item in recommendations)
    encoded = json.dumps(recommendations, sort_keys=True)
    assert "RAW_PROMPT_SECRET" not in encoded


def test_aggregate_by_agent_attributes_measured_signals_to_the_implementer() -> None:
    # Worker self-reports its own confidence + hallucination-risk guess.
    # A reviewer logs measured defects against the worker's task; those must
    # land on the implementer (developer-1), never on the reviewer who logged
    # them. The reviewer only accrues findingsRaised.
    records = [
        {
            "source": "agent_self_report",
            "agent_id": "developer-1",
            "role": "developer",
            "task_id": "T1",
            "scores": {"confidence_pct": 90, "hallucination_risk_pct": 10},
        },
        {
            "source": "agent_self_report",
            "agent_id": "developer-1",
            "role": "developer",
            "task_id": "T2",
            "scores": {"confidence_pct": 70, "hallucination_risk_pct": 30},
        },
        {
            "source": "reviewer_assessment",
            "agent_id": "code_reviewer-1",
            "role": "developer",
            "task_id": "T1",
            "review_target_agent_id": "developer-1",
            "reviewer_agent_id": "code_reviewer-1",
            "reviewer_role": "code_reviewer",
            "scores": {"correctness_pct": 60, "code_quality_pct": 55},
            "counts": {
                "claims_checked": 10,
                "hallucinated_claims": 3,
                "regression_count": 1,
                "missed_requirements": 2,
            },
            "findings": [
                {"kind": "code_bug", "severity": "high", "area": "backend"},
                {"kind": "code_bug", "severity": "low", "area": "backend"},
            ],
        },
    ]

    summary = summarize_feedback_records(records)
    by_agent = summary["aggregateByAgent"]

    assert set(by_agent) == {"developer-1", "code_reviewer-1"}

    dev = by_agent["developer-1"]
    assert dev["role"] == "developer"
    # Self-reported: averaged across the worker's own two records.
    assert dev["selfReported"]["sampleCount"] == 2
    assert dev["selfReported"]["scores"]["confidence_pct"]["averagePct"] == 80.0
    assert dev["selfReported"]["scores"]["hallucination_risk_pct"]["averagePct"] == 20.0
    # Measured: attributed to the implementer, not the reviewer.
    measured = dev["measured"]
    assert measured["reviewSampleCount"] == 1
    assert measured["counts"]["regressionCount"] == 1
    assert measured["counts"]["missedRequirements"] == 2
    assert measured["hallucinationRatePct"] == 30.0  # 3 / 10
    assert measured["findingsAgainst"]["total"] == 2
    assert measured["findingsAgainst"]["bySeverity"] == {"high": 1, "low": 1}
    assert measured["scores"]["correctness_pct"]["averagePct"] == 60.0
    # The worker authored no review findings.
    assert dev["findingsRaised"] == 0

    reviewer = by_agent["code_reviewer-1"]
    # The reviewer accrues no self-report and no measured-against-its-work data,
    # only the findings it raised while reviewing.
    assert reviewer["selfReported"]["sampleCount"] == 0
    assert reviewer["measured"]["reviewSampleCount"] == 0
    assert "findingsAgainst" not in reviewer["measured"]
    assert "hallucinationRatePct" not in reviewer["measured"]
    assert reviewer["findingsRaised"] == 2


def test_aggregate_by_agent_distinguishes_no_review_data_from_zero_defects() -> None:
    # A reviewer checked the work and found nothing wrong: counts are absent but
    # a review happened, so measured columns should read as present-with-zero,
    # not "no data".
    records = [
        {
            "source": "reviewer_assessment",
            "agent_id": "tester-1",
            "role": "frontend",
            "task_id": "T9",
            "review_target_agent_id": "frontend-1",
            "scores": {"correctness_pct": 95},
            "counts": {"claims_checked": 4, "hallucinated_claims": 0},
        }
    ]

    by_agent = summarize_feedback_records(records)["aggregateByAgent"]
    measured = by_agent["frontend-1"]["measured"]
    assert measured["reviewSampleCount"] == 1
    # claims were checked, none hallucinated → a real measured 0% rate.
    assert measured["hallucinationRatePct"] == 0.0
    # no defect findings recorded → findingsAgainst omitted (renderer shows 0
    # because reviewSampleCount > 0).
    assert "findingsAgainst" not in measured


def test_aggregate_by_agent_handles_empty_records() -> None:
    assert summarize_feedback_records([])["aggregateByAgent"] == {}


def test_aggregate_by_agent_emits_per_task_counts_for_drilldown() -> None:
    records = [
        {
            "source": "gate_verdict_assessment",
            "agent_id": "code_reviewer-1",
            "role": "developer",
            "task_id": "T7",
            "review_target_task_id": "T7",
            "review_target_agent_id": "developer-1",
            "counts": {"claims_checked": 60, "implementation_mistakes": 2, "missed_requirements": 1},
        },
        {
            "source": "gate_verdict_assessment",
            "agent_id": "tester-1",
            "role": "developer",
            "task_id": "T7",
            "review_target_task_id": "T7",
            "review_target_agent_id": "developer-1",
            "counts": {"claims_checked": 50, "missed_requirements": 1},
        },
        {
            "source": "gate_verdict_assessment",
            "agent_id": "spec_reviewer-1",
            "role": "developer",
            "task_id": "T2",
            "review_target_task_id": "T2",
            "review_target_agent_id": "developer-1",
            "counts": {"claims_checked": 30},
        },
    ]

    measured = summarize_feedback_records(records)["aggregateByAgent"]["developer-1"]["measured"]
    task_counts = measured["taskCounts"]

    # Two reviewers looked at T7; their counts sum.
    assert task_counts["T7"]["reviewSampleCount"] == 2
    assert task_counts["T7"]["counts"] == {"implementationMistakes": 2, "missedRequirements": 2}
    # T2 was reviewed once with no defects → present-with-zero (empty counts, not absent).
    assert task_counts["T2"]["reviewSampleCount"] == 1
    assert task_counts["T2"]["counts"] == {}


def test_aggregate_by_agent_emits_reviewer_activity() -> None:
    records = [
        {
            "source": "gate_verdict_assessment", "agent_id": "code_reviewer-1", "role": "developer",
            "task_id": "T1", "review_target_task_id": "T1", "review_target_agent_id": "developer-1",
            "reviewer_agent_id": "code_reviewer-1", "gate_verdict": "changes_requested",
        },
        {
            "source": "gate_verdict_assessment", "agent_id": "code_reviewer-1", "role": "developer",
            "task_id": "T2", "review_target_task_id": "T2", "review_target_agent_id": "developer-1",
            "reviewer_agent_id": "code_reviewer-1", "gate_verdict": "approved",
        },
        {
            "source": "gate_verdict_assessment", "agent_id": "code_reviewer-1", "role": "developer",
            "task_id": "T1", "review_target_task_id": "T1", "review_target_agent_id": "developer-1",
            "reviewer_agent_id": "code_reviewer-1", "gate_verdict": "approved",
        },
    ]
    reviewer = summarize_feedback_records(records)["aggregateByAgent"]["code_reviewer-1"]["reviewer"]
    assert reviewer["reviewsPerformed"] == 3
    assert reviewer["tasksReviewed"] == 2  # T1, T2
    assert reviewer["approved"] == 2
    assert reviewer["changesRequested"] == 1
    assert reviewer["blocked"] == 0
