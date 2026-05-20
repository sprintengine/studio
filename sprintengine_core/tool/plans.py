"""Plan, source bundle, approval gate, and summary helpers."""
from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from sprintengine_core.tool.artifacts import *  # noqa: F403,F401
from sprintengine_core.tool.common import unique_strings
from sprintengine_core.tool.constants import *  # noqa: F403,F401
from sprintengine_core.tool.paths import MULTICODE_DIR_NAME, SPRINTENGINE_DIR_NAME, now_iso
from sprintengine_core.tool.prompts import compose_prompt, load_soul_prompt
from sprintengine_core.tool.roles import plan_review_role_ids
from sprintengine_core.tool.state import *  # noqa: F403,F401
from sprintengine_core.tool.tasks import *  # noqa: F403,F401

PLAN_REVIEW_FOCUS = {
    "product": "scope fit, user value, prioritization, adoption risk, and missing requirements",
    "developer": "implementation sequence, integration risk, data flow, backend/API impact, and owned paths",
    "frontend": "interaction design, UI architecture, accessibility, responsive behavior, and user workflow",
    "tester": "test strategy, acceptance criteria, regression coverage, edge cases, and release confidence",
    "security": "trust boundaries, command safety, secrets, permissions, abuse cases, and hardening",
    "code_reviewer": "code correctness, integration risk, maintainability, regressions, and evidence quality",
    "spec_reviewer": "specification conformance, acceptance coverage, behavioral gaps, and verification completeness",
    "performance": "latency, CPU, memory, bundle/runtime resource use, measurement quality, and likely bottlenecks",
}

def plan_path_artifact_value(state_path: Path) -> str:
    return normalize_artifact_path(state_path, "plan.md")["path"]

def product_intake_path_artifact_value(state_path: Path) -> str:
    return normalize_artifact_path(state_path, "product-requirements.md")["path"]

def product_intake_handover_note(state_path: Path) -> Optional[str]:
    handover_path = handover_path_for_state(state_path)
    if not handover_path.exists():
        return None
    handover_path_value = project_relative_display_path(state_path, handover_path)
    return f"Read `{handover_path_value}` as incoming context before writing product-requirements.md."

def source_plan_kind(state: Dict[str, Any]) -> str:
    source = state.get("source")
    if not isinstance(source, dict):
        return "unknown"
    value = str(source.get("planKind") or "unknown").strip()
    return value if value in VALID_SOURCE_PLAN_KINDS else "unknown"

def source_bundle_items(state: Dict[str, Any], kind: Optional[str] = None) -> List[Dict[str, Any]]:
    raw = state.get("sourceBundle")
    if not isinstance(raw, list):
        return []
    items = [item for item in raw if isinstance(item, dict)]
    if kind is None:
        return items
    return [item for item in items if item.get("kind") == kind]

def state_has_source_kind(state: Dict[str, Any], kind: str) -> bool:
    if source_bundle_items(state, kind):
        return True
    return source_plan_kind(state) == kind

def source_path_for_kind(state: Dict[str, Any], state_path: Path, kind: str) -> Path:
    bundle_item = next(iter(source_bundle_items(state, kind)), None)
    if bundle_item:
        item_path = str(bundle_item.get("path") or "").strip()
        if item_path:
            return artifact_absolute_path(state_path, item_path)
    return handover_path_for_state(state_path)

def import_source_to_team_file(state: Dict[str, Any], state_path: Path, kind: str, filename: str) -> bool:
    source_path = source_path_for_kind(state, state_path, kind)
    if not source_path.is_file():
        return False
    destination = state_path.parent / filename
    if destination.exists():
        return False
    destination.write_text(source_path.read_text(encoding="utf-8").rstrip() + "\n", encoding="utf-8")
    return True

def refresh_artifact_fingerprint(artifact: Dict[str, Any], state_path: Path) -> None:
    if artifact.get("status") == "approved":
        return
    absolute_path = artifact_absolute_path(state_path, str(artifact.get("path", "")))
    fingerprint = file_fingerprint(absolute_path)
    if artifact.get("fingerprint") == fingerprint:
        return
    artifact["fingerprint"] = fingerprint
    artifact["updatedAt"] = now_iso()

