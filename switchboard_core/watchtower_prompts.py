from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .store import SwitchboardError


@dataclass(frozen=True)
class WatchtowerSector:
    id: str
    label: str
    description: str


SPECIALIST_SOUL_ROLES = {
    "architect": "architect",
    "product-strategist": "product",
    "developer": "developer",
    "devops-infra": "devops",
    "performance": "performance",
    "blog-writer": "blog_writer",
    "frontend-design-review": "frontend",
    "qa-test": "tester",
    "security-review": "security",
    "code-review": "code_reviewer",
}

SPECIALIST_SHORT_LABELS = {
    "architect": "Architect",
    "product-strategist": "Product Strategist",
    "developer": "Developer",
    "devops-infra": "DevOps",
    "performance": "Performance Engineer",
    "blog-writer": "Blog Writer",
    "frontend-design-review": "Frontend Designer",
    "qa-test": "QA Specialist",
    "security-review": "Security Specialist",
    "code-review": "AI Slop Reviewer",
}

WATCHTOWER_REVIEW_SECTORS = [
    WatchtowerSector("code_review", "Code Review", "Bugs, regressions, maintainability, unsafe assumptions, and missing tests."),
    WatchtowerSector("ai_slop", "AI Slop", "Generic boilerplate, fake affordances, hallucinated APIs, dead UI, and shallow abstractions."),
    WatchtowerSector("architecture_quality", "Architecture", "Boundaries, state ownership, data flow, dependency direction, and migration safety."),
    WatchtowerSector("frontend_design", "Frontend Design", "Layout, hierarchy, interaction states, responsiveness, and visual polish."),
    WatchtowerSector("cross_platform", "Cross Platform", "Windows, macOS, Linux, shell, path, packaging, and WSL assumptions."),
    WatchtowerSector("brand_alignment", "Brand Alignment", "Knowledge-graph brand guidance, UI surfaces, modals, panels, product naming, copy, palette discipline, and consistency with adjacent product surfaces."),
    WatchtowerSector("security", "Security", "Trust boundaries, command execution, filesystem access, IPC, auth, secrets, and unsafe defaults."),
    WatchtowerSector("performance", "Performance", "Startup, render churn, terminal scaling, scans, memory growth, bundle size, and polling."),
    WatchtowerSector("qa_testing", "QA Testing", "Coverage, release readiness, fixtures, edge cases, and regression risk."),
    WatchtowerSector("infrastructure", "Infrastructure", "Packaging, CI, diagnostics, logging, updates, observability, and environment assumptions."),
    WatchtowerSector("product_strategy", "Product Strategy", "Workflow clarity, user value, prioritization, scope fit, and operator confusion."),
    WatchtowerSector("accessibility", "Accessibility", "Focus, labels, keyboard navigation, semantic structure, contrast, and reduced motion."),
    WatchtowerSector("documentation", "Documentation", "User docs, setup docs, command examples, stale docs, and handoff quality."),
]
SECTORS_BY_ID = {sector.id: sector for sector in WATCHTOWER_REVIEW_SECTORS}

WATCHTOWER_REVIEW_PRESETS = {
    "lean_code_review": {
        "code-review": ["code_review", "ai_slop"],
        "qa-test": ["qa_testing"],
        "performance": ["performance"],
    },
    "ui_brand_alignment_review": {
        "frontend-design-review": ["frontend_design", "brand_alignment", "accessibility", "cross_platform"],
        "product-strategist": ["brand_alignment", "product_strategy"],
        "code-review": ["ai_slop"],
    },
    "performance_focused_review": {
        "performance": ["performance", "cross_platform"],
        "devops-infra": ["infrastructure", "performance", "cross_platform"],
        "code-review": ["code_review", "architecture_quality"],
        "qa-test": ["qa_testing"],
    },
    "security_deep_review": {
        "security-review": ["security"],
        "code-review": ["ai_slop", "code_review"],
        "qa-test": ["qa_testing"],
    },
    "full_product_review": {
        "product-strategist": ["product_strategy"],
        "frontend-design-review": ["frontend_design", "accessibility", "brand_alignment"],
        "qa-test": ["qa_testing", "cross_platform"],
        "security-review": ["security"],
        "performance": ["performance"],
        "code-review": ["code_review", "ai_slop", "architecture_quality"],
        "devops-infra": ["infrastructure"],
    },
    "custom": {},
}


def specialist_short_label(specialist_id: str | None) -> str:
    return SPECIALIST_SHORT_LABELS.get(specialist_id or "", "Specialist")


