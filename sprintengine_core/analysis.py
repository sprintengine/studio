"""Sanitized feedback analysis for swarm runs."""

from __future__ import annotations

from collections import defaultdict
from pathlib import Path
from typing import Any

from .feedback import (
    FEEDBACK_ANALYSIS_SCHEMA_VERSION,
    HIGH_RISK_THRESHOLD_PCT,
    LOW_SCORE_THRESHOLD_PCT,
    PRIVATE_CONTENT_NOTICE,
    SCORE_LABELS,
    friction_category,
    highest_severity,
    load_feedback_records,
    normalized_scores,
    proposed_change_for_category,
    recommendation_owner,
)


def summarize_feedback_records(
    records: list[dict[str, Any]],
    state: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Summarize agent self-report feedback without emitting raw private content."""

    score_values: dict[str, dict[str, list[int]]] = defaultdict(lambda: defaultdict(list))
    friction: dict[str, dict[str, Any]] = {}
    issue_counts = _empty_issue_counts()
    finding_counts = _empty_finding_counts()

    for record in records:
        role = str(record.get("role") or "unknown")
        for score_key, score in normalized_scores(record).items():
            score_values[role][score_key].append(score)

        category = friction_category(record.get("top_friction"))
        if category != "unspecified":
            entry = friction.setdefault(category, {"category": category, "count": 0, "affectedRoles": set()})
            entry["count"] += 1
            entry["affectedRoles"].add(role)

        _count_issues(record.get("issues"), issue_counts, role)
        _count_findings(record.get("findings"), finding_counts, role)

    aggregate_scores = _aggregate_scores_by_role(score_values)
    _finalize_affected_roles(issue_counts, "affectedRolesByCategory")
    _finalize_affected_roles(finding_counts, "affectedRolesByKind")
    summary = {
        "schemaVersion": FEEDBACK_ANALYSIS_SCHEMA_VERSION,
        "source": "agent_self_report",
        "privacy": PRIVATE_CONTENT_NOTICE,
        "feedbackRecordCount": len(records),
        "aggregateScoresByRole": aggregate_scores,
        "lowScoreDimensions": _low_score_dimensions(aggregate_scores),
        "groupedFriction": _finalize_grouped_friction(friction),
        "issueCounts": issue_counts,
        "findingCounts": finding_counts,
        "objectiveEvidence": _objective_evidence(state or {}),
        "note": "Feedback is subjective agent self-report and should be interpreted alongside objective task, artifact, and test evidence.",
    }
    return summary


def analyze_feedback_metrics(team_dir: Path, state: dict[str, Any] | None = None) -> dict[str, Any]:
    records = load_feedback_records(team_dir / "metrics" / "agent-feedback.jsonl")
    summary = summarize_feedback_records(records, state)
    return {
        "summary": summary,
        "recommendations": build_recommendations(summary),
    }


def build_recommendations(summary: dict[str, Any]) -> list[dict[str, Any]]:
    recommendations: list[dict[str, Any]] = []

    for dimension in summary.get("lowScoreDimensions", []):
        category = _dimension_category(str(dimension.get("dimension") or ""))
        recommendations.append({
            "category": category,
            "severity": "medium" if dimension.get("sampleCount", 0) < 3 else "high",
            "evidenceCount": int(dimension.get("sampleCount") or 0),
            "affectedRoles": [dimension.get("role")],
            "suggestedOwner": recommendation_owner(category),
            "proposedChange": proposed_change_for_category(category),
        })

    for friction in summary.get("groupedFriction", []):
        category = str(friction.get("category") or "other")
        recommendations.append({
            "category": category,
            "severity": "medium" if int(friction.get("count") or 0) >= 2 else "low",
            "evidenceCount": int(friction.get("count") or 0),
            "affectedRoles": list(friction.get("affectedRoles") or []),
            "suggestedOwner": recommendation_owner(category),
            "proposedChange": proposed_change_for_category(category),
        })

    _add_count_recommendations(recommendations, summary.get("issueCounts", {}), "byCategory")
    _add_count_recommendations(recommendations, summary.get("findingCounts", {}), "byKind")

    return _dedupe_recommendations(recommendations)


def _empty_issue_counts() -> dict[str, Any]:
    return {"total": 0, "byCategory": {}, "bySeverity": {}, "byStatus": {}, "affectedRolesByCategory": {}}


def _empty_finding_counts() -> dict[str, Any]:
    return {"total": 0, "byKind": {}, "bySeverity": {}, "byArea": {}, "byStatus": {}, "affectedRolesByKind": {}}


def _increment(mapping: dict[str, int], key: Any) -> None:
    label = str(key or "unspecified")
    mapping[label] = mapping.get(label, 0) + 1


def _add_role(mapping: dict[str, set[str]], key: Any, role: str) -> None:
    label = str(key or "unspecified")
    mapping.setdefault(label, set()).add(role)


def _finalize_affected_roles(counts: dict[str, Any], key: str) -> None:
    raw = counts.get(key)
    if not isinstance(raw, dict):
        counts[key] = {}
        return
    counts[key] = {
        category: sorted(roles)
        for category, roles in raw.items()
        if isinstance(roles, set)
    }


def _count_issues(raw_issues: Any, counts: dict[str, Any], role: str) -> None:
    if not isinstance(raw_issues, list):
        return
    for issue in raw_issues:
        if not isinstance(issue, dict):
            continue
        category = issue.get("category")
        counts["total"] += 1
        _increment(counts["byCategory"], category)
        _increment(counts["bySeverity"], issue.get("severity"))
        _increment(counts["byStatus"], issue.get("status"))
        _add_role(counts["affectedRolesByCategory"], category, role)


def _count_findings(raw_findings: Any, counts: dict[str, Any], role: str) -> None:
    if not isinstance(raw_findings, list):
        return
    for finding in raw_findings:
        if not isinstance(finding, dict):
            continue
        kind = finding.get("kind")
        counts["total"] += 1
        _increment(counts["byKind"], kind)
        _increment(counts["bySeverity"], finding.get("severity"))
        _increment(counts["byArea"], finding.get("area"))
        _increment(counts["byStatus"], finding.get("status"))
        _add_role(counts["affectedRolesByKind"], kind, role)


def _aggregate_scores_by_role(score_values: dict[str, dict[str, list[int]]]) -> dict[str, Any]:
    output: dict[str, Any] = {}
    for role, dimensions in sorted(score_values.items()):
        role_scores: dict[str, Any] = {}
        for key, values in sorted(dimensions.items()):
            if not values:
                continue
            average = round(sum(values) / len(values), 1)
            role_scores[key] = {
                "label": SCORE_LABELS[key],
                "averagePct": average,
                "minPct": min(values),
                "maxPct": max(values),
                "sampleCount": len(values),
            }
        output[role] = role_scores
    return output


def _low_score_dimensions(aggregate_scores: dict[str, Any]) -> list[dict[str, Any]]:
    low_scores: list[dict[str, Any]] = []
    for role, scores in aggregate_scores.items():
        for key, score in scores.items():
            average = float(score["averagePct"])
            if key == "hallucination_risk_pct":
                is_low_quality = average > HIGH_RISK_THRESHOLD_PCT
                threshold = HIGH_RISK_THRESHOLD_PCT
                direction = "lower_is_better"
            else:
                is_low_quality = average < LOW_SCORE_THRESHOLD_PCT
                threshold = LOW_SCORE_THRESHOLD_PCT
                direction = "higher_is_better"
            if is_low_quality:
                low_scores.append({
                    "role": role,
                    "dimension": key,
                    "label": score["label"],
                    "averagePct": average,
                    "sampleCount": score["sampleCount"],
                    "thresholdPct": threshold,
                    "direction": direction,
                })
    return sorted(low_scores, key=lambda item: (item["role"], item["dimension"]))


def _finalize_grouped_friction(friction: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    groups = []
    for entry in friction.values():
        groups.append({
            "category": entry["category"],
            "count": entry["count"],
            "affectedRoles": sorted(entry["affectedRoles"]),
        })
    return sorted(groups, key=lambda item: (-item["count"], item["category"]))


def _objective_evidence(state: dict[str, Any]) -> dict[str, int]:
    tasks = state.get("tasks") if isinstance(state.get("tasks"), list) else []
    artifacts = state.get("artifacts") if isinstance(state.get("artifacts"), list) else []
    command_count = 0
    touched_file_count = 0
    for task in tasks:
        if not isinstance(task, dict):
            continue
        evidence = task.get("evidence") if isinstance(task.get("evidence"), dict) else {}
        command_count += len(evidence.get("commandsRan") or [])
        touched_file_count += len(evidence.get("touchedFiles") or [])
    return {
        "taskCount": len(tasks),
        "doneTaskCount": sum(1 for task in tasks if isinstance(task, dict) and task.get("status") == "done"),
        "artifactCount": len(artifacts),
        "approvedArtifactCount": sum(1 for artifact in artifacts if isinstance(artifact, dict) and artifact.get("status") == "approved"),
        "commandEvidenceCount": command_count,
        "touchedFileEvidenceCount": touched_file_count,
    }


def _dimension_category(dimension: str) -> str:
    if dimension in {"acceptance_criteria_clarity_pct", "task_clarity_pct"}:
        return "task_card"
    if dimension == "swarm_tool_effectiveness_pct":
        return "tooling"
    if dimension == "context_fit_pct":
        return "context"
    if dimension == "hallucination_risk_pct":
        return "validation"
    if dimension == "prompt_optimization_pct":
        return "prompting"
    return "coordination"


def _add_count_recommendations(
    recommendations: list[dict[str, Any]],
    counts: dict[str, Any],
    bucket_key: str,
) -> None:
    bucket = counts.get(bucket_key)
    if not isinstance(bucket, dict):
        return
    severities = counts.get("bySeverity") if isinstance(counts.get("bySeverity"), dict) else {}
    severity = highest_severity(severities.keys())
    role_bucket_key = "affectedRolesByCategory" if bucket_key == "byCategory" else "affectedRolesByKind"
    roles_by_category = counts.get(role_bucket_key) if isinstance(counts.get(role_bucket_key), dict) else {}
    for category, count in bucket.items():
        evidence_count = int(count or 0)
        if evidence_count <= 0:
            continue
        affected_roles = roles_by_category.get(category) or []
        recommendations.append({
            "category": str(category),
            "severity": severity,
            "evidenceCount": evidence_count,
            "affectedRoles": sorted(affected_roles),
            "suggestedOwner": recommendation_owner(str(category)),
            "proposedChange": proposed_change_for_category(str(category)),
        })


def _dedupe_recommendations(recommendations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: dict[tuple[str, str], dict[str, Any]] = {}
    for recommendation in recommendations:
        key = (recommendation["category"], recommendation["suggestedOwner"])
        existing = merged.get(key)
        if existing is None:
            merged[key] = {
                **recommendation,
                "affectedRoles": sorted({role for role in recommendation["affectedRoles"] if role}),
            }
            continue
        existing["evidenceCount"] += recommendation["evidenceCount"]
        existing["severity"] = highest_severity([existing["severity"], recommendation["severity"]])
        existing["affectedRoles"] = sorted(set(existing["affectedRoles"]) | {role for role in recommendation["affectedRoles"] if role})
    return sorted(merged.values(), key=lambda item: (-item["evidenceCount"], item["category"]))
