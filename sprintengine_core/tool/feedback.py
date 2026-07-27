"""Agent feedback payload and metrics helpers."""
from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from sprintengine_core.tool.common import path_is_relative_to
from sprintengine_core.tool.constants import *  # noqa: F403,F401
from sprintengine_core.tool.paths import now_iso
from sprintengine_core.tool.state import append_event, append_task_activity, find_task
from sprintengine_core.tool.tasks import ensure_evidence, normalize_scope_expansion

def _record_warning(warnings: Optional[List[str]], exc: SystemExit) -> None:
    """Best-effort telemetry: capture a validation failure as a warning and drop
    the offending optional field. When `warnings` is None the caller wants strict
    behavior, so re-raise. Operational fields (phase outcome, summary) are validated
    outside this module and still hard-fail."""
    if warnings is None:
        raise exc
    message = exc.code
    warnings.append(str(message) if message not in (None, 0) else "feedback field dropped")

def feedback_args_present(args: argparse.Namespace) -> bool:
    for attr in ("review_target_task_id", "review_target_agent_id", "review_target_execution_id"):
        if str(getattr(args, attr, "") or "").strip():
            return True
    for attr, _, _ in FEEDBACK_SCORE_FIELDS:
        if getattr(args, attr, None) is not None:
            return True
    for attr, _, _ in FEEDBACK_COUNT_FIELDS:
        if getattr(args, attr, None) is not None:
            return True
    for attr, _, _ in FEEDBACK_TEXT_FIELDS:
        if str(getattr(args, attr, "") or "").strip():
            return True
    if getattr(args, "issue_json", None):
        return True
    if getattr(args, "finding_json", None):
        return True
    return False