def soul_fetch_instructions(specialist_id: str) -> str:
    role = SPECIALIST_SOUL_ROLES.get(specialist_id)
    if not role:
        raise SwitchboardError(f"Unknown Watchtower specialist: {specialist_id}")
    return "\n".join(
        [
            "Fetch your Soul from the Souls CLI before doing any role-specific work.",
            "",
            f"First try: `souls get {role}`.",
            "",
            "If `souls` is not on PATH, use the command form for your shell:",
            "",
            "```powershell",
            f".\\scripts\\souls.cmd get {role}",
            "```",
            "",
            "```bash",
            f"scripts/souls get {role}",
            "```",
            "",
            "If the wrapper is unavailable but Python can import the local repo package, run:",
            "",
            "```powershell",
            f"python -m souls get {role}",
            "```",
            "",
            "```bash",
            f"python3 -m souls get {role}",
            "```",
            "",
            "Treat the returned text as your role, judgment, and quality bar.",
            "",
            "Only if all of those commands fail, stop and report that the Souls CLI is unavailable instead of guessing the role prompt.",
        ]
    )


def selected_agents_for_preset(preset: str) -> list[dict[str, Any]]:
    if preset not in WATCHTOWER_REVIEW_PRESETS:
        raise SwitchboardError(f"Unknown Watchtower preset: {preset}")
    return [
        {"specialistId": specialist_id, "sectors": sectors}
        for specialist_id, sectors in WATCHTOWER_REVIEW_PRESETS[preset].items()
        if sectors
    ]


def sector_label(sector_id: str) -> str:
    return SECTORS_BY_ID.get(sector_id, WATCHTOWER_REVIEW_SECTORS[0]).label


def sector_instructions(sectors: list[str]) -> list[str]:
    lines: list[str] = []
    for sector_id in sectors:
        sector = SECTORS_BY_ID.get(sector_id)
        if sector:
            lines.append(f"{sector.label}: {sector.description}")
    return lines


def task_labels_for_sectors(sectors: list[str]) -> list[str]:
    labels = {"watchtower"}
    for sector in sectors:
        labels.add(sector.replace("_", "-"))
    if "brand_alignment" in sectors:
        labels.add("ui")
    if "frontend_design" in sectors:
        labels.add("frontend")
    if "security" in sectors:
        labels.add("security")
    if "performance" in sectors:
        labels.add("performance")
    return sorted(labels)


def relative_path(path: str, root_path: str) -> str:
    try:
        return str(Path(path).resolve().relative_to(Path(root_path).resolve()))
    except ValueError:
        return path


def brand_context_instructions(sectors: list[str]) -> list[str]:
    if "brand_alignment" not in sectors:
        return []
    return [
        "",
        "# Brand Alignment Context",
        "",
        "Before creating brand-alignment findings, inspect the repo-local knowledge graph for brand guidance. Start with `knowledge/brand/BRAND.md`, then check `knowledge/brand/panel-design-system.md`, `knowledge/brand/workspace-themes.md`, and `knowledge/multicode/watchtower.md` when present.",
        "If no brand guideline exists in the knowledge graph for this workspace, infer the current brand from implemented panels and adjacent UI surfaces instead of inventing a new direction.",
        "For UI and brand review, sweep the full application surface you can reach from the codebase: panels, modal/dialog flows, model pickers/configuration surfaces, forms, empty/loading/error/disabled states, navigation, command surfaces, copy tone, color usage, spacing, typography, icons, and responsive behavior.",
        "Findings must cite the violated brand guideline path when one exists. When using inferred brand instead, say which existing panels or UI files established the pattern.",
    ]


