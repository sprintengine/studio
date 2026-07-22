"""Sanitized feedback analysis for sprintengine runs."""

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
    count_totals: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    benchmark_count_totals: dict[str, int] = defaultdict(int)
    source_counts: dict[str, int] = {}
    friction: dict[str, dict[str, Any]] = {}
    issue_counts = _empty_issue_counts()
    finding_counts = _empty_finding_counts()
    difficulty_records: list[dict[str, Any]] = []

    for record in records:
        source = str(record.get("source") or "unknown")
        source_counts[source] = source_counts.get(source, 0) + 1
        role = str(record.get("role") or "unknown")
        for score_key, score in normalized_scores(record).items():
            score_values[role][score_key].append(score)
        raw_counts = record.get("counts")
        if isinstance(raw_counts, dict):
            for key, value in raw_counts.items():
                if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                    count_totals[role][str(key)] += value
                    benchmark_count_totals[str(key)] += value
        difficulty = _difficulty_record(record)
        if difficulty is not None:
            difficulty_records.append(difficulty)

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
        "source": "agent_feedback",
        "sourceCounts": dict(sorted(source_counts.items())),
        "privacy": PRIVATE_CONTENT_NOTICE,
        "feedbackRecordCount": len(records),
        "aggregateScoresByRole": aggregate_scores,
        "aggregateByAgent": _aggregate_by_agent(records),
        "aggregateCountsByRole": _aggregate_counts_by_role(count_totals),
        "benchmarkRates": _benchmark_rates(benchmark_count_totals),
        "difficultyAnalytics": _difficulty_analytics(difficulty_records),
        "lowScoreDimensions": _low_score_dimensions(aggregate_scores),
        "groupedFriction": _finalize_grouped_friction(friction),
        "issueCounts": issue_counts,
        "findingCounts": finding_counts,
        "objectiveEvidence": _objective_evidence(state or {}),
        "note": "Feedback includes subjective self-reports and reviewer assessments; interpret it alongside objective task, artifact, and test evidence.",
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


# Snake-case `counts` keys (see FEEDBACK_COUNT_FIELDS) → camelCase payload keys the
# renderer consumes. Measured defect signals attributed to the implementer agent.
_MEASURED_COUNT_KEYS = {
    "claims_checked": "claimsChecked",
    "hallucinated_claims": "hallucinatedClaims",
    "factual_errors": "factualErrors",
    "implementation_mistakes": "implementationMistakes",
    "missed_requirements": "missedRequirements",
    "regression_count": "regressionCount",
    "test_failures_introduced": "testFailuresIntroduced",
    "unsafe_changes": "unsafeChanges",
    "accessibility_issues": "accessibilityIssues",
    "design_issues": "designIssues",
}


def _avg_score_map(dim_values: dict[str, list[int]]) -> dict[str, Any]:
    output: dict[str, Any] = {}
    for key, values in sorted(dim_values.items()):
        if not values:
            continue
        output[key] = {
            "label": SCORE_LABELS.get(key, key),
            "averagePct": round(sum(values) / len(values), 1),
            "sampleCount": len(values),
        }
    return output


def _accumulate_findings(raw_findings: Any, bucket: dict[str, Any]) -> None:
    if not isinstance(raw_findings, list):
        return
    for finding in raw_findings:
        if not isinstance(finding, dict):
            continue
        bucket["total"] += 1
        bucket["bySeverity"][str(finding.get("severity") or "low")] += 1


