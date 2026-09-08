"""Feedback record loading and sanitization helpers."""

from __future__ import annotations

import json
from collections.abc import Iterable
from pathlib import Path
from typing import Any


FEEDBACK_ANALYSIS_SCHEMA_VERSION = 2
LOW_SCORE_THRESHOLD_PCT = 70
HIGH_RISK_THRESHOLD_PCT = 30

SCORE_LABELS = {
    "directive_clarity_pct": "Directive clarity",
    "task_clarity_pct": "Task clarity",
    "acceptance_criteria_clarity_pct": "Acceptance criteria clarity",
    "sprintengine_tool_effectiveness_pct": "Sprint Engine tool effectiveness",
    "prompt_optimization_pct": "Prompt optimization",
    "context_fit_pct": "Context fit",
    "hallucination_risk_pct": "Hallucination risk",
    "role_fit_pct": "Role fit",
    "autonomy_pct": "Autonomy",
    "confidence_pct": "Confidence",
    "correctness_pct": "Correctness",
    "evidence_quality_pct": "Evidence quality",
    "instruction_following_pct": "Instruction following",
    "code_quality_pct": "Code quality",
    "maintainability_pct": "Maintainability",
    "test_quality_pct": "Test quality",
    "security_quality_pct": "Security quality",
    "performance_quality_pct": "Performance quality",
    "frontend_functionality_pct": "Frontend functionality",
    "frontend_aesthetic_quality_pct": "Frontend aesthetic quality",
    "accessibility_pct": "Accessibility",
    "ux_competitiveness_pct": "UX competitiveness",
}

PRIVATE_CONTENT_NOTICE = "sanitized_aggregates_only"


def load_feedback_records(path: Path) -> list[dict[str, Any]]:
    """Load JSONL feedback records, ignoring blank lines."""

    if not path.exists():
        return []
    records: list[dict[str, Any]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid feedback JSONL at line {line_number}: {exc.msg}") from exc
        if not isinstance(record, dict):
            raise ValueError(f"Feedback JSONL line {line_number} must be an object.")
        records.append(record)
    return records


def normalize_score(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if value < 0 or value > 100:
        return None
    return value


def normalized_scores(record: dict[str, Any]) -> dict[str, int]:
    raw_scores = record.get("scores")
    if not isinstance(raw_scores, dict):
        return {}
    scores: dict[str, int] = {}
    for key in SCORE_LABELS:
        value = normalize_score(raw_scores.get(key))
        if value is not None:
            scores[key] = value
    return scores


def severity_rank(severity: str) -> int:
    return {
        "critical": 4,
        "high": 3,
        "medium": 2,
        "low": 1,
    }.get(severity, 0)


def highest_severity(values: Iterable[str], default: str = "low") -> str:
    winner = default
    for value in values:
        if severity_rank(value) > severity_rank(winner):
            winner = value
    return winner


def friction_category(text: Any) -> str:
    """Map free-text friction into a coarse category without returning the text."""

    if not isinstance(text, str) or not text.strip():
        return "unspecified"
    lowered = text.lower()
    keyword_groups = [
        ("permissions", ("permission", "access", "auth", "root", "denied")),
        ("tooling", ("tool", "cli", "command", "json", "python", "node", "pytest")),
        ("context", ("context", "missing", "unclear", "ambiguous", "discover")),
        ("validation", ("test", "fixture", "verify", "validation", "failing")),
        ("coordination", ("dependency", "handoff", "blocked", "review", "artifact")),
        ("prompting", ("prompt", "instruction", "directive")),
    ]
    for category, keywords in keyword_groups:
        if any(keyword in lowered for keyword in keywords):
            return category
    return "other"


def recommendation_owner(category: str) -> str:
    return {
        "acceptance_criteria": "product",
        "context": "architect",
        "coordination": "architect",
        "permissions": "security",
        "product_requirement_violation": "product",
        "security_issue": "security",
        "test_gap": "tester",
        "validation": "tester",
        "performance_issue": "performance",
        "tooling": "developer",
        "code_bug": "developer",
        "prompting": "architect",
        "task_card": "architect",
    }.get(category, "architect")


def proposed_change_for_category(category: str) -> str:
    return {
        "acceptance_criteria": "Tighten acceptance criteria with explicit verification evidence.",
        "code_bug": "Create a focused implementation follow-up for the reported defect.",
        "context": "Add the missing context to the plan or task card before more work starts.",
        "coordination": "Clarify ownership, dependency gates, and handoff expectations.",
        "permissions": "Document the required permission boundary and failure behavior.",
        "performance_issue": "Add targeted performance measurement and remediation work.",
        "product_requirement_violation": "Reconcile the implementation with the approved requirement.",
        "security_issue": "Route the issue through security review before release.",
        "task_card": "Rewrite the task card so scope and proof of completion are explicit.",
        "test_gap": "Add regression coverage for the missing scenario.",
        "tooling": "Improve the Sprint Engine tool or harness behavior that caused repeated friction.",
        "validation": "Make validation steps reproducible and visible in task evidence.",
    }.get(category, "Review the grouped feedback and add a scoped follow-up task.")