def source_bundle_reference_notes(state: Dict[str, Any]) -> List[str]:
    notes: List[str] = []
    for item in source_bundle_items(state):
        kind = str(item.get("kind") or "").strip()
        path = str(item.get("path") or "").strip()
        if not path:
            continue
        if kind == "html_mockup":
            notes.append(
                f"Use source mockup `{path}` as the primary UI reference for relevant frontend/UI tasks. "
                "Put this path in those tasks' implementationNotes, not ownedPaths, unless the mockup itself must be edited."
            )
        elif kind == "design_notes":
            notes.append(
                f"Use design notes `{path}` as reference for relevant UI/frontend tasks. "
                "Put this path in those tasks' implementationNotes, not ownedPaths, unless the notes themselves must be edited."
            )
        elif kind in {"generic_context", "unknown"}:
            notes.append(f"Review source context `{path}` before creating affected task cards.")
    return notes

def find_architect_plan_gate(state: Dict[str, Any], state_path: Path) -> Dict[str, Any]:
    plan_path_value = plan_path_artifact_value(state_path)
    plan_task = None
    plan_artifact = None

    for artifact in state.setdefault("artifacts", []):
        if not isinstance(artifact, dict):
            continue
        if (
            artifact.get("kind") == "architect_plan"
            and artifact.get("path") == plan_path_value
            and artifact.get("status") != "superseded"
        ):
            plan_artifact = artifact
            plan_task = find_task_by_id(state, artifact.get("taskId"))
            break

    if plan_task is None:
        candidate = find_task_by_id(state, "T0")
        if candidate and candidate.get("role") == "architect":
            plan_task = candidate

    return {"task": plan_task, "artifact": plan_artifact}

