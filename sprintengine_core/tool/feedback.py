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

def parse_feedback_issue_args(args: argparse.Namespace, task_id: str) -> List[Dict[str, Any]]:
    issues: List[Dict[str, Any]] = []
    for index, raw_json in enumerate(getattr(args, "issue_json", None) or []):
        try:
            raw = json.loads(raw_json)
        except json.JSONDecodeError as exc:
            raise SystemExit(f"--issue-json must be valid JSON: {exc.msg}") from exc
        issues.append(normalize_feedback_issue(raw, task_id, index))
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
        "title": validate_feedback_issue_text(raw.get("title"), "finding.title", required=True),
        "detail": validate_feedback_issue_text(raw.get("detail"), "finding.detail", required=True),
        "status": status,
    }
    for key in ["recommendation", "requirementId", "file"]:
        text = validate_feedback_issue_text(raw.get(key), f"finding.{key}")
        if text:
            finding[key] = text
    return finding

def parse_feedback_finding_args(args: argparse.Namespace, task_id: str) -> List[Dict[str, Any]]:
    findings: List[Dict[str, Any]] = []
    for index, raw_json in enumerate(getattr(args, "finding_json", None) or []):
        try:
            raw = json.loads(raw_json)
        except json.JSONDecodeError as exc:
            raise SystemExit(f"--finding-json must be valid JSON: {exc.msg}") from exc
        findings.append(normalize_feedback_finding(raw, task_id, index))
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

def parse_feedback_args(args: argparse.Namespace) -> Dict[str, Any]:
    scores: Dict[str, int] = {}
    json_scores: Dict[str, int] = {}
    for attr, state_key, json_key in FEEDBACK_SCORE_FIELDS:
        raw = getattr(args, attr, None)
        if raw is None:
            continue
        value = validate_feedback_percent(raw, f"--{attr.replace('_', '-')}")
        scores[state_key] = value
        json_scores[json_key] = value

    counts: Dict[str, int] = {}
    json_counts: Dict[str, int] = {}
    for attr, state_key, json_key in FEEDBACK_COUNT_FIELDS:
        raw = getattr(args, attr, None)
        if raw is None:
            continue
        value = validate_feedback_count(raw, f"--{attr.replace('_', '-')}")
        counts[state_key] = value
        json_counts[json_key] = value

    text_fields: Dict[str, str] = {}
    json_text_fields: Dict[str, str] = {}
    for attr, state_key, json_key in FEEDBACK_TEXT_FIELDS:
        raw = str(getattr(args, attr, "") or "")
        if not raw.strip():
            continue
        text = validate_feedback_text(raw, f"--{attr.replace('_', '-')}")
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

def append_reviewer_difficulty_assessment(
    task: Dict[str, Any],
    *,
    pct: Optional[int],
    dimension: str,
    reason: str,
    reviewer_agent_id: str,
    reviewer_role: str,
    gate_id: str,
    gate_attempt_id: str,
) -> Optional[Dict[str, Any]]:
    if pct is None and not str(dimension or "").strip() and not str(reason or "").strip():
        return None
    if pct is None:
        raise SystemExit("--reviewed-difficulty-pct is required when recording reviewer difficulty.")
    dimension_text = str(dimension or "").strip()
    if dimension_text not in VALID_DIFFICULTY_REVIEWER_DIMENSIONS:
        raise SystemExit(
            "--reviewed-difficulty-dimension must be one of: "
            f"{', '.join(sorted(VALID_DIFFICULTY_REVIEWER_DIMENSIONS))}."
        )
    assessment = {
        "pct": validate_difficulty_percent(pct, "--reviewed-difficulty-pct"),
        "dimension": dimension_text,
        "reason": validate_feedback_text(str(reason or ""), "--reviewed-difficulty-reason"),
        "reviewerAgentId": reviewer_agent_id,
        "reviewerRole": reviewer_role,
        "gateId": gate_id,
        "gateAttemptId": gate_attempt_id,
        "capturedAt": now_iso(),
    }
    difficulty = task.setdefault("difficulty", {})
    assessments = difficulty.get("reviewerAssessments")
    if not isinstance(assessments, list):
        assessments = []
    assessments.append(assessment)
    difficulty["reviewerAssessments"] = assessments
    return assessment

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
                "gate_id": assessment.get("gateId"),
                "gate_attempt_id": assessment.get("gateAttemptId"),
                "captured_at": assessment.get("capturedAt"),
            }
            for assessment in assessments
            if isinstance(assessment, dict)
        ]
    return snapshot