def _aggregate_by_agent(records: list[dict[str, Any]]) -> dict[str, Any]:
    """Per-agent metrics keyed by agentId.

    Self-reported scores come from the worker's own ``agent_self_report`` and
    ``phase_advance_self_review`` records
    (keyed by ``agent_id``). Measured signals come from reviewer/gate records and
    are attributed to the implementer being reviewed (``review_target_agent_id``),
    never to the reviewer who logged them. ``findingsRaised`` counts findings an
    agent authored while reviewing. The renderer joins these rows against the full
    roster and supplies task counts; rows are emitted only for agents with data.
    """

    self_scores: dict[str, dict[str, list[int]]] = defaultdict(lambda: defaultdict(list))
    self_record_count: dict[str, int] = defaultdict(int)
    measured_scores: dict[str, dict[str, list[int]]] = defaultdict(lambda: defaultdict(list))
    measured_counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    measured_record_count: dict[str, int] = defaultdict(int)
    findings_against: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"total": 0, "bySeverity": defaultdict(int)}
    )
    # Self-review provenance, kept separate from reviewer-measured signals: the
    # defect counts and findings an owner reported against its OWN work. These
    # are honest but not independent, so the renderer labels them differently.
    self_counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    self_findings: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"total": 0, "bySeverity": defaultdict(int)}
    )
    self_task_counts: dict[str, dict[str, dict[str, int]]] = defaultdict(
        lambda: defaultdict(lambda: defaultdict(int))
    )
    self_task_reviews: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    findings_raised: dict[str, int] = defaultdict(int)
    # Reviewer activity, keyed by the reviewing agent (what they did, vs. the
    # measured signals above which describe the implementer's work).
    reviews_performed: dict[str, int] = defaultdict(int)
    tasks_reviewed: dict[str, set[str]] = defaultdict(set)
    review_verdicts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    # `task.advance` outcomes an agent recorded closing a phase on its OWN task.
    phase_outcomes: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    # Per-agent, per-task measured detail for the drill-down. Aggregates only
    # (review count + summed defect counts); finding prose stays in the renderer
    # projection, so this output remains sanitized.
    task_reviews: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    task_counts: dict[str, dict[str, dict[str, int]]] = defaultdict(
        lambda: defaultdict(lambda: defaultdict(int))
    )
    roles: dict[str, str] = {}

    for record in records:
        source = str(record.get("source") or "")
        agent_id = str(record.get("agent_id") or "").strip()
        role = str(record.get("role") or "").strip()
        scores = normalized_scores(record)

        # A phase advance is the OWNER reporting on its own work (MC-1542): it is a
        # self-report, but unlike a plain `agent_self_report` it carries the findings
        # the owner found AND fixed. Those findings (and any defect counts) are the
        # review signal that gate verdicts used to supply — counted under the
        # agent's selfReview provenance, attributed to the owner's own task.
        if source in {"agent_self_report", "phase_advance_self_review"}:
            if not agent_id:
                continue
            roles.setdefault(agent_id, role)
            self_record_count[agent_id] += 1
            for key, value in scores.items():
                self_scores[agent_id][key].append(value)
            # Self-attributed defect telemetry: the owner's counts and findings
            # against its own task. Kept in the selfReview buckets — never mixed
            # into `measured`, which stays reviewer-only.
            task_id = str(record.get("task_id") or "").strip()
            raw_counts = record.get("counts")
            if isinstance(raw_counts, dict):
                for snake, camel in _MEASURED_COUNT_KEYS.items():
                    value = raw_counts.get(snake)
                    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                        self_counts[agent_id][camel] += value
                        if task_id and camel != "claimsChecked":
                            self_task_counts[agent_id][task_id][camel] += value
            if source == "phase_advance_self_review":
                if task_id:
                    self_task_reviews[agent_id][task_id] += 1
                outcome = str(record.get("phase_outcome") or "").strip()
                if outcome:
                    phase_outcomes[agent_id][outcome] += 1
                _accumulate_findings(record.get("findings"), self_findings[agent_id])
                if isinstance(record.get("findings"), list):
                    findings_raised[agent_id] += len(record["findings"])
            continue

        # A SWEEP assessing another task still passes the --review-target-* trio →
        # measured, attributed to the implementer of the audited task.
        target = str(record.get("review_target_agent_id") or "").strip()
        if target:
            roles.setdefault(target, role)  # role is the implementer (target task) role
            measured_record_count[target] += 1
            for key, value in scores.items():
                measured_scores[target][key].append(value)
            raw_counts = record.get("counts")
            task_id = str(record.get("review_target_task_id") or record.get("task_id") or "").strip()
            if task_id:
                task_reviews[target][task_id] += 1
            if isinstance(raw_counts, dict):
                for snake, camel in _MEASURED_COUNT_KEYS.items():
                    value = raw_counts.get(snake)
                    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                        measured_counts[target][camel] += value
                        # Per-task detail lists defects only; claims_checked is the
                        # rate denominator, not an issue, so it stays out of taskCounts.
                        if task_id and camel != "claimsChecked":
                            task_counts[target][task_id][camel] += value
            _accumulate_findings(record.get("findings"), findings_against[target])
        if agent_id and isinstance(record.get("findings"), list):
            findings_raised[agent_id] += len(record["findings"])

        # Reviewer-side activity: attribute to the agent who performed the review.
        reviewer = str(record.get("reviewer_agent_id") or agent_id or "").strip()
        if reviewer:
            reviews_performed[reviewer] += 1
            review_target_task = str(record.get("review_target_task_id") or record.get("task_id") or "").strip()
            if review_target_task:
                tasks_reviewed[reviewer].add(review_target_task)
            outcome = str(record.get("phase_outcome") or "").strip()
            if not outcome:
                # A task.log assessment carries no phase outcome; classify it
                # from content. Fix-forward is the sweep mandate, so an audit
                # that surfaced defects reads as fixed-forward, a defect-free
                # one as a clean pass (escalations arrive via task.advance).
                raw_counts = record.get("counts")
                defect_count = (
                    sum(
                        value
                        for snake, value in raw_counts.items()
                        if snake != "claims_checked"
                        and isinstance(value, int)
                        and not isinstance(value, bool)
                        and value > 0
                    )
                    if isinstance(raw_counts, dict)
                    else 0
                )
                has_findings = isinstance(record.get("findings"), list) and bool(record["findings"])
                # A clean pass must be backed by evidence a review actually
                # happened — claims checked (or any other recorded count) or
                # scores. An empty reviewer task.log with no outcome, counts,
                # findings, or scores is not a verdict; counting it as a clean
                # pass silently inflated the reviewer's pass rate.
                has_counts = isinstance(raw_counts, dict) and any(
                    isinstance(value, int) and not isinstance(value, bool) and value > 0
                    for value in raw_counts.values()
                )
                if defect_count > 0 or has_findings:
                    outcome = "pass_with_fixes"
                elif has_counts or scores:
                    outcome = "pass"
                else:
                    outcome = ""
            if outcome:
                review_verdicts[reviewer][outcome] += 1

    agent_ids = (
        set(self_record_count)
        | set(measured_record_count)
        | set(findings_raised)
        | set(reviews_performed)
    )
    output: dict[str, Any] = {}
    for agent_id in sorted(agent_ids):
        counts = dict(measured_counts.get(agent_id, {}))
        measured: dict[str, Any] = {
            "reviewSampleCount": measured_record_count.get(agent_id, 0),
            "scores": _avg_score_map(measured_scores.get(agent_id, {})),
            "counts": dict(sorted(counts.items())),
        }
        claims_checked = counts.get("claimsChecked", 0)
        if claims_checked > 0:
            measured["hallucinationRatePct"] = round(
                (counts.get("hallucinatedClaims", 0) / claims_checked) * 100, 1
            )
        against = findings_against.get(agent_id)
        if against and against["total"] > 0:
            measured["findingsAgainst"] = {
                "total": against["total"],
                "bySeverity": dict(sorted(against["bySeverity"].items())),
            }
        per_task_reviews = task_reviews.get(agent_id, {})
        per_task_counts = task_counts.get(agent_id, {})
        task_ids = set(per_task_reviews) | set(per_task_counts)
        if task_ids:
            measured["taskCounts"] = {
                task_id: {
                    "reviewSampleCount": per_task_reviews.get(task_id, 0),
                    "counts": {
                        key: value
                        for key, value in sorted(per_task_counts.get(task_id, {}).items())
                        if value > 0
                    },
                }
                for task_id in sorted(task_ids)
            }
        row: dict[str, Any] = {
            "role": roles.get(agent_id, ""),
            "selfReported": {
                "sampleCount": self_record_count.get(agent_id, 0),
                "scores": _avg_score_map(self_scores.get(agent_id, {})),
            },
            "measured": measured,
            "findingsRaised": findings_raised.get(agent_id, 0),
        }
        # Sweep table: an agent that audited OTHER tasks (a fix-forward sweep) and
        # what it did about what it found.
        if reviews_performed.get(agent_id, 0) > 0:
            outcomes = review_verdicts.get(agent_id, {})
            row["sweep"] = {
                "tasksAudited": len(tasks_reviewed.get(agent_id, set())),
                "assessmentsRecorded": reviews_performed[agent_id],
                "passed": outcomes.get("pass", 0),
                "fixedForward": outcomes.get("pass_with_fixes", 0),
                "escalated": outcomes.get("escalate", 0),
            }
        # Self-review table: what this agent found (and fixed) reviewing its OWN
        # diff — phase outcomes plus the self-attributed defect counts/findings.
        own = phase_outcomes.get(agent_id, {})
        own_counts = dict(self_counts.get(agent_id, {}))
        own_findings = self_findings.get(agent_id)
        if own or own_counts or (own_findings and own_findings["total"] > 0):
            self_review: dict[str, Any] = {
                "phasesClosed": sum(own.values()),
                "passed": own.get("pass", 0),
                "fixedForward": own.get("pass_with_fixes", 0),
                "escalated": own.get("escalate", 0),
            }
            if own_counts:
                self_review["counts"] = dict(sorted(own_counts.items()))
            if own_findings and own_findings["total"] > 0:
                self_review["findingsReported"] = {
                    "total": own_findings["total"],
                    "bySeverity": dict(sorted(own_findings["bySeverity"].items())),
                }
            own_task_reviews = self_task_reviews.get(agent_id, {})
            own_task_counts = self_task_counts.get(agent_id, {})
            own_task_ids = set(own_task_reviews) | set(own_task_counts)
            if own_task_ids:
                self_review["taskCounts"] = {
                    task_id: {
                        "reviewSampleCount": own_task_reviews.get(task_id, 0),
                        "counts": {
                            key: value
                            for key, value in sorted(own_task_counts.get(task_id, {}).items())
                            if value > 0
                        },
                    }
                    for task_id in sorted(own_task_ids)
                }
            row["selfReview"] = self_review
        output[agent_id] = row
    return output