def build_watchtower_review_prompt(
    *,
    run: dict[str, Any],
    agent: dict[str, Any],
    sectors: list[str],
    workspace_root: Path,
    output_directory: str,
    report_path: str,
) -> str:
    workspace_text = str(workspace_root.expanduser().resolve())
    specialist_id = str(agent.get("specialistId") or "")
    agent_id = str(agent.get("agentId") or "")
    task_payload = {
        "title": "Short actionable task title",
        "description": "Concrete context, evidence, project-root-relative file paths, impact, and expected outcome.",
        "priority": 1,
        "labels": task_labels_for_sectors(sectors),
        "source": {
            "type": "watchtower",
            "externalId": f"{run['runId']}:{agent_id}:<random-uuid>",
            "externalKey": f"{run['runId']}:{agent_id}",
            "externalUrl": None,
        },
    }
    return "\n".join(
        [
            soul_fetch_instructions(specialist_id),
            "",
            "# Watchtower Review Assignment",
            "",
            f"Run ID: {run['runId']}",
            f"Preset: {run['preset']}",
            f"Assigned sectors: {', '.join(sector_label(sector) for sector in sectors)}",
            f"Workspace root: {workspace_text}",
            f"Agent ID: {agent_id}",
            f"Optional Markdown report: {relative_path(report_path, workspace_text)}",
            f"Output directory: {relative_path(output_directory, workspace_text)}",
            "",
            "Work read-only unless the user explicitly asks for fixes. Do not edit product code, Switchboard task files, inbox files, Lock files, runner state, or Watchtower run metadata by hand.",
            "For each concrete finding, create a Switchboard inbox task directly with the Switchboard CLI. Do not write proposed-task JSON, JSONL, or output files for later ingestion.",
            "Before creating the first task, run `switchboard create --help` or `scripts/switchboard create --help` from the repository root to confirm the current schema.",
            "Use project-root-relative paths in descriptions and evidence. Include concrete files, symptoms, impact, and expected outcome.",
            "",
            "# Task Creation Contract",
            "",
            "Create one inbox task per finding. Prefer `switchboard` when it is on PATH; otherwise use `scripts/switchboard`.",
            "",
            "```bash",
            f"switchboard create --workspace {json.dumps(workspace_text)} --inbox --input-json '<json-payload>'",
            "```",
            "",
            "Use this JSON payload shape:",
            "",
            "```json",
            json.dumps(task_payload, indent=2),
            "```",
            "",
            "The CLI generates the task UUID, validates the task shape, locks the inbox folder, and writes `.multi-code/switchboard/inbox/<uuid>.json` atomically.",
            "If a task creation command fails, read stderr, correct the payload, and retry. Do not hand-write Switchboard task files.",
            "",
            "# Sector Checklist",
            "",
            *[f"- {line}" for line in sector_instructions(sectors)],
            *brand_context_instructions(sectors),
        ]
    )


def build_watchtower_triage_prompt(
    *,
    run: dict[str, Any],
    workspace_root: Path,
    tasks: list[dict[str, Any]],
    scope_label: str,
) -> str:
    workspace_text = str(workspace_root.expanduser().resolve())
    task_lines = [
        f"- {record['task']['id']} ({record['task']['identifier']}): {record['task']['title']}"
        for record in tasks
        if isinstance(record.get("task"), dict)
    ]
    task_ids = [record["task"]["id"] for record in tasks if isinstance(record.get("task"), dict)]
    return "\n".join(
        [
            soul_fetch_instructions("architect"),
            "",
            "# Watchtower Inbox Triage Assignment",
            "",
            f"Run ID: {run['runId']}",
            "Preset: inbox_triage",
            f"Workspace root: {workspace_text}",
            f"Scope: {scope_label}",
            "",
            "You are triaging existing Switchboard inbox items. Read each scoped item, compare it with the rest of the inbox and board, inspect relevant repo context, and leave exactly one triage comment on each scoped item.",
            "After commenting on one scoped item, continue to the next scoped item. When every scoped item has a triage comment, stop.",
            "",
            "# Scoped Items",
            "",
            *task_lines,
            "",
            "# Read Contract",
            "",
            "Use project-root-relative paths in all analysis. Prefer the local Switchboard CLI from the repository root:",
            "",
            "```bash",
            f"scripts/switchboard read-all --workspace {json.dumps(workspace_text)}",
            "scripts/switchboard show --workspace <repo> <task-id>",
            "```",
            "",
            "Check duplicate candidates across inbox tasks and board tasks. Include likely duplicates only when the overlap is concrete enough to help a human decide.",
            "",
            "# Mutation Contract",
            "",
            "You may only add triage comments through the Switchboard CLI. Do not promote, cancel, move, claim, publish, edit, or requeue tasks. Do not edit task JSON, inbox files, Lock files, runner state, or Watchtower run metadata by hand.",
            "For each scoped item, write the comment with:",
            "",
            "```bash",
            f"scripts/switchboard comment --workspace {json.dumps(workspace_text)} <task-id> --kind triage --author Architect --author-type agent --author-id watchtower-architect --body '<comment-body>'",
            "```",
            "",
            "# Triage Comment Format",
            "",
            "Use this exact heading and fields for every triage comment:",
            "",
            "```text",
            "Architect triage",
            "",
            "Recommendation: Promote | Needs clarification | Duplicate | Defer | Reject",
            "Importance: Critical | High | Medium | Low",
            "",
            "Why it matters:",
            "...",
            "",
            "Impact if not fixed:",
            "...",
            "",
            "Implementation plan:",
            "1. ...",
            "2. ...",
            "",
            "Likely touched areas:",
            "- ...",
            "",
            "Duplicate check:",
            "None found | Possible duplicate of <identifier/title> because ...",
            "",
            "Verification:",
            "- ...",
            "```",
            "",
            "# Completion",
            "",
            f"Scoped task ids: {', '.join(task_ids) or '(none)'}",
            "If there are no scoped task ids, add no comments and report that there was nothing to triage.",
        ]
    )