def validate_feedback_percent(value: int, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > 100:
        raise SystemExit(f"{field_name} must be an integer from 0 to 100.")
    return value

def validate_feedback_count(value: int, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise SystemExit(f"{field_name} must be a non-negative integer.")
    return value

def validate_difficulty_percent(value: int, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > 100:
        raise SystemExit(f"{field_name} must be an integer from 0 to 100.")
    return value

def validate_feedback_text(value: str, field_name: str) -> str:
    text = value.strip()
    if len(text) > FEEDBACK_TEXT_LIMIT:
        raise SystemExit(f"{field_name} must be {FEEDBACK_TEXT_LIMIT} characters or fewer.")
    return text

def validate_feedback_issue_text(value: Any, field_name: str, required: bool = False) -> str:
    if not isinstance(value, str):
        if required:
            raise SystemExit(f"{field_name} must be a string.")
        return ""
    text = value.strip()
    if required and not text:
        raise SystemExit(f"{field_name} cannot be empty.")
    if len(text) > FEEDBACK_ISSUE_TEXT_LIMIT:
        raise SystemExit(f"{field_name} must be {FEEDBACK_ISSUE_TEXT_LIMIT} characters or fewer.")
    return text

def normalize_feedback_issue(raw: Any, task_id: str, index: int) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        raise SystemExit("--issue-json entries must be JSON objects.")

    category = validate_feedback_issue_text(raw.get("category"), "issue.category", required=True)
    if category not in VALID_FEEDBACK_ISSUE_CATEGORIES:
        raise SystemExit(f"issue.category must be one of: {', '.join(sorted(VALID_FEEDBACK_ISSUE_CATEGORIES))}.")

    severity = validate_feedback_issue_text(raw.get("severity"), "issue.severity", required=True)
    if severity not in VALID_FEEDBACK_ISSUE_SEVERITIES:
        raise SystemExit(f"issue.severity must be one of: {', '.join(sorted(VALID_FEEDBACK_ISSUE_SEVERITIES))}.")

    status = validate_feedback_issue_text(raw.get("status", "new"), "issue.status") or "new"
    if status not in VALID_FEEDBACK_ISSUE_STATUSES:
        raise SystemExit(f"issue.status must be one of: {', '.join(sorted(VALID_FEEDBACK_ISSUE_STATUSES))}.")

    issue_id = validate_feedback_issue_text(raw.get("id"), "issue.id") or f"{task_id}-I{index + 1}"
    issue = {
        "id": issue_id,
        "category": category,
        "severity": severity,
        "title": validate_feedback_issue_text(raw.get("title"), "issue.title", required=True),
        "detail": validate_feedback_issue_text(raw.get("detail"), "issue.detail", required=True),
        "status": status,
    }
    for key in ["target", "evidence", "suggestedPromptChange", "suggestedProcessChange"]:
        text = validate_feedback_issue_text(raw.get(key), f"issue.{key}")
        if text:
            issue[key] = text
    return issue

def parse_feedback_issue_args(
    args: argparse.Namespace, task_id: str, warnings: Optional[List[str]] = None
) -> List[Dict[str, Any]]:
    issues: List[Dict[str, Any]] = []
    for index, raw_json in enumerate(getattr(args, "issue_json", None) or []):
        try:
            raw = json.loads(raw_json)
        except json.JSONDecodeError as exc:
            _record_warning(warnings, SystemExit(f"--issue-json must be valid JSON: {exc.msg}"))
            continue
        try:
            issues.append(normalize_feedback_issue(raw, task_id, index))
        except SystemExit as exc:
            _record_warning(warnings, exc)
    return issues

def normalize_feedback_finding(raw: Any, task_id: str, index: int) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        raise SystemExit("--finding-json entries must be JSON objects.")

    kind = validate_feedback_issue_text(raw.get("kind"), "finding.kind", required=True)
    if kind not in VALID_FEEDBACK_FINDING_KINDS:
        raise SystemExit(f"finding.kind must be one of: {', '.join(sorted(VALID_FEEDBACK_FINDING_KINDS))}.")

    severity = validate_feedback_issue_text(raw.get("severity"), "finding.severity", required=True)
    if severity not in VALID_FEEDBACK_FINDING_SEVERITIES:
        raise SystemExit(f"finding.severity must be one of: {', '.join(sorted(VALID_FEEDBACK_FINDING_SEVERITIES))}.")

    area = validate_feedback_issue_text(raw.get("area"), "finding.area", required=True)
    if area not in VALID_FEEDBACK_FINDING_AREAS:
        raise SystemExit(f"finding.area must be one of: {', '.join(sorted(VALID_FEEDBACK_FINDING_AREAS))}.")

    status = validate_feedback_issue_text(raw.get("status", "open"), "finding.status") or "open"
    if status not in VALID_FEEDBACK_FINDING_STATUSES:
        raise SystemExit(f"finding.status must be one of: {', '.join(sorted(VALID_FEEDBACK_FINDING_STATUSES))}.")

    finding_id = validate_feedback_issue_text(raw.get("id"), "finding.id") or f"{task_id}-F{index + 1}"
    finding = {
        "id": finding_id,
        "kind": kind,
        "severity": severity,
        "area": area,
        "status": status,
    }
    # findingJson is categorical telemetry only (kind/area/severity drive the
    # analytics aggregation). `title` is an optional short label; `detail` and
    # `recommendation` are accepted for compatibility but no longer solicited —
    # the actionable text lives in `requiredAction`.
    for key in ["title", "detail", "recommendation", "requirementId", "file"]:
        text = validate_feedback_issue_text(raw.get(key), f"finding.{key}")
        if text:
            finding[key] = text
    return finding

def parse_feedback_finding_args(
    args: argparse.Namespace, task_id: str, warnings: Optional[List[str]] = None
) -> List[Dict[str, Any]]:
    findings: List[Dict[str, Any]] = []
    for index, raw_json in enumerate(getattr(args, "finding_json", None) or []):
        try:
            raw = json.loads(raw_json)
        except json.JSONDecodeError as exc:
            _record_warning(warnings, SystemExit(f"--finding-json must be valid JSON: {exc.msg}"))
            continue
        try:
            findings.append(normalize_feedback_finding(raw, task_id, index))
        except SystemExit as exc:
            _record_warning(warnings, exc)
    return findings

def parse_scope_expansion_args(args: argparse.Namespace, task_id: str) -> List[Dict[str, Any]]:
    expansions: List[Dict[str, Any]] = []
    for index, raw_json in enumerate(getattr(args, "scope_expansion_json", None) or []):
        try:
            raw = json.loads(raw_json)
        except json.JSONDecodeError as exc:
            raise SystemExit(f"--scope-expansion-json must be valid JSON: {exc.msg}") from exc
        expansions.append(normalize_scope_expansion(raw, task_id, index))
    return expansions

def parse_feedback_args(args: argparse.Namespace, warnings: Optional[List[str]] = None) -> Dict[str, Any]:
    scores: Dict[str, int] = {}
    json_scores: Dict[str, int] = {}
    for attr, state_key, json_key in FEEDBACK_SCORE_FIELDS:
        raw = getattr(args, attr, None)
        if raw is None:
            continue
        try:
            value = validate_feedback_percent(raw, f"--{attr.replace('_', '-')}")
        except SystemExit as exc:
            _record_warning(warnings, exc)
            continue
        scores[state_key] = value
        json_scores[json_key] = value

    counts: Dict[str, int] = {}
    json_counts: Dict[str, int] = {}
    for attr, state_key, json_key in FEEDBACK_COUNT_FIELDS:
        raw = getattr(args, attr, None)
        if raw is None:
            continue
        try:
            value = validate_feedback_count(raw, f"--{attr.replace('_', '-')}")
        except SystemExit as exc:
            _record_warning(warnings, exc)
            continue
        counts[state_key] = value
        json_counts[json_key] = value

    text_fields: Dict[str, str] = {}
    json_text_fields: Dict[str, str] = {}
    for attr, state_key, json_key in FEEDBACK_TEXT_FIELDS:
        raw = str(getattr(args, attr, "") or "")
        if not raw.strip():
            continue
        try:
            text = validate_feedback_text(raw, f"--{attr.replace('_', '-')}")
        except SystemExit as exc:
            _record_warning(warnings, exc)
            continue
        text_fields[state_key] = text
        json_text_fields[json_key] = text

    return {
        "scores": scores,
        "jsonScores": json_scores,
        "counts": counts,
        "jsonCounts": json_counts,
        "textFields": text_fields,
        "jsonTextFields": json_text_fields,
    }

def set_architect_difficulty_estimate(task: Dict[str, Any], pct: Optional[int], reason: str = "") -> None:
    if pct is None and not str(reason or "").strip():
        return
    difficulty = task.setdefault("difficulty", {})
    if pct is not None:
        difficulty["architectEstimatePct"] = validate_difficulty_percent(pct, "--difficulty-pct")
    reason_text = str(reason or "").strip()
    if reason_text:
        difficulty["architectEstimateReason"] = validate_feedback_text(reason_text, "--difficulty-reason")

def set_implementer_actual_difficulty(task: Dict[str, Any], pct: Optional[int], reason: str = "") -> None:
    if pct is None and not str(reason or "").strip():
        return
    difficulty = task.setdefault("difficulty", {})
    if pct is not None:
        difficulty["implementerActualPct"] = validate_difficulty_percent(pct, "--actual-difficulty-pct")
    reason_text = str(reason or "").strip()
    if reason_text:
        difficulty["implementerActualReason"] = validate_feedback_text(reason_text, "--actual-difficulty-reason")

def difficulty_snapshot(task: Dict[str, Any]) -> Dict[str, Any]:
    raw = task.get("difficulty")
    if not isinstance(raw, dict):
        return {}
    snapshot: Dict[str, Any] = {}
    mapping = {
        "architectEstimatePct": "architect_estimate_pct",
        "architectEstimateReason": "architect_estimate_reason",
        "implementerActualPct": "implementer_actual_pct",
        "implementerActualReason": "implementer_actual_reason",
    }
    for state_key, json_key in mapping.items():
        value = raw.get(state_key)
        if value is not None and value != "":
            snapshot[json_key] = value
    assessments = raw.get("reviewerAssessments")
    if isinstance(assessments, list) and assessments:
        snapshot["reviewer_assessments"] = [
            {
                "pct": assessment.get("pct"),
                "dimension": assessment.get("dimension"),
                "reason": assessment.get("reason"),
                "reviewer_agent_id": assessment.get("reviewerAgentId"),
                "reviewer_role": assessment.get("reviewerRole"),
                "phase": assessment.get("phase"),
                "captured_at": assessment.get("capturedAt"),
            }
            for assessment in assessments
            if isinstance(assessment, dict)
        ]
    return snapshot

def elapsed_ms(task: Dict[str, Any]) -> Optional[int]:
    """Task duration, truthful for in-flight captures too (MC-1755).

    A completed task measures start -> completion. A record captured MID-task
    (a self-report before publish, a mid-flight audit) used to return None and
    drop the field; it now measures start -> now, so no row divides by a
    missing duration.
    """
    started_at = task.get("startedAt")
    completed_at = task.get("completedAt")
    if not isinstance(started_at, str):
        return None
    end_iso = completed_at if isinstance(completed_at, str) else now_iso()
    try:
        start = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
        end = datetime.fromisoformat(end_iso.replace("Z", "+00:00"))
    except ValueError:
        return None
    return max(0, int((end - start).total_seconds() * 1000))

def observed_task_metrics(task: Dict[str, Any]) -> Dict[str, Any]:
    ev = ensure_evidence(task)
    touched = ev.get("touchedFiles", [])
    diffs = ev.get("diffs", [])
    observed: Dict[str, Any] = {
        "task_status": task.get("status"),
        "commands_run_count": len(ev.get("commandsRan", [])),
        # Agents rarely log files explicitly (`task.log --file`), so the
        # touched-files list read 0 for tasks that demonstrably changed dozens
        # of files while their diff evidence carried every path (MC-1755).
        # Diff evidence is the observed floor; the explicit log can only add.
        "files_touched_count": max(
            len(touched) if isinstance(touched, list) else 0,
            len(diffs) if isinstance(diffs, list) else 0,
        ),
        "human_intervention_count": 0,
    }
    duration = elapsed_ms(task)
    if duration is not None:
        observed["elapsed_ms"] = duration
    return observed

def feedback_review_target(args: argparse.Namespace, state: Dict[str, Any], default_task: Dict[str, Any]) -> Dict[str, Any]:
    # This runs on every feedback path. A reviewer that assesses ANOTHER task passes
    # --review-target-task-id and becomes a reviewer assessment; the audited
    # task's implementer is resolved from its record (single-owner invariant), so
    # --review-target-agent-id / --review-target-execution-id are optional
    # overrides. Target agent/execution WITHOUT a task id is a hard error — an
    # assessment must name the audited task. A phase advance passes none of
    # them, so the owner's self-review reports against its own task.
    target_task_id = str(getattr(args, "review_target_task_id", "") or "").strip()
    target_agent_id = str(getattr(args, "review_target_agent_id", "") or "").strip()
    target_execution_id = str(getattr(args, "review_target_execution_id", "") or "").strip()
    if not target_task_id and (target_agent_id or target_execution_id):
        raise SystemExit("Reviewer assessments require --review-target-task-id naming the audited task.")
    target_task = find_task(state, target_task_id) if target_task_id else default_task
    if target_task_id and not target_agent_id:
        target_agent_id = str(
            target_task.get("lastImplementedByAgentId") or target_task.get("ownerAgentId") or ""
        ).strip()
        if not target_agent_id:
            raise SystemExit(
                f"Cannot attribute assessment: {target_task_id} records no implementer. "
                "Pass --review-target-agent-id explicitly."
            )
    return {
        "task": target_task,
        "taskId": str(target_task.get("id") or ""),
        "agentId": target_agent_id,
        "executionId": target_execution_id,
        "isReviewerAssessment": bool(target_task_id),
    }

def build_feedback_payload(
    args: argparse.Namespace,
    state: Dict[str, Any],
    state_path: Path,
    task: Dict[str, Any],
    actor: str,
    phase_context: Optional[Dict[str, Any]] = None,
    best_effort: bool = False,
) -> Optional[Dict[str, Any]]:
    if not feedback_args_present(args):
        return None

    # Best-effort telemetry (Decision 4) drops invalid optional fields with a
    # warning instead of rejecting; used on the phase-advance path so a bad
    # telemetry sub-field never blocks the operational transition. Self-report and
    # artifact paths stay strict (`warnings is None` re-raises).
    warnings: Optional[List[str]] = [] if best_effort else None
    parsed = parse_feedback_args(args, warnings)
    now = now_iso()
    # A phase advance is the OWNER reporting on its own work (MC-1542 decision 1),
    # so it is a self-report, not a reviewer assessment — there is no separate
    # reviewer to attribute it to. A reviewer assessing another task still passes the
    # --review-target-* trio and lands on the reviewer-assessment branch below.
    # Target resolution can fail (unknown target task, no recorded implementer):
    # in best-effort mode that is telemetry, not an operational error, so degrade
    # it to a warning and drop the feedback record while the caller's evidence
    # append survives. Strict callers (`warnings is None`) still re-raise.
    try:
        review_target = feedback_review_target(args, state, task)
    except SystemExit as exc:
        _record_warning(warnings, exc)
        return {
            "stateFeedback": None,
            "record": None,
            "targetTask": None,
            "isReviewerAssessment": False,
            "warnings": warnings,
        }
    target_task = review_target["task"]
    role = str(target_task.get("role") or "")
    reviewer_role = str(task.get("role") or "")
    task_id = str(review_target["taskId"])
    team_slug = str(state.get("sprintengine", {}).get("name") or state_path.parent.name)
    issues = parse_feedback_issue_args(args, task_id, warnings)
    findings = parse_feedback_finding_args(args, task_id, warnings)
    source = (
        "phase_advance_self_review"
        if phase_context
        else "reviewer_assessment"
        if review_target["isReviewerAssessment"]
        else "agent_self_report"
    )
    state_feedback = {
        "schemaVersion": FEEDBACK_SCHEMA_VERSION,
        "capturedAt": now,
        "source": source,
        "agentId": actor,
        "role": role,
        "scores": parsed["scores"],
    }
    if parsed["counts"]:
        state_feedback["counts"] = parsed["counts"]
    if review_target["isReviewerAssessment"]:
        state_feedback["reviewTarget"] = {
            "taskId": task_id,
            "agentId": review_target["agentId"],
            "executionId": review_target["executionId"],
        }
        state_feedback["reviewer"] = {
            "taskId": str(task.get("id") or ""),
            "agentId": actor,
            "role": reviewer_role,
        }
    if phase_context:
        state_feedback["phase"] = {
            "phase": phase_context.get("phase"),
            "outcome": phase_context.get("outcome"),
        }
    state_feedback.update(parsed["textFields"])

    record = {
        "schema_version": FEEDBACK_SCHEMA_VERSION,
        "run_id": team_slug,
        "team_slug": team_slug,
        "task_id": task_id,
        "agent_id": actor,
        "role": role,
        "task_title": target_task.get("title") or "",
        "captured_at": now,
        "source": source,
        "scores": parsed["jsonScores"],
        "counts": parsed["jsonCounts"],
        "observed": observed_task_metrics(target_task),
        **parsed["jsonTextFields"],
    }
    difficulty = difficulty_snapshot(target_task)
    if difficulty:
        record["difficulty"] = difficulty
    if review_target["isReviewerAssessment"]:
        record["review_target_task_id"] = task_id
        record["review_target_agent_id"] = review_target["agentId"]
        record["review_target_execution_id"] = review_target["executionId"]
        record["reviewer_task_id"] = str(task.get("id") or "")
        record["reviewer_agent_id"] = actor
        record["reviewer_role"] = reviewer_role
    if phase_context:
        record["phase"] = phase_context.get("phase")
        record["phase_outcome"] = phase_context.get("outcome")
    if issues:
        state_feedback["issues"] = issues
        record["issues"] = [
            {
                "id": issue["id"],
                "category": issue["category"],
                "severity": issue["severity"],
                "target": issue.get("target"),
                "title": issue["title"],
                "detail": issue["detail"],
                "evidence": issue.get("evidence"),
                "suggested_prompt_change": issue.get("suggestedPromptChange"),
                "suggested_process_change": issue.get("suggestedProcessChange"),
                "status": issue["status"],
            }
            for issue in issues
        ]
    if findings:
        state_feedback["findings"] = findings
        record["findings"] = [
            {
                "id": finding["id"],
                "kind": finding["kind"],
                "severity": finding["severity"],
                "area": finding["area"],
                "title": finding.get("title"),
                "detail": finding.get("detail"),
                "recommendation": finding.get("recommendation"),
                "requirement_id": finding.get("requirementId"),
                "file": finding.get("file"),
                "status": finding["status"],
            }
            for finding in findings
        ]
    return {
        "stateFeedback": state_feedback,
        "record": record,
        "targetTask": target_task,
        "isReviewerAssessment": review_target["isReviewerAssessment"],
        "warnings": warnings or [],
    }

def attach_feedback_payload(state: Dict[str, Any], feedback_payload: Dict[str, Any], actor: str) -> None:
    state_feedback = feedback_payload.get("stateFeedback")
    if not state_feedback:
        # Degraded best-effort payload: target resolution failed and only a
        # warning survives, so there is nothing to attach.
        return
    target_task = feedback_payload["targetTask"]
    if feedback_payload["isReviewerAssessment"]:
        assessments = target_task.get("feedbackAssessments")
        if not isinstance(assessments, list):
            assessments = []
        assessments.append(state_feedback)
        target_task["feedbackAssessments"] = assessments
        append_task_activity(target_task, "feedback", actor, f"{actor} recorded reviewer feedback.", {"feedbackKind": "assessment"})
        append_event(
            state,
            "task_feedback_assessed",
            actor,
            f"{actor} recorded reviewer feedback for {target_task.get('id')}.",
        )
        return
    target_task["feedback"] = state_feedback
    append_task_activity(target_task, "feedback", actor, f"{actor} recorded feedback.", {"feedbackKind": "self_report"})
    append_event(state, "task_feedback_recorded", actor, f"{actor} recorded feedback for {target_task.get('id')}.")

def metrics_feedback_path(state_path: Path) -> Path:
    team_dir = state_path.parent.resolve()
    metrics_dir = (team_dir / "metrics").resolve()
    if not path_is_relative_to(metrics_dir, team_dir):
        raise SystemExit(f"Metrics directory must stay under active Sprint Engine team folder: {team_dir}")
    return metrics_dir / "agent-feedback.jsonl"

def append_feedback_record(state_path: Path, record: Dict[str, Any]) -> str:
    output_path = metrics_feedback_path(state_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, sort_keys=True) + "\n")
    return str(output_path)