def _aggregate_counts_by_role(count_totals: dict[str, dict[str, int]]) -> dict[str, Any]:
    output: dict[str, Any] = {}
    for role, counts in sorted(count_totals.items()):
        role_counts = {key: value for key, value in sorted(counts.items()) if value > 0}
        claims_checked = int(role_counts.get("claims_checked") or 0)
        hallucinated_claims = int(role_counts.get("hallucinated_claims") or 0)
        if claims_checked > 0:
            role_counts["hallucination_rate_pct"] = round((hallucinated_claims / claims_checked) * 100, 1)
        if role_counts:
            output[role] = role_counts
    return output


def _benchmark_rates(counts: dict[str, int]) -> dict[str, Any]:
    claims_checked = int(counts.get("claims_checked") or 0)
    if claims_checked <= 0:
        return {}
    rates: dict[str, Any] = {
        "claims_checked": claims_checked,
    }
    numerators = {
        "claim_hallucination_rate_pct": "hallucinated_claims",
        "factual_error_rate_pct": "factual_errors",
        "missed_requirement_rate_pct": "missed_requirements",
        "implementation_mistake_rate_pct": "implementation_mistakes",
        "regression_rate_pct": "regression_count",
        "unsafe_change_rate_pct": "unsafe_changes",
    }
    for rate_key, count_key in numerators.items():
        value = counts.get(count_key)
        if isinstance(value, int) and not isinstance(value, bool):
            rates[rate_key] = round((value / claims_checked) * 100, 1)
    return rates


