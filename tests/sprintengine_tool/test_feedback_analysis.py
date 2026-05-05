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
            "role": "developer",
            "task_id": "T1",
            "scores": {
                "task_clarity_pct": 62,
                "confidence_pct": 91,
                "hallucination_risk_pct": 41,
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
            "role": "security",
            "task_id": "T2",
            "scores": {"task_clarity_pct": 82, "confidence_pct": 76},
            "top_friction": "permission boundary was unclear",
        },
    ]
    metrics_path.write_text("\n".join(json.dumps(record) for record in records) + "\n", encoding="utf-8")

    summary = summarize_feedback_records(load_feedback_records(metrics_path), state)

    assert summary["source"] == "agent_self_report"
    assert summary["privacy"] == "sanitized_aggregates_only"
    assert summary["aggregateScoresByRole"]["developer"]["task_clarity_pct"]["averagePct"] == 62
    assert summary["lowScoreDimensions"] == [
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
