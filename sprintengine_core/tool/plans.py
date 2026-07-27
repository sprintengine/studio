"""Plan, source bundle, approval gate, and summary helpers."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from sprintengine_core.tool.artifacts import *  # noqa: F403,F401
from sprintengine_core.tool.common import path_is_relative_to, unique_strings
from sprintengine_core.tool.constants import *  # noqa: F403,F401
from sprintengine_core.tool.paths import MULTICODE_DIR_NAME, SPRINTENGINE_DIR_NAME, now_iso
from sprintengine_core.tool.state import *  # noqa: F403,F401
from sprintengine_core.tool.tasks import *  # noqa: F403,F401

SOURCE_KIND_LABELS = {
    "product_plan": "Product plan",
    "architect_plan": "Implementation plan",
    "epic": "Epic",
    "html_mockup": "HTML mockup",
    "design_notes": "Design notes",
    "plan_overview": "Plan overview",
    "generic_context": "Context",
    "unknown": "Source context",
}

SOURCE_CONTEXT_HEADING = "Incoming source context for this run:"

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

def source_items_for_kind(state: Dict[str, Any], kind: str) -> List[Dict[str, Any]]:
    items = list(source_bundle_items(state, kind))
    source = state.get("source")
    if isinstance(source, dict) and source_plan_kind(state) == kind:
        items.append(source)
    return items

def source_kind_is_reference(state: Dict[str, Any], kind: str) -> bool:
    # A kind is reference-sourced only when every source of that kind points at
    # a canonical original (origin "reference"). Mixed copy/reference sources
    # fall back to the copy path so no source silently loses its seed.
    items = source_items_for_kind(state, kind)
    return bool(items) and all(item.get("origin") == "reference" for item in items)

def reference_source_display_path(state: Dict[str, Any], kind: str) -> str:
    for item in source_items_for_kind(state, kind):
        if item.get("origin") != "reference":
            continue
        path_value = str(item.get("path") or "").strip()
        if path_value:
            return path_value
    return ""

def source_item_absolute_path(state_path: Path, item: Dict[str, Any], path_value: str) -> Path:
    # Reference sources store a project-root-relative path to the canonical
    # original (which lives outside the team folder), so resolve them against the
    # repository root. Copy sources live under the team folder and resolve via the
    # standard artifact path logic.
    if item.get("origin") == "reference":
        root = repository_root_for_state(state_path)
        primary = (root / path_value).resolve()
        if primary.exists():
            return primary
        # Tolerant retry (MC-1697): a reference authored `mockups/x.html` (no
        # `backlog/` prefix) actually lives at `backlog/mockups/x.html`. A single
        # missing prefix once made the one artifact carrying the requirement
        # invisible, and the wrong architecture shipped — so before reporting a
        # reference missing, retry it under `backlog/`. Only the primary is
        # returned when neither resolves, so the miss is reported against the
        # authored path.
        normalized = str(path_value).replace("\\", "/").lstrip("/")
        if normalized and not normalized.startswith("backlog/"):
            fallback = (root / "backlog" / normalized).resolve()
            if fallback.exists():
                return fallback
        return primary
    return artifact_absolute_path(state_path, path_value)

def source_path_for_kind(state: Dict[str, Any], state_path: Path, kind: str) -> Path:
    bundle_item = next(iter(source_bundle_items(state, kind)), None)
    if bundle_item:
        item_path = str(bundle_item.get("path") or "").strip()
        if item_path:
            return source_item_absolute_path(state_path, bundle_item, item_path)
    source = state.get("source")
    if isinstance(source, dict) and source_plan_kind(state) == kind:
        source_path_value = str(source.get("path") or "").strip()
        if source_path_value:
            return source_item_absolute_path(state_path, source, source_path_value)
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

def source_bundle_reference_notes(state: Dict[str, Any], state_path: Optional[Path] = None) -> List[str]:
    notes: List[str] = []
    for item in source_bundle_items(state):
        kind = str(item.get("kind") or "").strip()
        path = str(item.get("path") or "").strip()
        if not path:
            continue
        # Dangling-acceptance-reference guard (MC-1697): a reference source whose
        # path resolves to no file — even after the tolerant `backlog/` retry in
        # source_item_absolute_path — means the artifact carrying the requirement
        # may be invisible. Surface it (shown, never dropped) and name the
        # escalation the architect contract requires, so auto-run never quietly
        # builds to the spec text when the acceptance reference is gone.
        if state_path is not None and item.get("origin") == "reference":
            if not source_item_absolute_path(state_path, item, path).exists():
                notes.append(
                    f"WARNING — source reference `{path}` could not be found at the repository root or under "
                    "`backlog/`. A missing acceptance reference means the spec text may not carry the full intent: "
                    "raise needs_input(user) before building to the spec text, even under auto-run, rather than "
                    "assuming the spec is self-sufficient."
                )
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
        elif kind == "plan_overview":
            notes.append(
                f"`{path}` is a human-oriented HTML overview of the accepted plan. "
                "Consult it for system shape if useful, but treat the markdown plan as the implementation source of truth. Never edit it."
            )
        elif kind == "product_plan":
            notes.append(
                f"`{path}` is the accepted product source of truth — build scope comes from it; do not re-litigate decisions it records."
            )
        elif kind == "architect_plan":
            notes.append(
                f"`{path}` is the accepted implementation contract — validate task breakdowns against it before creating cards."
            )
        elif kind in {"generic_context", "unknown"}:
            notes.append(f"Review source context `{path}` before creating affected task cards.")
    return notes

def workspace_root_for_state_path(state_path: Path) -> Path:
    team_dir = state_path.parent.resolve()
    if (
        team_dir.parent.name == SPRINTENGINE_DIR_NAME
        and team_dir.parent.parent.name == MULTICODE_DIR_NAME
    ):
        return team_dir.parent.parent.parent.resolve()
    return team_dir

def source_context_display_path(state_path: Path, value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    path = Path(raw)
    if not path.is_absolute():
        return raw.replace("\\", "/")
    workspace_root = workspace_root_for_state_path(state_path)
    resolved = path.resolve()
    if path_is_relative_to(resolved, workspace_root):
        return resolved.relative_to(workspace_root).as_posix()
    return ""

def source_context_reference_lines(state: Dict[str, Any], state_path: Path) -> List[str]:
    lines: List[str] = []
    source = state.get("source")
    if isinstance(source, dict):
        source_path = (
            source_context_display_path(state_path, source.get("originalPath"))
            or source_context_display_path(state_path, source.get("path"))
        )
        snapshot_path = source_context_display_path(state_path, source.get("path"))
        plan_kind = str(source.get("planKind") or "unknown").strip()
        label = SOURCE_KIND_LABELS.get(plan_kind, "Root handoff")
        if source_path:
            line = f"- Root handoff ({label}): read `{source_path}`."
            if snapshot_path and snapshot_path != source_path:
                line += f" Sprint Engine snapshot: `{snapshot_path}`."
            lines.append(line)

    for item in source_bundle_items(state):
        kind = str(item.get("kind") or "unknown").strip()
        label = SOURCE_KIND_LABELS.get(kind, kind.replace("_", " ").title())
        source_path = (
            source_context_display_path(state_path, item.get("originalPath"))
            or source_context_display_path(state_path, item.get("path"))
        )
        snapshot_path = source_context_display_path(state_path, item.get("path"))
        if not source_path:
            continue
        line = f"- {label}: read `{source_path}`."
        if snapshot_path and snapshot_path != source_path:
            line += f" Sprint Engine snapshot: `{snapshot_path}`."
        lines.append(line)

    return unique_strings(lines)

def source_context_description_block(state: Dict[str, Any], state_path: Path) -> Optional[str]:
    lines = source_context_reference_lines(state, state_path)
    if not lines:
        return None
    return "\n".join([
        SOURCE_CONTEXT_HEADING,
        *lines,
        "Use these explicit source paths; do not infer the backlog item, mockup, or plan source from the team slug.",
    ])

def apply_source_context_to_task(task: Dict[str, Any], state: Dict[str, Any], state_path: Path) -> None:
    block = source_context_description_block(state, state_path)
    if not block:
        return
    description = str(task.get("description") or "").rstrip()
    if SOURCE_CONTEXT_HEADING in description:
        description = description.split(f"\n\n{SOURCE_CONTEXT_HEADING}", 1)[0].rstrip()
    task["description"] = f"{description}\n\n{block}" if description else block
    notes = [
        "Read the explicit incoming source context paths in the task description before producing this artifact.",
        "Do not derive the backlog item, source plan, mockup, or context folder from the Sprint Engine team slug.",
    ]
    add_unique_values(task, "implementationNotes", notes)

def resolve_planning_role(state: Dict[str, Any]) -> str:
    """The role that owns the plan-approval gate, from the run's configuredRoles.

    The architect owns planning whenever it is a configured role; a pool of plain
    Generals with no architect plans the run itself, so the planner is `general`.
    Preferring the architect whenever it is enabled keeps every existing
    architect/specialist run on the architect path byte-for-byte. Authority is
    `configuredRoles` (the run's legal role set), not a seated roster — so this
    answers correctly at init, before any worker has claimed anything. A legacy
    run with no configuredRoles defaults to `architect`.
    """
    configured = configured_role_set(state) or set()
    if "architect" in configured:
        return "architect"
    if "general" in configured:
        return "general"
    return "architect"

def find_architect_plan_gate(state: Dict[str, Any], state_path: Path) -> Dict[str, Any]:
    plan_resolved_path = artifact_absolute_path(state_path, plan_path_artifact_value(state_path))
    plan_task = None
    plan_artifact = None

    for artifact in state.setdefault("artifacts", []):
        if not isinstance(artifact, dict):
            continue
        candidate_path = str(artifact.get("path") or "")
        if (
            artifact.get("kind") == "architect_plan"
            and artifact.get("status") != "superseded"
            and candidate_path
            and artifact_absolute_path(state_path, candidate_path) == plan_resolved_path
        ):
            plan_artifact = artifact
            plan_task = find_task_by_id(state, artifact.get("taskId"))
            break

    if plan_task is None:
        candidate = find_task_by_id(state, "T0")
        if candidate and candidate.get("role") == resolve_planning_role(state):
            plan_task = candidate

    return {"task": plan_task, "artifact": plan_artifact}

def apply_plan_gate_dependency(task: Dict[str, Any], state: Dict[str, Any], state_path: Path) -> None:
    """Planned work is gated on plan approval: a newly created task with no
    dependencies roots on the plan-approval gate task (owned by the run's
    planning role — architect or general), so nothing becomes claimable before
    the plan is approved and the task graph stays rooted at the plan review.
    Tasks created with explicit dependencies are covered transitively — every
    dependency chain terminates at a gated root."""
    if task.get("dependsOn"):
        return
    gate_task = find_architect_plan_gate(state, state_path).get("task")
    if not isinstance(gate_task, dict):
        return
    gate_id = str(gate_task.get("id") or "").strip()
    if not gate_id or gate_id == str(task.get("id") or "").strip():
        return
    task["dependsOn"] = [gate_id]

def ensure_product_intake_gate(state: Dict[str, Any], state_path: Path, actor: str = "product") -> Dict[str, Any]:
    requirements_path_value = product_intake_path_artifact_value(state_path)
    requirements_resolved_path = artifact_absolute_path(state_path, requirements_path_value)
    handover_note = product_intake_handover_note(state_path)
    product_task = None
    product_artifact = None
    created_product_task = False

    for artifact in state.setdefault("artifacts", []):
        if not isinstance(artifact, dict):
            continue
        candidate_path = str(artifact.get("path") or "")
        if (
            artifact.get("kind") in {"product_strategy", "requirements"}
            and artifact.get("status") != "superseded"
            and candidate_path
            and artifact_absolute_path(state_path, candidate_path) == requirements_resolved_path
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
            # Approval task, not implementation work — see ensure_plan_approval_gate.
            "phases": [],
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
        created_product_task = True
        append_event(state, "task_added", actor, f"{actor} added {product_task['id']}: {product_task['title']}.")
    elif product_task.get("status") == "in_progress":
        product_task["ownerAgentId"] = product_task.get("ownerAgentId") or actor
        product_task["startedAt"] = product_task.get("startedAt") or now_iso()
        product_task["completedAt"] = None

    if handover_note and product_task.get("status") != "done":
        add_unique_values(product_task, "implementationNotes", [handover_note])

    should_refresh_source_context = (
        created_product_task
        or SOURCE_CONTEXT_HEADING in str(product_task.get("description") or "")
    )
    if product_task.get("status") != "done" and should_refresh_source_context:
        apply_source_context_to_task(product_task, state, state_path)

    if product_task.get("status") in ACTIVE_TASK_STATUSES:
        mint_lease(product_task, actor, "product")
        stamp_task_execution_identity(state, product_task)

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
    # The plan gate is owned by the run's planning role: `architect` on every
    # architect/specialist run (so those stay byte-for-byte identical), `general`
    # on a soulless-General run. `role_noun` carries the prose form so the
    # architect copy is reproduced verbatim.
    role = resolve_planning_role(state)
    role_noun = role.capitalize()
    existing_gate = find_architect_plan_gate(state, state_path)
    plan_task = existing_gate["task"]
    plan_artifact = existing_gate["artifact"]
    created_plan_task = False

    if plan_task is None:
        preferred_id = "T1" if depends_on else "T0"
        task_id = preferred_id if preferred_id not in task_ids(state) else next_task_id(state.get("tasks", []))
        plan_task = normalize_task({
            "id": task_id,
            "title": f"Review {role} plan artifact",
            "description": f"{role_noun}-authored active team plan at {plan_path_value} and task graph approval gate. Use this exact path; do not read, copy, or overwrite another team's plan.md.",
            "role": role,
            "status": "in_progress" if start_active else "todo",
            "ownerAgentId": actor if start_active else None,
            "dependsOn": [depends_on] if depends_on else [],
            "ownedPaths": [plan_path_value],
            # An approval task, not implementation work: the plan is adjudicated by
            # the human (or auto-approval) through its artifact, never by a review
            # phase. Without this it would inherit the run's `defaultPhases` and its
            # author would end up self-reviewing a plan document.
            "phases": [],
            "acceptanceCriteria": [
                f"{role_noun} plan describes the execution approach and task graph.",
                f"{role_noun} plan artifact is written at the active team path `{plan_path_value}`.",
                f"{role_noun} plan records confirmed decisions, repo-answered decisions, defaulted assumptions, and remaining open questions or blockers.",
                f"{role_noun} plan pins every contract shared between tasks — named APIs, registry seams, component props and types, store fields, schemas, IPC channels — so no cross-task interface is left for an implementer to invent.",
                f"{role_noun} plan commits to one choice per load-bearing decision, with rationale and the rejected alternative recorded; no decision is left open as an either/or for the implementer.",
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
        created_plan_task = True
        append_event(state, "task_added", actor, f"{actor} added {plan_task['id']}: {plan_task['title']}.")
    elif plan_task.get("status") != "done":
        if depends_on and depends_on not in plan_task.get("dependsOn", []):
            add_unique_values(plan_task, "dependsOn", [depends_on])
        if start_active and task_is_ready(state, plan_task):
            plan_task["status"] = "in_progress"
            plan_task["ownerAgentId"] = plan_task.get("ownerAgentId") or actor
            plan_task["startedAt"] = plan_task.get("startedAt") or now_iso()
        plan_task["completedAt"] = None

    should_refresh_source_context = (
        created_plan_task
        or SOURCE_CONTEXT_HEADING in str(plan_task.get("description") or "")
    )
    if plan_task.get("status") != "done" and should_refresh_source_context:
        apply_source_context_to_task(plan_task, state, state_path)

    if plan_task.get("status") in ACTIVE_TASK_STATUSES:
        mint_lease(plan_task, actor, role)
        stamp_task_execution_identity(state, plan_task)

    if plan_artifact is None:
        now = now_iso()
        absolute_path = artifact_absolute_path(state_path, plan_path_value)
        initial_status = "approved" if plan_task.get("status") == "done" else "draft"
        history = [{"action": "created", "actor": actor, "timestamp": now}]
        if initial_status == "approved":
            history.append({"action": "approved", "actor": actor, "timestamp": now, "note": f"Imported from completed {role} plan task."})
        plan_artifact = {
            "id": next_artifact_id(state.setdefault("artifacts", [])),
            # The canonical plan-artifact kind is shared by both planners; the
            # general variant differs by title/owner, not kind, so the renderer
            # artifact-kind map and find_architect_plan_gate keep working.
            "kind": "architect_plan",
            "title": f"{role_noun} Plan",
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
        append_event(state, "artifact_added", actor, f"{actor} registered {role} plan artifact {plan_artifact['id']}.")
    else:
        plan_artifact["taskId"] = plan_task.get("id")
        plan_artifact["path"] = plan_path_value
        plan_artifact.setdefault("title", f"{role_noun} Plan")
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

def collect_run_findings(state: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Every structured finding recorded on the run, flattened and attributed.

    The `findings` array was empty in all 33 task records across the three runs
    merged 2026-07-23 — even where the task's own summary prose reported
    findings — so nothing downstream could ask "what did this sprint find?".
    The channel already existed; what it lacked was anywhere the answer showed
    up. Every finding lands here with its owning task, whether it was filed by
    the task's owner (`feedback.findings`) or by a reviewer assessing that task
    (`feedbackAssessments[].findings`), and whether or not it was later routed
    into a follow-up task.
    """
    findings: List[Dict[str, Any]] = []
    for task in state.get("tasks", []) or []:
        if not isinstance(task, dict):
            continue
        task_id = str(task.get("id") or "")
        sources: List[tuple[Dict[str, Any], str]] = []
        feedback = task.get("feedback")
        if isinstance(feedback, dict):
            sources.append((feedback, "self_report"))
        for assessment in task.get("feedbackAssessments") or []:
            if isinstance(assessment, dict):
                sources.append((assessment, "reviewer_assessment"))
        for record, origin in sources:
            for finding in record.get("findings") or []:
                if not isinstance(finding, dict):
                    continue
                findings.append({
                    "taskId": task_id,
                    "taskTitle": task.get("title") or "",
                    "origin": origin,
                    "reportedBy": record.get("agentId") or "",
                    "capturedAt": record.get("capturedAt") or "",
                    "id": finding.get("id") or "",
                    "kind": finding.get("kind") or "",
                    "severity": finding.get("severity") or "",
                    "area": finding.get("area") or "",
                    "status": finding.get("status") or "",
                    "title": finding.get("title") or "",
                    # The task the architect filed FOR this finding, if any —
                    # the other half of the reviewer task-filing channel.
                    "filedTaskIds": _tasks_filed_from(state, task_id, str(finding.get("id") or "")),
                })
    return findings


def _tasks_filed_from(state: Dict[str, Any], task_id: str, finding_id: str) -> List[str]:
    if not finding_id:
        return []
    filed = []
    for task in state.get("tasks", []) or []:
        if not isinstance(task, dict):
            continue
        origin = task.get("fromFinding")
        if not isinstance(origin, dict):
            continue
        if str(origin.get("findingId") or "") != finding_id:
            continue
        if task_id and str(origin.get("taskId") or "") not in {"", task_id}:
            continue
        filed.append(str(task.get("id") or ""))
    return filed


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

    findings = collect_run_findings(state)
    findings_by_severity: Dict[str, int] = {}
    for finding in findings:
        severity = finding.get("severity") or "unspecified"
        findings_by_severity[severity] = findings_by_severity.get(severity, 0) + 1

    sprintengine = state.get("sprintengine", {})
    return {
        "goal": sprintengine.get("goal", ""),
        "findings": findings,
        "findingsBySeverity": dict(sorted(findings_by_severity.items())),
        "status": sprintengine.get("status", "planning"),
        "tasks": {"total": len(tasks), "completed": len(completed), "remaining": max(0, len(tasks) - len(completed))},
        "touchedFiles": unique_strings(touched_files),
        "commandsRan": unique_strings(commands_ran),
        "scopeExpansions": scope_expansions,
        "results": results,
        "completedTasks": task_summaries,
        "openQuestions": open_questions,
    }