def _difficulty_record(record: dict[str, Any]) -> dict[str, Any] | None:
    raw = record.get("difficulty")
    if not isinstance(raw, dict):
        return None
    difficulty: dict[str, Any] = {
        "task_id": str(record.get("task_id") or record.get("taskId") or ""),
        "role": str(record.get("role") or "unknown"),
    }
    architect_estimate = _percent(raw.get("architect_estimate_pct"))
    implementer_actual = _percent(raw.get("implementer_actual_pct"))
    if architect_estimate is not None:
        difficulty["architect_estimate_pct"] = architect_estimate
    if implementer_actual is not None:
        difficulty["implementer_actual_pct"] = implementer_actual
    assessments = raw.get("reviewer_assessments")
    if isinstance(assessments, list):
        normalized_assessments = []
        for assessment in assessments:
            if not isinstance(assessment, dict):
                continue
            pct = _percent(assessment.get("pct"))
            if pct is None:
                continue
            normalized_assessments.append(
                {
                    "pct": pct,
                    "dimension": str(assessment.get("dimension") or "unspecified"),
                    "reviewer_role": str(assessment.get("reviewer_role") or "unknown"),
                    "reviewer_agent_id": str(assessment.get("reviewer_agent_id") or "unknown"),
                    "phase": str(assessment.get("phase") or ""),
                    "task_id": difficulty["task_id"],
                    "task_role": difficulty["role"],
                }
            )
        if normalized_assessments:
            difficulty["reviewer_assessments"] = normalized_assessments
    return difficulty if len(difficulty) > 2 else None


