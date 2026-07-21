"""Sprint Engine CLI constants."""

from __future__ import annotations

# Single-owner lifecycle (MC-1542). `review` means "the owner is reviewing the work
# it just made, in the same session". `changes_requested`, `testing`, and `product`
# were deleted outright — there is no read-side tolerance for them (decision 8).
VALID_TASK_STATUSES = {"todo", "in_progress", "review", "needs_input", "done", "canceled"}
# Statuses in which a task is OWNED by a live agent. `review` belongs here: the
# owner stays bound to its task from claim through `done`, so a task in review is
# not free for another agent to claim, and its owner's session is not spare capacity.
ACTIVE_TASK_STATUSES = {"in_progress", "review", "needs_input"}
RUN_EXECUTING_TASK_STATUSES = set(ACTIVE_TASK_STATUSES)
# Post-implementation phase vocabulary (MC-1542). MIRRORS
# sprintengine_core.store.VALID_TASK_PHASES / DEFAULT_RUN_PHASES; the two cannot be
# a single import (store <-> tool import cycle), so
# tests/sprintengine_tool/test_task_lifecycle.py pins them equal. The renderer's
# copy in src/renderer/src/utils/sprintengine.ts is pinned by the same class of test.
VALID_TASK_PHASES = ("review",)
DEFAULT_RUN_PHASES = ("review",)
VALID_PHASE_OUTCOMES = {"pass", "pass_with_fixes", "escalate"}
VALID_TASK_COMMENT_TYPES = {
    "implementation_summary",
    "implementation_response",
    "review_feedback",
    "test_feedback",
    "product_feedback",
    "architect_feedback",
    "needs_input",
    "user_note",
    "system_note",
}
VALID_TASK_SOURCE_TYPES = {"local", "github", "jira", "linear"}
VALID_TASK_SOURCE_SYNC_STATUSES = {"clean", "local_changed", "remote_changed", "conflict"}
# Two lanes, not three (MC-1585): `architect` is the PLANNER-ROUTED lane — it means
# "the role that plans this run", which `plans.resolve_planning_role` answers
# (architect if rostered, else general). A general-only run therefore needs no
# `general` lane of its own; widening what the existing kind MEANS beats adding a
# parallel enum value that every consumer would have to learn.
# The wire value stays `architect` deliberately: it is read by the renderer, the
# agent prompts, and every run.yaml already on disk, none of which this change
# owns. `planner` is accepted as an input alias and normalized to it, so agents in
# a general-only run can escalate in the vocabulary their prompt gives them.
VALID_NEEDS_INPUT_KINDS = {"architect", "user"}
LEGACY_NEEDS_INPUT_KIND_MAP = {
    "owner": ("architect", "blocked_other"),
    "external_validation": ("user", "verification"),
    "planner": ("architect", "task_scope"),
}
VALID_NEEDS_INPUT_REASONS = {
    "task_scope",
    "artifact_review",
    "tooling",
    "verification",
    "product_decision",
    "blocked_other",
}
NEEDS_INPUT_KIND_DEFAULT_REASONS = {
    "architect": "task_scope",
    "user": "product_decision",
}
# What a CALLER may pass (CLI `--needs-input-kind`, MCP `needsInputKind`), as opposed
# to what is STORED (`VALID_NEEDS_INPUT_KINDS`). `planner` is the only advertised
# alias — an agent on a general-only run reasonably reaches for it, and
# `normalize_needs_input_kind` folds it to the canonical `architect`. The other
# entries in the legacy map are read-side compatibility for old stores and stay
# unadvertised.
NEEDS_INPUT_KIND_INPUT_CHOICES = sorted(VALID_NEEDS_INPUT_KINDS | {"planner"})
# The needs_input kinds that route to the run's PLANNER (not literally to an
# architect — see the lane note above). Resolve the actor with
# `plans.resolve_planning_role`, never by comparing a role to "architect".
PLANNER_ROUTED_NEEDS_INPUT_KINDS = {"architect"}
# Legacy alias: the old name said "architect" when it meant "planner", which is the
# assumption that dead-ended general-only runs. Kept so out-of-tree importers work.
ARCHITECT_ROUTED_NEEDS_INPUT_KINDS = PLANNER_ROUTED_NEEDS_INPUT_KINDS
VALID_ARTIFACT_KINDS = {
    "architect_plan",
    "product_strategy",
    "requirements",
    "html_mockup",
    "design_notes",
    "branding",
    "security_review",
    "code_review",
    "spec_review",
    "performance_review",
    "production_readiness_review",
    "cross_platform_review",
    "validation_report",
    "integration_proof",
}
VALID_ARTIFACT_STATUSES = {"draft", "recorded", "ready_for_review", "approved", "changes_requested", "superseded"}
# Provenance of an artifact approval: `manual` = a human approved it, `policy` =
# the run's auto-approval policy approved it. Optional and additive; a legacy
# artifact approved before this field existed simply omits it and reads as plain
# approved.
VALID_APPROVAL_MODES = {"manual", "policy"}
# `epic` is a root plan kind only (a backlog epic launched as a reference-based
# sprint). Children of the epic are recorded as bundle items with their own leaf
# kinds, never `epic`, so `epic` is deliberately excluded from the bundle kinds.
VALID_SOURCE_PLAN_KINDS = {"unknown", "product_plan", "architect_plan", "epic"}
VALID_SOURCE_BUNDLE_KINDS = {"unknown", "product_plan", "architect_plan", "html_mockup", "design_notes", "generic_context"}
APPROVAL_BLOCKING_ARTIFACT_STATUSES = VALID_ARTIFACT_STATUSES - {"superseded"}
FEEDBACK_SCHEMA_VERSION = 4
FEEDBACK_SCORE_FIELDS = [
    ("directive_clarity_pct", "directiveClarityPct", "directive_clarity_pct"),
    ("task_clarity_pct", "taskClarityPct", "task_clarity_pct"),
    ("acceptance_criteria_clarity_pct", "acceptanceCriteriaClarityPct", "acceptance_criteria_clarity_pct"),
    ("sprintengine_tool_effectiveness_pct", "swarmToolEffectivenessPct", "sprintengine_tool_effectiveness_pct"),
    ("prompt_optimization_pct", "promptOptimizationPct", "prompt_optimization_pct"),
    ("context_fit_pct", "contextFitPct", "context_fit_pct"),
    ("hallucination_risk_pct", "hallucinationRiskPct", "hallucination_risk_pct"),
    ("role_fit_pct", "roleFitPct", "role_fit_pct"),
    ("autonomy_pct", "autonomyPct", "autonomy_pct"),
    ("confidence_pct", "confidencePct", "confidence_pct"),
    ("correctness_pct", "correctnessPct", "correctness_pct"),
    ("evidence_quality_pct", "evidenceQualityPct", "evidence_quality_pct"),
    ("instruction_following_pct", "instructionFollowingPct", "instruction_following_pct"),
    ("code_quality_pct", "codeQualityPct", "code_quality_pct"),
    ("maintainability_pct", "maintainabilityPct", "maintainability_pct"),
    ("test_quality_pct", "testQualityPct", "test_quality_pct"),
    ("security_quality_pct", "securityQualityPct", "security_quality_pct"),
    ("performance_quality_pct", "performanceQualityPct", "performance_quality_pct"),
    ("frontend_functionality_pct", "frontendFunctionalityPct", "frontend_functionality_pct"),
    ("frontend_aesthetic_quality_pct", "frontendAestheticQualityPct", "frontend_aesthetic_quality_pct"),
    ("accessibility_pct", "accessibilityPct", "accessibility_pct"),
    ("ux_competitiveness_pct", "uxCompetitivenessPct", "ux_competitiveness_pct"),
]
FEEDBACK_COUNT_FIELDS = [
    ("claims_checked", "claimsChecked", "claims_checked"),
    ("hallucinated_claims", "hallucinatedClaims", "hallucinated_claims"),
    ("factual_errors", "factualErrors", "factual_errors"),
    ("implementation_mistakes", "implementationMistakes", "implementation_mistakes"),
    ("missed_requirements", "missedRequirements", "missed_requirements"),
    ("regression_count", "regressionCount", "regression_count"),
    ("test_failures_introduced", "testFailuresIntroduced", "test_failures_introduced"),
    ("unsafe_changes", "unsafeChanges", "unsafe_changes"),
    ("accessibility_issues", "accessibilityIssues", "accessibility_issues"),
    ("design_issues", "designIssues", "design_issues"),
]
FEEDBACK_TEXT_FIELDS = [
    ("top_friction", "topFriction", "top_friction"),
    ("suggested_improvement", "suggestedImprovement", "suggested_improvement"),
]
FEEDBACK_TEXT_LIMIT = 500
FEEDBACK_ISSUE_TEXT_LIMIT = 1000
VALID_FEEDBACK_ISSUE_CATEGORIES = {
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
VALID_FEEDBACK_ISSUE_SEVERITIES = {"low", "medium", "high"}
VALID_FEEDBACK_ISSUE_STATUSES = {"new", "reviewed", "applied", "rejected", "deferred"}
VALID_FEEDBACK_FINDING_KINDS = {
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
VALID_FEEDBACK_FINDING_SEVERITIES = {"critical", "high", "medium", "low"}
VALID_FEEDBACK_FINDING_AREAS = {
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
VALID_FEEDBACK_FINDING_STATUSES = {"open", "accepted", "fixed", "rejected", "deferred"}
VALID_DIFFICULTY_REVIEWER_DIMENSIONS = {
    "implementation",
    "review",
    "verification",
    "product_spec",
    "security",
    "performance",
    "coordination",
}
VALID_VCS_STATUSES = {"not_created", "ready", "dirty", "committed", "pushed", "pr_opened", "failed"}
