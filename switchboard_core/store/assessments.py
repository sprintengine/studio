from __future__ import annotations

import errno
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

try:
    import fcntl as _fcntl_module
    _msvcrt_module = None
except ImportError:  # Windows
    _fcntl_module = None
    import msvcrt as _msvcrt_module  # type: ignore[import-not-found]

"""Agent assessment normalization and metrics recording."""

def normalize_assessment_percent(value: Any, field_name: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > 100:
        raise SwitchboardError(f"{field_name} must be an integer from 0 to 100.")
    return value


def normalize_assessment_count(value: Any, field_name: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise SwitchboardError(f"{field_name} must be a non-negative integer.")
    return value


def normalize_assessment_text(value: Any, field_name: str, *, required: bool = False, limit: int = 1000) -> str:
    if not isinstance(value, str):
        if required:
            raise SwitchboardError(f"{field_name} must be a string.")
        return ""
    text = value.strip()
    if required and not text:
        raise SwitchboardError(f"{field_name} cannot be empty.")
    if len(text) > limit:
        raise SwitchboardError(f"{field_name} must be {limit} characters or fewer.")
    return text


def normalize_assessment_issue(raw: Any, task_id: str, index: int) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise SwitchboardError("--issue-json entries must be JSON objects.")
    category = normalize_assessment_text(raw.get("category"), "issue.category", required=True)
    if category not in AGENT_ASSESSMENT_ISSUE_CATEGORIES:
        raise SwitchboardError(f"issue.category must be one of: {', '.join(sorted(AGENT_ASSESSMENT_ISSUE_CATEGORIES))}.")
    severity = normalize_assessment_text(raw.get("severity"), "issue.severity", required=True)
    if severity not in AGENT_ASSESSMENT_ISSUE_SEVERITIES:
        raise SwitchboardError(f"issue.severity must be one of: {', '.join(sorted(AGENT_ASSESSMENT_ISSUE_SEVERITIES))}.")
    issue = {
        "id": normalize_assessment_text(raw.get("id"), "issue.id") or f"{task_id}-AI{index + 1}",
        "category": category,
        "severity": severity,
        "title": normalize_assessment_text(raw.get("title"), "issue.title", required=True),
        "detail": normalize_assessment_text(raw.get("detail"), "issue.detail", required=True),
        "status": normalize_assessment_text(raw.get("status"), "issue.status") or "new",
    }
    for key in ("target", "evidence", "suggestedPromptChange", "suggestedProcessChange"):
        text = normalize_assessment_text(raw.get(key), f"issue.{key}")
        if text:
            issue[key] = text
    return issue


def normalize_assessment_finding(raw: Any, task_id: str, index: int) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise SwitchboardError("--finding-json entries must be JSON objects.")
    kind = normalize_assessment_text(raw.get("kind"), "finding.kind", required=True)
    if kind not in AGENT_ASSESSMENT_FINDING_KINDS:
        raise SwitchboardError(f"finding.kind must be one of: {', '.join(sorted(AGENT_ASSESSMENT_FINDING_KINDS))}.")
    severity = normalize_assessment_text(raw.get("severity"), "finding.severity", required=True)
    if severity not in AGENT_ASSESSMENT_FINDING_SEVERITIES:
        raise SwitchboardError(f"finding.severity must be one of: {', '.join(sorted(AGENT_ASSESSMENT_FINDING_SEVERITIES))}.")
    area = normalize_assessment_text(raw.get("area"), "finding.area", required=True)
    if area not in AGENT_ASSESSMENT_FINDING_AREAS:
        raise SwitchboardError(f"finding.area must be one of: {', '.join(sorted(AGENT_ASSESSMENT_FINDING_AREAS))}.")
    finding = {
        "id": normalize_assessment_text(raw.get("id"), "finding.id") or f"{task_id}-AF{index + 1}",
        "kind": kind,
        "severity": severity,
        "area": area,
        "title": normalize_assessment_text(raw.get("title"), "finding.title", required=True),
        "detail": normalize_assessment_text(raw.get("detail"), "finding.detail", required=True),
        "status": normalize_assessment_text(raw.get("status"), "finding.status") or "open",
    }
    for key in ("recommendation", "requirementId", "file"):
        text = normalize_assessment_text(raw.get(key), f"finding.{key}")
        if text:
            finding[key] = text
    return finding


def parse_assessment_json_entries(values: list[str], *, kind: str, task_id: str) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for index, raw_json in enumerate(values):
        try:
            raw = json.loads(raw_json)
        except json.JSONDecodeError as exc:
            raise SwitchboardError(f"--{kind}-json must be valid JSON: {exc.msg}") from exc
        normalizer = normalize_assessment_issue if kind == "issue" else normalize_assessment_finding
        entries.append(normalizer(raw, task_id, index))
    return entries


def find_attempt_by_execution_id(task: dict[str, Any], execution_id: str) -> dict[str, Any] | None:
    execution = task.get("execution") if isinstance(task.get("execution"), dict) else {}
    attempts = execution.get("attempts") if isinstance(execution.get("attempts"), list) else []
    for attempt in attempts:
        if isinstance(attempt, dict) and attempt.get("id") == execution_id:
            return attempt
    return None


def assess_agent(
    workspace: Path,
    task_id: str,
    *,
    target_execution_id: str,
    reviewer_agent_id: str | None = None,
    reviewer_role: str | None = None,
    reviewer_execution_id: str | None = None,
    target_agent_id: str | None = None,
    summary: str,
    scores: dict[str, int | None] | None = None,
    counts: dict[str, int | None] | None = None,
    top_friction: str | None = None,
    suggested_improvement: str | None = None,
    issue_json: list[str] | None = None,
    finding_json: list[str] | None = None,
) -> dict[str, Any]:
    validate_execution_id(target_execution_id)
    if reviewer_execution_id:
        validate_execution_id(reviewer_execution_id)
    summary_text = normalize_assessment_text(summary, "--summary", required=True, limit=2000)
    init_workspace(workspace)
    located = find_task(workspace, task_id)
    with locked_folders(workspace, [located.folder_status], owner="switchboard-cli"):
        located = find_task(workspace, task_id)
        attempt = find_attempt_by_execution_id(located.task, target_execution_id)
        if attempt is None:
            raise SwitchboardError("Target execution was not found in this task's execution attempts.")
        normalized_scores: dict[str, int] = {}
        json_scores: dict[str, int] = {}
        for input_key, value in (scores or {}).items():
            if input_key not in AGENT_ASSESSMENT_SCORE_FIELDS:
                continue
            state_key, json_key = AGENT_ASSESSMENT_SCORE_FIELDS[input_key]
            normalized = normalize_assessment_percent(value, f"--{input_key.replace('_', '-')}")
            if normalized is not None:
                normalized_scores[state_key] = normalized
                json_scores[json_key] = normalized
        normalized_counts: dict[str, int] = {}
        json_counts: dict[str, int] = {}
        for input_key, value in (counts or {}).items():
            if input_key not in AGENT_ASSESSMENT_COUNT_FIELDS:
                continue
            state_key, json_key = AGENT_ASSESSMENT_COUNT_FIELDS[input_key]
            normalized = normalize_assessment_count(value, f"--{input_key.replace('_', '-')}")
            if normalized is not None:
                normalized_counts[state_key] = normalized
                json_counts[json_key] = normalized
        now = now_iso()
        claim = located.task.get("claim") if isinstance(located.task.get("claim"), dict) else {}
        reviewer = reviewer_agent_id or (claim.get("owner") if isinstance(claim.get("owner"), str) else None) or "switchboard-reviewer"
        target_agent = target_agent_id or (attempt.get("agentId") if isinstance(attempt.get("agentId"), str) else None) or "unknown"
        assessment = {
            "schemaVersion": 1,
            "id": str(uuid.uuid4()),
            "targetExecutionId": target_execution_id,
            "targetAgentId": target_agent,
            "reviewerAgentId": reviewer,
            "reviewerRole": reviewer_role or "",
            "capturedAt": now,
            "source": "reviewer_assessment",
            "summary": summary_text,
        }
        if reviewer_execution_id:
            assessment["reviewerExecutionId"] = reviewer_execution_id
        if normalized_scores:
            assessment["scores"] = normalized_scores
        if normalized_counts:
            assessment["counts"] = normalized_counts
        friction = normalize_assessment_text(top_friction, "--top-friction", limit=500) if top_friction else ""
        if friction:
            assessment["topFriction"] = friction
        improvement = normalize_assessment_text(suggested_improvement, "--suggested-improvement", limit=500) if suggested_improvement else ""
        if improvement:
            assessment["suggestedImprovement"] = improvement
        issues = parse_assessment_json_entries(issue_json or [], kind="issue", task_id=task_id)
        findings = parse_assessment_json_entries(finding_json or [], kind="finding", task_id=task_id)
        if issues:
            assessment["issues"] = issues
        if findings:
            assessment["findings"] = findings

        execution_state = dict(located.task.get("execution", {}))
        assessments = list(execution_state.get("assessments", [])) if isinstance(execution_state.get("assessments"), list) else []
        assessments.append(assessment)
        task = {
            **located.task,
            "execution": {**execution_state, "assessments": assessments},
            "updatedAt": now,
        }
        atomic_write_json(located.path, task)
        record = {
            "schema_version": 1,
            "workspace_root": str(workspace.expanduser().resolve()),
            "task_id": task_id,
            "target_execution_id": target_execution_id,
            "target_agent_id": target_agent,
            "reviewer_agent_id": reviewer,
            "reviewer_role": reviewer_role or "",
            "reviewer_execution_id": reviewer_execution_id,
            "captured_at": now,
            "source": "reviewer_assessment",
            "scores": json_scores,
            "counts": json_counts,
            "summary": summary_text,
        }
        if friction:
            record["top_friction"] = friction
        if improvement:
            record["suggested_improvement"] = improvement
        if issues:
            record["issues"] = issues
        if findings:
            record["findings"] = findings
        metrics_path = append_agent_feedback_record(workspace, record)
        append_runner_event(
            workspace,
            "agent_assessment",
            data={"taskId": task_id, "targetExecutionId": target_execution_id, "reviewerAgentId": reviewer, "assessmentId": assessment["id"]},
        )
        return {
            "ok": True,
            "record": record_for_output(read_task_file(located.path, located.folder_status)),
            "assessment": assessment,
            "metricsPath": metrics_path,
        }


def record_for_output(located: LocatedTask) -> dict[str, Any]:
    return {
        "task": located.task,
        "location": {"folderStatus": located.folder_status, "path": str(located.path)},
        "warnings": located.warnings,
    }