def ensure_product_intake_gate(state: Dict[str, Any], state_path: Path, actor: str = "product") -> Dict[str, Any]:
    requirements_path_value = product_intake_path_artifact_value(state_path)
    handover_note = product_intake_handover_note(state_path)
    product_task = None
    product_artifact = None

    for artifact in state.setdefault("artifacts", []):
        if not isinstance(artifact, dict):
            continue
        if (
            artifact.get("kind") in {"product_strategy", "requirements"}
            and artifact.get("path") == requirements_path_value
            and artifact.get("status") != "superseded"
        ):
            product_artifact = artifact
            product_task = find_task_by_id(state, artifact.get("taskId"))
            break

    if product_task is None:
        candidate = find_task_by_id(state, "T0")
        if candidate and candidate.get("role") == "product":
            product_task = candidate

    if product_task is None:
        task_id = "T0" if "T0" not in task_ids(state) else next_task_id(state.get("tasks", []))
        implementation_notes = [
            "Write the artifact at product-requirements.md in the active Sprint Engine team folder.",
            "Use the existing requirements artifact created by sprintengine init; mark it ready after the file exists.",
        ]
        if handover_note:
            implementation_notes.insert(0, handover_note)
        product_task = normalize_task({
            "id": task_id,
            "title": "Define product requirements",
            "description": (
                "Product strategist intake gate for this sprintengine run. Produce a requirements or "
                "product handoff artifact before architect planning begins."
            ),
            "role": "product",
            "status": "todo",
            "ownerAgentId": None,
            "dependsOn": [],
            "ownedPaths": [requirements_path_value],
            "acceptanceCriteria": [
                "Product artifact captures the goal, requirements, constraints, and acceptance expectations.",
                "If no meaningful product strategy is needed, artifact states that clearly and records non-goals and handoff constraints.",
                "Artifact is reviewed by the user and either approved to done or sent back for changes.",
            ],
            "implementationNotes": implementation_notes,
            "evidence": {"summary": "", "touchedFiles": [], "commandsRan": [], "results": [], "scopeExpansions": []},
            "notes": [],
            "startedAt": None,
            "completedAt": None,
        })
        state.setdefault("tasks", []).append(product_task)
        append_event(state, "task_added", actor, f"{actor} added {product_task['id']}: {product_task['title']}.")
    elif product_task.get("status") == "in_progress":
        product_task["ownerAgentId"] = product_task.get("ownerAgentId") or actor
        product_task["startedAt"] = product_task.get("startedAt") or now_iso()
        product_task["completedAt"] = None

    if handover_note and product_task.get("status") != "done":
        add_unique_values(product_task, "implementationNotes", [handover_note])

    if product_task.get("status") in ACTIVE_TASK_STATUSES:
        set_agent_active(ensure_agent(state, actor, "product"), product_task)

    if product_artifact is None:
        now = now_iso()
        absolute_path = artifact_absolute_path(state_path, requirements_path_value)
        initial_status = "approved" if product_task.get("status") == "done" else "draft"
        history = [{"action": "created", "actor": actor, "timestamp": now}]
        if initial_status == "approved":
            history.append({"action": "approved", "actor": actor, "timestamp": now, "note": "Imported from completed product intake task."})
        product_artifact = {
            "id": next_artifact_id(state.setdefault("artifacts", [])),
            "kind": "requirements",
            "title": "Product Requirements",
            "path": requirements_path_value,
            "status": initial_status,
            "createdBy": actor,
            "taskId": product_task.get("id"),
            "fingerprint": file_fingerprint(absolute_path),
            "reviewHistory": history,
            "recommendedTasks": [],
            "createdAt": now,
            "updatedAt": now,
        }
        if initial_status == "approved":
            product_artifact["approvedBy"] = actor
            product_artifact["approvedAt"] = now
        state.setdefault("artifacts", []).append(product_artifact)
        append_event(state, "artifact_added", actor, f"{actor} registered product requirements artifact {product_artifact['id']}.")
    else:
        product_artifact["taskId"] = product_task.get("id")
        product_artifact["path"] = requirements_path_value
        product_artifact.setdefault("title", "Product Requirements")
        product_artifact.setdefault("createdBy", actor)
        product_artifact.setdefault("reviewHistory", [])
        product_artifact.setdefault("recommendedTasks", [])
        product_artifact.setdefault("createdAt", now_iso())

    return {"task": product_task, "artifact": product_artifact}