def elapsed_ms(task: Dict[str, Any]) -> Optional[int]:
    started_at = task.get("startedAt")
    completed_at = task.get("completedAt")
    if not isinstance(started_at, str) or not isinstance(completed_at, str):
        return None
    try:
        start = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
        end = datetime.fromisoformat(completed_at.replace("Z", "+00:00"))
    except ValueError:
        return None
    return max(0, int((end - start).total_seconds() * 1000))

def observed_task_metrics(task: Dict[str, Any]) -> Dict[str, Any]:
    ev = ensure_evidence(task)
    observed: Dict[str, Any] = {
        "task_status": task.get("status"),
        "commands_run_count": len(ev.get("commandsRan", [])),
        "files_touched_count": len(ev.get("touchedFiles", [])),
        "human_intervention_count": 0,
    }
    duration = elapsed_ms(task)
    if duration is not None:
        observed["elapsed_ms"] = duration
    return observed

def feedback_review_target(args: argparse.Namespace, state: Dict[str, Any], default_task: Dict[str, Any]) -> Dict[str, Any]:
    target_task_id = str(getattr(args, "review_target_task_id", "") or "").strip()
    target_agent_id = str(getattr(args, "review_target_agent_id", "") or "").strip()
    target_execution_id = str(getattr(args, "review_target_execution_id", "") or "").strip()
    target_values = {
        "--review-target-task-id": target_task_id,
        "--review-target-agent-id": target_agent_id,
        "--review-target-execution-id": target_execution_id,
    }
    provided_target_flags = [flag for flag, value in target_values.items() if value]
    if provided_target_flags and len(provided_target_flags) != len(target_values):
        missing = ", ".join(flag for flag, value in target_values.items() if not value)
        raise SystemExit(f"Reviewer assessments require all review target fields. Missing: {missing}.")
    target_task = find_task(state, target_task_id) if target_task_id else default_task
    return {
        "task": target_task,
        "taskId": str(target_task.get("id") or ""),
        "agentId": target_agent_id,
        "executionId": target_execution_id,
        "isReviewerAssessment": bool(provided_target_flags),
    }

def build_feedback_payload(
    args: argparse.Namespace,
    state: Dict[str, Any],
    state_path: Path,
    task: Dict[str, Any],
    actor: str,
    gate_context: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    if not feedback_args_present(args):
        return None

    parsed = parse_feedback_args(args)
    now = now_iso()
    if gate_context:
        review_target = {
            "task": task,
            "taskId": str(task.get("id") or ""),
            "agentId": str(task.get("ownerAgentId") or task.get("role") or ""),
            "executionId": str(gate_context.get("attemptId") or ""),
            "isReviewerAssessment": True,
        }
    else:
        review_target = feedback_review_target(args, state, task)
    target_task = review_target["task"]
    role = str(target_task.get("role") or "")
    reviewer_role = str(gate_context.get("role") if gate_context else task.get("role") or "")
    task_id = str(review_target["taskId"])
    team_slug = str(state.get("sprintengine", {}).get("name") or state_path.parent.name)
    issues = parse_feedback_issue_args(args, task_id)
    findings = parse_feedback_finding_args(args, task_id)
    source = "gate_verdict_assessment" if gate_context else "reviewer_assessment" if review_target["isReviewerAssessment"] else "agent_self_report"
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
    if gate_context:
        state_feedback["gate"] = {
            "phase": gate_context.get("phase"),
            "gateId": gate_context.get("gateId"),
            "attemptId": gate_context.get("attemptId"),
            "verdict": gate_context.get("verdict"),
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
    if gate_context:
        record["gate_phase"] = gate_context.get("phase")
        record["gate_id"] = gate_context.get("gateId")
        record["gate_attempt_id"] = gate_context.get("attemptId")
        record["gate_verdict"] = gate_context.get("verdict")
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
                "title": finding["title"],
                "detail": finding["detail"],
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
    }

def attach_feedback_payload(state: Dict[str, Any], feedback_payload: Dict[str, Any], actor: str) -> None:
    target_task = feedback_payload["targetTask"]
    state_feedback = feedback_payload["stateFeedback"]
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
