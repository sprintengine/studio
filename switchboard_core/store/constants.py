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

"""Switchboard constants, status transitions, and validation sets."""

TASK_STATUSES = (
    "planning",
    "todo",
    "ready",
    "in_progress",
    "testing",
    "testing_in_progress",
    "review",
    "review_in_progress",
    "done",
    "canceled",
)
FOLDER_STATUSES = ("inbox", *TASK_STATUSES)
CLAIMABLE_STATUSES = ("ready", "testing", "review")
PUBLISH_TARGETS = ("testing", "review", "done")
RUNNER_PROVIDERS = ("electron-session",)
RUNNER_EVENTS = {
    "start",
    "pause",
    "resume",
    "run",
    "stop",
    "tick",
    "claim",
    "launch",
    "warning",
    "provider_error",
    "provider_execution_untracked",
    "execution_missing",
    "execution_stale",
    "execution_link_failed",
    "execution_exit",
    "task_published",
    "task_abandoned",
    "execution_stopped",
    "requeue",
    "worktree_created",
    "worktree_cleaned",
    "worktree_missing",
    "agent_assessment",
}
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

MOVE_TRANSITIONS: dict[str, set[str]] = {
    "planning": {"todo", "canceled"},
    "todo": {"planning", "ready", "canceled"},
    "ready": {"todo", "in_progress", "canceled"},
    "in_progress": {"ready", "testing", "canceled"},
    "testing": {"in_progress", "testing_in_progress", "canceled"},
    "testing_in_progress": {"testing", "review", "canceled"},
    "review": {"testing", "review_in_progress", "canceled"},
    "review_in_progress": {"review", "done", "canceled"},
    "done": {"review", "canceled"},
    "canceled": set(),
}
CLAIM_TRANSITIONS = {
    "ready": "in_progress",
    "testing": "testing_in_progress",
    "review": "review_in_progress",
}
PUBLISH_TRANSITIONS = {
    "in_progress": "testing",
    "testing_in_progress": "review",
    "review_in_progress": "done",
}
REQUEUE_TRANSITIONS = {
    "in_progress": "ready",
    "testing_in_progress": "testing",
    "review_in_progress": "review",
}
REQUEST_CHANGES_TRANSITIONS = {
    "testing_in_progress": "ready",
    "review_in_progress": "ready",
}
SOURCE_TYPES = {"manual", "watchtower", "github", "jira", "campaign", "sprintengine"}
COMMENT_KINDS = {"comment", "status_change", "claim", "evidence", "import", "triage"}
AUTHOR_TYPES = {"user", "agent", "system"}
AGENT_ASSESSMENT_SCORE_FIELDS = {
    "correctness_pct": ("correctnessPct", "correctness_pct"),
    "evidence_quality_pct": ("evidenceQualityPct", "evidence_quality_pct"),
    "instruction_following_pct": ("instructionFollowingPct", "instruction_following_pct"),
    "context_fit_pct": ("contextFitPct", "context_fit_pct"),
    "autonomy_pct": ("autonomyPct", "autonomy_pct"),
    "role_fit_pct": ("roleFitPct", "role_fit_pct"),
    "code_quality_pct": ("codeQualityPct", "code_quality_pct"),
    "maintainability_pct": ("maintainabilityPct", "maintainability_pct"),
    "test_quality_pct": ("testQualityPct", "test_quality_pct"),
    "security_quality_pct": ("securityQualityPct", "security_quality_pct"),
    "performance_quality_pct": ("performanceQualityPct", "performance_quality_pct"),
    "frontend_functionality_pct": ("frontendFunctionalityPct", "frontend_functionality_pct"),
    "frontend_aesthetic_quality_pct": ("frontendAestheticQualityPct", "frontend_aesthetic_quality_pct"),
    "accessibility_pct": ("accessibilityPct", "accessibility_pct"),
    "ux_competitiveness_pct": ("uxCompetitivenessPct", "ux_competitiveness_pct"),
    "confidence_pct": ("confidencePct", "confidence_pct"),
}
AGENT_ASSESSMENT_COUNT_FIELDS = {
    "claims_checked": ("claimsChecked", "claims_checked"),
    "hallucinated_claims": ("hallucinatedClaims", "hallucinated_claims"),
    "factual_errors": ("factualErrors", "factual_errors"),
    "implementation_mistakes": ("implementationMistakes", "implementation_mistakes"),
    "missed_requirements": ("missedRequirements", "missed_requirements"),
    "regression_count": ("regressionCount", "regression_count"),
    "test_failures_introduced": ("testFailuresIntroduced", "test_failures_introduced"),
    "unsafe_changes": ("unsafeChanges", "unsafe_changes"),
    "accessibility_issues": ("accessibilityIssues", "accessibility_issues"),
    "design_issues": ("designIssues", "design_issues"),
}
AGENT_ASSESSMENT_ISSUE_CATEGORIES = {
    "system_prompt",
    "role_prompt",
    "task_card",
    "acceptance_criteria",
    "context",
    "tooling",
    "coordination",
    "validation",
    "permissions",
    "ui",
    "other",
}
AGENT_ASSESSMENT_ISSUE_SEVERITIES = {"low", "medium", "high"}
AGENT_ASSESSMENT_FINDING_KINDS = {
    "code_bug",
    "security_issue",
    "product_requirement_violation",
    "test_gap",
    "accessibility_issue",
    "performance_issue",
    "reliability_issue",
    "documentation_gap",
    "other",
}
AGENT_ASSESSMENT_FINDING_SEVERITIES = {"critical", "high", "medium", "low"}
AGENT_ASSESSMENT_FINDING_AREAS = {
    "frontend",
    "backend",
    "database",
    "networking",
    "auth",
    "security",
    "filesystem",
    "cli",
    "ipc",
    "mobile",
    "testing",
    "performance",
    "docs",
    "product",
    "other",
}
STALE_LOCK_SECONDS = 5 * 60
STALE_RUNNER_LOCK_SECONDS = 2 * 60
EXECUTION_ID_RE = re.compile(r"^exec_[A-Za-z0-9_-]+$")