def ensure_plan_approval_gate(
    state: Dict[str, Any],
    state_path: Path,
    actor: str = "architect",
    depends_on: Optional[str] = None,
    start_active: bool = True,
) -> Dict[str, Any]:
    plan_path_value = plan_path_artifact_value(state_path)
    existing_gate = find_architect_plan_gate(state, state_path)
    plan_task = existing_gate["task"]
    plan_artifact = existing_gate["artifact"]

    if plan_task is None:
        preferred_id = "T1" if depends_on else "T0"
        task_id = preferred_id if preferred_id not in task_ids(state) else next_task_id(state.get("tasks", []))
        plan_task = normalize_task({
            "id": task_id,
            "title": "Review architect plan artifact",
            "description": f"Architect-authored active team plan at {plan_path_value} and task graph approval gate. Use this exact path; do not read, copy, or overwrite another team's plan.md.",
            "role": "architect",
            "status": "in_progress" if start_active else "todo",
            "ownerAgentId": actor if start_active else None,
            "dependsOn": [depends_on] if depends_on else [],
            "ownedPaths": [plan_path_value],
            "acceptanceCriteria": [
                "Architect plan describes the execution approach and task graph.",
                f"Architect plan artifact is written at the active team path `{plan_path_value}`.",
                "Architect plan records confirmed decisions, repo-answered decisions, defaulted assumptions, and remaining open questions or blockers.",
                "If autonomous planning or artifact auto-approval is active, plan records conservative defaults used, risks accepted by autonomy mode, and any questions intentionally not asked.",
                "Plan is reviewed by the user and either approved to done or sent back for changes.",
            ],
            "implementationNotes": [],
            "evidence": {"summary": "", "touchedFiles": [], "commandsRan": [], "results": [], "scopeExpansions": []},
            "notes": [],
            "startedAt": now_iso() if start_active else None,
            "completedAt": None,
        })
        state.setdefault("tasks", []).append(plan_task)
        append_event(state, "task_added", actor, f"{actor} added {plan_task['id']}: {plan_task['title']}.")
    elif plan_task.get("status") != "done":
        if depends_on and depends_on not in plan_task.get("dependsOn", []):
            add_unique_values(plan_task, "dependsOn", [depends_on])
        if start_active and task_is_ready(state, plan_task):
            plan_task["status"] = "in_progress"
            plan_task["ownerAgentId"] = plan_task.get("ownerAgentId") or actor
            plan_task["startedAt"] = plan_task.get("startedAt") or now_iso()
        plan_task["completedAt"] = None

    if plan_task.get("status") in ACTIVE_TASK_STATUSES:
        set_agent_active(ensure_agent(state, actor, "architect"), plan_task)

    if plan_artifact is None:
        now = now_iso()
        absolute_path = artifact_absolute_path(state_path, plan_path_value)
        initial_status = "approved" if plan_task.get("status") == "done" else "draft"
        history = [{"action": "created", "actor": actor, "timestamp": now}]
        if initial_status == "approved":
            history.append({"action": "approved", "actor": actor, "timestamp": now, "note": "Imported from completed architect plan task."})
        plan_artifact = {
            "id": next_artifact_id(state.setdefault("artifacts", [])),
            "kind": "architect_plan",
            "title": "Architect Plan",
            "path": plan_path_value,
            "status": initial_status,
            "createdBy": actor,
            "taskId": plan_task.get("id"),
            "fingerprint": file_fingerprint(absolute_path),
            "reviewHistory": history,
            "recommendedTasks": [],
            "createdAt": now,
            "updatedAt": now,
        }
        if initial_status == "approved":
            plan_artifact["approvedBy"] = actor
            plan_artifact["approvedAt"] = now
        state.setdefault("artifacts", []).append(plan_artifact)
        append_event(state, "artifact_added", actor, f"{actor} registered architect plan artifact {plan_artifact['id']}.")
    else:
        plan_artifact["taskId"] = plan_task.get("id")
        plan_artifact["path"] = plan_path_value
        plan_artifact.setdefault("title", "Architect Plan")
        plan_artifact.setdefault("createdBy", actor)
        plan_artifact.setdefault("reviewHistory", [])
        plan_artifact.setdefault("recommendedTasks", [])
        plan_artifact.setdefault("createdAt", now_iso())

    return {"task": plan_task, "artifact": plan_artifact}

def plan_path_for_state(state_path: Path) -> Path:
    return state_path.parent / "plan.md"

def plan_prompt_path(state_path: Path) -> str:
    team_dir = state_path.parent
    if team_dir.parent.name == SPRINTENGINE_DIR_NAME and team_dir.parent.parent.name == MULTICODE_DIR_NAME:
        return f"{MULTICODE_DIR_NAME}/{SPRINTENGINE_DIR_NAME}/{team_dir.name}/plan.md"
    return "plan.md"

def plan_reviews_dir_for_state(state_path: Path) -> Path:
    return state_path.parent / "plan-reviews"

def default_swarm_name_for_state(state_path: Path) -> str:
    team_dir_name = state_path.parent.name
    return "Sprint Engine Team" if team_dir_name == "sprintengine" else team_dir_name