def _percent(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if value < 0 or value > 100:
        return None
    return value


def _difficulty_analytics(records: list[dict[str, Any]]) -> dict[str, Any]:
    architect_errors: list[int] = []
    architect_biases: list[int] = []
    reviewer_assessments: list[dict[str, Any]] = []
    seen_architect_tasks: set[str] = set()
    seen_reviewer_assessments: set[tuple[str, str, str, str, str, int]] = set()
    for record in records:
        architect_estimate = record.get("architect_estimate_pct")
        implementer_actual = record.get("implementer_actual_pct")
        task_id = str(record.get("task_id") or "")
        if (
            task_id not in seen_architect_tasks
            and isinstance(architect_estimate, int)
            and isinstance(implementer_actual, int)
        ):
            delta = architect_estimate - implementer_actual
            architect_errors.append(abs(delta))
            architect_biases.append(delta)
            seen_architect_tasks.add(task_id)
        raw_assessments = record.get("reviewer_assessments")
        if isinstance(raw_assessments, list):
            for assessment in raw_assessments:
                if not isinstance(assessment, dict):
                    continue
                pct = assessment.get("pct")
                if not isinstance(pct, int) or isinstance(pct, bool):
                    continue
                identity = (
                    str(assessment.get("task_id") or ""),
                    str(assessment.get("reviewer_agent_id") or ""),
                    str(assessment.get("reviewer_role") or ""),
                    str(assessment.get("phase") or ""),
                    str(assessment.get("dimension") or "unspecified"),
                    pct,
                )
                if identity in seen_reviewer_assessments:
                    continue
                seen_reviewer_assessments.add(identity)
                reviewer_assessments.append(assessment)

    analytics: dict[str, Any] = {}
    if architect_errors:
        analytics["architect"] = {
            "sampleCount": len(architect_errors),
            "mean_absolute_error_pct": round(sum(architect_errors) / len(architect_errors), 1),
            "bias_pct": round(sum(architect_biases) / len(architect_biases), 1),
        }
    if reviewer_assessments:
        reviewer_values = [assessment["pct"] for assessment in reviewer_assessments]
        reviewer: dict[str, Any] = {
            "sampleCount": len(reviewer_values),
            "mean_difficulty_pct": round(sum(reviewer_values) / len(reviewer_values), 1),
            "byDimension": _difficulty_groups(reviewer_assessments, "dimension"),
            "byReviewerRole": _difficulty_groups(reviewer_assessments, "reviewer_role"),
            "byTaskRole": _difficulty_groups(reviewer_assessments, "task_role"),
        }
        disagreement = _reviewer_disagreement(reviewer_assessments)
        if disagreement:
            reviewer["disagreement"] = disagreement
        analytics["reviewer"] = reviewer
    return analytics


def _difficulty_groups(assessments: list[dict[str, Any]], key: str) -> dict[str, Any]:
    grouped: dict[str, list[int]] = defaultdict(list)
    for assessment in assessments:
        pct = assessment.get("pct")
        if isinstance(pct, int) and not isinstance(pct, bool):
            grouped[str(assessment.get(key) or "unspecified")].append(pct)
    return {
        group: {
            "sampleCount": len(values),
            "mean_difficulty_pct": round(sum(values) / len(values), 1),
        }
        for group, values in sorted(grouped.items())
        if values
    }


def _reviewer_disagreement(assessments: list[dict[str, Any]]) -> dict[str, Any]:
    grouped: dict[tuple[str, str], list[int]] = defaultdict(list)
    for assessment in assessments:
        pct = assessment.get("pct")
        if isinstance(pct, int) and not isinstance(pct, bool):
            grouped[(str(assessment.get("task_id") or ""), str(assessment.get("dimension") or "unspecified"))].append(pct)
    ranges = [max(values) - min(values) for values in grouped.values() if len(values) >= 2]
    if not ranges:
        return {}
    return {
        "sampleCount": len(ranges),
        "mean_range_pct": round(sum(ranges) / len(ranges), 1),
        "max_range_pct": max(ranges),
    }


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
    if dimension == "sprintengine_tool_effectiveness_pct":
        return "tooling"
    if dimension == "context_fit_pct":
        return "context"
    if dimension == "hallucination_risk_pct":
        return "validation"
    if dimension == "prompt_optimization_pct":
        return "prompting"
    if dimension in {"correctness_pct", "code_quality_pct", "maintainability_pct"}:
        return "code_bug"
    if dimension in {"evidence_quality_pct", "test_quality_pct"}:
        return "test_gap"
    if dimension == "instruction_following_pct":
        return "task_card"
    if dimension == "security_quality_pct":
        return "security_issue"
    if dimension == "performance_quality_pct":
        return "performance_issue"
    if dimension in {"frontend_functionality_pct", "frontend_aesthetic_quality_pct", "accessibility_pct", "ux_competitiveness_pct"}:
        return "product_requirement_violation"
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