def slugify_team_name(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    return slug or "sprintengine-team"

def handover_path_for_state(state_path: Path) -> Path:
    return state_path.parent / "handover.md"

def sources_dir_for_state(state_path: Path) -> Path:
    return state_path.parent / "sources"

def safe_review_filename(agent_id: str) -> str:
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", agent_id.strip()).strip(".-")
    return f"{name or 'agent'}.md"

def safe_source_filename(path: Path, used: set[str]) -> str:
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", path.name.strip()).strip(".-") or "source"
    candidate = name
    stem = Path(name).stem or "source"
    suffix = Path(name).suffix
    index = 2
    while candidate in used:
        candidate = f"{stem}-{index}{suffix}"
        index += 1
    used.add(candidate)
    return candidate

def parse_source_bundle_arg(value: str) -> Dict[str, str]:
    kind, separator, raw_path = value.partition(":")
    kind = kind.strip()
    raw_path = raw_path.strip()
    if not separator or not kind or not raw_path:
        raise SystemExit("--source must use kind:path, for example product_plan:future-plans/product.md")
    if kind not in VALID_SOURCE_BUNDLE_KINDS:
        raise SystemExit(f"--source kind must be one of: {', '.join(sorted(VALID_SOURCE_BUNDLE_KINDS))}.")
    return {"kind": kind, "path": raw_path}

def plan_fingerprint(plan_path: Path) -> str:
    if not plan_path.exists():
        raise SystemExit(f"Plan file not found: {plan_path}")
    return hashlib.sha256(plan_path.read_bytes()).hexdigest()

def expected_plan_reviewers(state: Dict[str, Any]) -> List[Dict[str, str]]:
    reviewers = []
    for agent_id, agent in state.get("agents", {}).items():
        if not isinstance(agent, dict):
            continue
        role = str(agent.get("role", "")).strip()
        if role not in plan_review_role_ids():
            continue
        reviewers.append({"id": str(agent_id), "role": role})
    return sorted(reviewers, key=lambda item: (item["role"], item["id"]))

def parse_review_metadata(path: Path) -> Dict[str, Any]:
    try:
        content = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        content = path.read_text(encoding="utf-8", errors="replace")
    fingerprint_match = re.search(r"(?im)^Plan fingerprint:\s*([A-Fa-f0-9]{64})\s*$", content)
    verdict_match = re.search(r"(?im)^Verdict:\s*([^\n]+)\s*$", content)
    role_match = re.search(r"(?im)^Role:\s*([A-Za-z0-9_-]+)\s*$", content)
    agent_match = re.search(r"(?im)^Agent:\s*([A-Za-z0-9._-]+)\s*$", content)
    return {
        "path": str(path),
        "filename": path.name,
        "agentId": agent_match.group(1).strip() if agent_match else path.stem,
        "role": role_match.group(1).strip() if role_match else None,
        "planFingerprint": fingerprint_match.group(1).lower() if fingerprint_match else None,
        "verdict": verdict_match.group(1).strip() if verdict_match else "unknown",
        "content": content,
    }

def build_plan_review_status(state: Dict[str, Any], state_path: Path) -> Dict[str, Any]:
    plan_path = plan_path_for_state(state_path)
    reviews_dir = plan_reviews_dir_for_state(state_path)
    current_fingerprint = plan_fingerprint(plan_path)
    expected = expected_plan_reviewers(state)
    expected_by_id = {reviewer["id"]: reviewer for reviewer in expected}
    files = sorted(reviews_dir.glob("*.md")) if reviews_dir.exists() else []
    reviews = []

    for path in files:
        metadata = parse_review_metadata(path)
        metadata["path"] = project_relative_display_path(state_path, path)
        metadata["stale"] = metadata.get("planFingerprint") != current_fingerprint
        metadata["expected"] = metadata.get("agentId") in expected_by_id
        metadata.pop("content", None)
        reviews.append(metadata)

    review_ids = {review.get("agentId") for review in reviews}
    missing = [reviewer for reviewer in expected if reviewer["id"] not in review_ids]
    stale = [review for review in reviews if review.get("stale")]
    unexpected = [review for review in reviews if not review.get("expected")]
    completed = [
        review for review in reviews
        if not review.get("stale") and str(review.get("verdict", "")).lower() in {"approve", "needs_changes", "blocked"}
    ]

    return {
        "planPath": project_relative_display_path(state_path, plan_path),
        "reviewsDirectory": project_relative_display_path(state_path, reviews_dir),
        "planFingerprint": current_fingerprint,
        "expectedReviewers": expected,
        "reviews": reviews,
        "missingReviewers": missing,
        "staleReviews": stale,
        "unexpectedReviews": unexpected,
        "counts": {
            "expected": len(expected),
            "completed": len(completed),
            "missing": len(missing),
            "stale": len(stale),
            "unexpected": len(unexpected),
        },
    }

def build_plan_review_template(agent_id: str, role: str, plan_path: Path, fingerprint: str) -> str:
    role_label = role.replace("-", " ").title()
    return "\n".join([
        f"# Plan Review: {role_label}",
        "",
        f"Agent: {agent_id}",
        f"Role: {role}",
        f"Plan: {plan_path.name}",
        f"Plan fingerprint: {fingerprint}",
        "Verdict: pending",
        "",
        "## Summary",
        "",
        "## Blocking Issues",
        "",
        "## Recommended Changes",
        "",
        "## Task Graph Feedback",
        "",
        "## Missing Acceptance Criteria",
        "",
        "## Risks",
        "",
        "## Questions For Architect",
        "",
    ])

def build_plan_review_prompt(
    agent_id: str,
    role: str,
    state_path: Path,
    plan_path: Path,
    review_path: Path,
    fingerprint: str,
    existing_review: bool,
) -> str:
    action = "Replace your existing review" if existing_review else "Write your review"
    plan_display_path = project_relative_display_path(state_path, plan_path)
    review_display_path = project_relative_display_path(state_path, review_path)
    review_prompt = "\n".join([
        f"You are the {role} specialist reviewing the architect's Sprint Engine plan.",
        "",
        "Do not claim tasks, do not implement, and do not edit Sprint Engine run-store files.",
        "",
        f"Plan file: {plan_display_path}",
        f"Your review file: {review_display_path}",
        f"Current plan fingerprint: {fingerprint}",
        f"Review focus: {PLAN_REVIEW_FOCUS.get(role, 'specialist risks, gaps, and execution quality')}.",
        "",
        "Steps:",
        "1. Read the full architect plan.",
        "2. Inspect the repository only as needed to validate the plan from your specialty.",
        "3. Evaluate whether the task graph, owned paths, dependencies, and acceptance criteria are sufficient.",
        "4. Treat production integration as a plan requirement: flag any task that allows sample data, fake responses, mocked transports, stubbed commands, placeholder persistence, disconnected UI state, or documentation-only verification to satisfy product acceptance.",
        f"5. {action} at the exact project-relative review file path above.",
        "6. Set `Verdict:` to one of: approve, needs_changes, blocked.",
        "7. Keep feedback concrete and actionable for the architect.",
        "",
        "Required markdown sections:",
        "- Summary",
        "- Blocking Issues",
        "- Recommended Changes",
        "- Task Graph Feedback",
        "- Missing Acceptance Criteria",
        "- Risks",
        "- Questions For Architect",
        "",
        "Do not update the task board. The architect will address feedback with `Sprint Engine plan address-reviews`.",
    ])
    return compose_prompt(
        "# Sprint Engine Plan Review Rules",
        review_prompt,
        load_soul_prompt(role),
        (
            "Use the Soul prompt above for review perspective and quality bar. The plan review "
            "rules below override it for sprintengine mechanics: do not claim tasks, do not implement, do not "
            "edit state files, write only the assigned review file, and keep feedback concrete for the architect."
        ),
    )

def build_address_reviews_prompt(
    state: Dict[str, Any],
    state_path: Path,
    status: Dict[str, Any],
    review_contents: List[Dict[str, str]],
) -> str:
    plan_path = plan_path_for_state(state_path)
    plan_display_path = project_relative_display_path(state_path, plan_path)
    plan_content = plan_path.read_text(encoding="utf-8")
    review_blocks = []

    for review in review_contents:
        review_blocks.extend([
            f"## Review File: {review['path']}",
            "",
            review["content"].rstrip(),
            "",
        ])

    warnings = []
    if status["missingReviewers"]:
        missing = ", ".join(f"{r['id']} ({r['role']})" for r in status["missingReviewers"])
        warnings.append(f"- Missing expected reviews: {missing}")
    if status["staleReviews"]:
        stale = ", ".join(str(r["path"]) for r in status["staleReviews"])
        warnings.append(f"- Stale reviews whose fingerprint does not match the current plan: {stale}")
    if status["unexpectedReviews"]:
        unexpected = ", ".join(str(r["path"]) for r in status["unexpectedReviews"])
        warnings.append(f"- Unexpected review files: {unexpected}")
    warning_block = "\n".join(warnings) if warnings else "- No missing, stale, or unexpected review files detected."

    return "\n".join([
        "You are the sprintengine architect addressing specialist plan reviews.",
        "",
        "Do not implement. Do not hand-edit Sprint Engine run-store files. Your job is to revise the plan and task graph.",
        "",
        f"Plan file: {plan_display_path}",
        f"Plan fingerprint: {status['planFingerprint']}",
        "",
        "Review status:",
        warning_block,
        "",
        "Steps:",
        "1. Read the current plan and all specialist review feedback below.",
        "2. Decide which feedback to accept, adapt, or reject.",
        "3. Repair any plan or task acceptance criteria that would let sample data, fake responses, mocked transports, stubbed commands, placeholder persistence, disconnected UI state, or documentation-only verification count as completion.",
        "4. Update the exact plan file shown above when the human-readable plan needs changes; do not search for or edit another plan.md.",
        "5. Update the task graph only with Sprint Engine plan commands:",
        "   - Sprint Engine plan update-task",
        "   - Sprint Engine plan add-task",
        "   - Sprint Engine plan delete-task",
        "   - Sprint Engine plan add-dependency",
        "   - Sprint Engine plan remove-dependency",
        "6. Do not start implementation work.",
        "7. When done, tell the user which review items were accepted, adapted, or rejected.",
        "",
        "# Current Plan",
        "",
        plan_content.rstrip(),
        "",
        "# Specialist Reviews",
        "",
        "\n".join(review_blocks).rstrip() or "(No plan review files found.)",
    ])

def build_run_summary(state: Dict[str, Any]) -> Dict[str, Any]:
    tasks = state.get("tasks", [])
    completed = [t for t in tasks if t.get("status") == "done"]
    touched_files: List[Any] = []
    commands_ran: List[Any] = []
    scope_expansions: List[Dict[str, Any]] = []
    results: List[str] = []
    task_summaries = []
    open_questions: List[str] = []

    for t in completed:
        ev = ensure_evidence(t)
        task_summaries.append({
            "id": t.get("id"),
            "title": t.get("title"),
            "summary": ev.get("summary") or "No summary recorded.",
            "ownerAgentId": t.get("ownerAgentId"),
            "completedAt": t.get("completedAt"),
        })
        touched_files.extend(ev.get("touchedFiles", []))
        commands_ran.extend(ev.get("commandsRan", []))
        for expansion in ev.get("scopeExpansions", []):
            if isinstance(expansion, dict):
                scope_expansions.append({
                    "taskId": t.get("id"),
                    "path": expansion.get("path"),
                    "reason": expansion.get("reason"),
                    "risk": expansion.get("risk", ""),
                })
        results.extend(f"{t.get('id')}: {r}" for r in ev.get("results", []) if isinstance(r, str))

    for t in tasks:
        for q in t.get("notes", []):
            if isinstance(q, str) and q.strip():
                open_questions.append(f"{t.get('id')}: {q.strip()}")

    sprintengine = state.get("sprintengine", {})
    return {
        "goal": sprintengine.get("goal", ""),
        "status": sprintengine.get("status", "planning"),
        "tasks": {"total": len(tasks), "completed": len(completed), "remaining": max(0, len(tasks) - len(completed))},
        "touchedFiles": unique_strings(touched_files),
        "commandsRan": unique_strings(commands_ran),
        "scopeExpansions": scope_expansions,
        "results": results,
        "completedTasks": task_summaries,
        "openQuestions": open_questions,
    }
