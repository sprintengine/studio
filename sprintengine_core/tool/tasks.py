"""Task normalization, readiness, evidence, and publishing helpers."""
from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any, Dict, List, Optional

from sprintengine_core import store as folder_store
from sprintengine_core.role_registry import RoleManifest, discover_role_registry
from sprintengine_core.diff_evidence import capture_task_diff_evidence
from sprintengine_core.tool.comments import *  # noqa: F403,F401
from sprintengine_core.tool.common import unique_strings
from sprintengine_core.tool.constants import *  # noqa: F403,F401
from sprintengine_core.tool.gates import *  # noqa: F403,F401
from sprintengine_core.tool.paths import now_iso, workspace_root_for_state_path
from sprintengine_core.tool.roles import require_configured_role
from sprintengine_core.tool.shell import worktree_for_vcs
from sprintengine_core.tool.state import *  # noqa: F403,F401

def publish_task(
    state: Dict[str, Any],
    task: Dict[str, Any],
    actor: str,
    body: str,
    paths: Optional[List[str]] = None,
    data: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    previous_status = str(task.get("status") or "")
    if previous_status not in {"in_progress", "changes_requested"}:
        raise SystemExit("Only in_progress or changes_requested tasks can be published.")
    is_rework_publish = previous_status == "changes_requested" or task_has_prior_required_rework_verdict(task)
    if is_rework_publish:
        feedback_ids = [str(comment.get("id")) for comment in open_rework_comments(task) if comment.get("id")]
        comment_type = "implementation_response"
        comment = create_task_comment(
            state,
            task,
            actor=actor,
            body=body,
            comment_type=comment_type,
            source="agent",
            paths=paths,
            data={**(data or {}), "feedbackCommentIds": feedback_ids},
        )
        reset_required_gates_for_rework(task)
    else:
        comment_type = "implementation_summary"
        comment = create_task_comment(
            state,
            task,
            actor=actor,
            body=body,
            comment_type=comment_type,
            source="agent",
            paths=paths,
            data=data,
        )

    next_status = next_publish_status(task)
    published_at = now_iso()
    task["lastImplementedByAgentId"] = actor
    task["lastPublishedAt"] = published_at
    task["status"] = next_status
    task["ownerAgentId"] = None
    task.pop("needsInput", None)
    if next_status == "done":
        task["completedAt"] = published_at
        # A plan/product gate task has no quality gates, so publishing it drives
        # it straight to done; resolve its draft placeholder like the other
        # task-done transitions. Imported lazily to avoid an artifacts<->tasks
        # import cycle.
        from sprintengine_core.tool.artifacts import supersede_stale_gate_placeholder_on_completion
        supersede_stale_gate_placeholder_on_completion(state, task, actor)
    else:
        task["completedAt"] = None
    cleared = clear_task_refs(state, str(task.get("id")))
    append_task_activity(
        task,
        "status_change",
        actor,
        f"{actor} published {task.get('id')} to {next_status}.",
        {"status": next_status, "fromStatus": previous_status, "commentId": comment["id"]},
    )
    return {"comment": comment, "nextStatus": next_status, "previousStatus": previous_status, "clearedAgents": cleared}

def state_has_active_gate(tasks: List[Dict[str, Any]]) -> bool:
    for task in tasks:
        if not isinstance(task, dict):
            continue
        for gate in task_quality_gates(task):
            if gate.get("status") == "in_progress":
                return True
    return False

def recompute_phase(state: Dict[str, Any]) -> bool:
    sprintengine = state.setdefault("sprintengine", {})
    tasks = state.get("tasks", [])
    if tasks and all(t.get("status") in {"done", "canceled"} for t in tasks):
        return set_if_changed(sprintengine, "status", "completed")
    if any(t.get("status") in RUN_EXECUTING_TASK_STATUSES for t in tasks) or state_has_active_gate(tasks):
        return set_if_changed(sprintengine, "status", "executing")
    return set_if_changed(sprintengine, "status", "planned" if tasks else "planning")

def ensure_evidence(task: Dict[str, Any]) -> Dict[str, Any]:
    ev = task.setdefault("evidence", {})
    ev.setdefault("summary", "")
    ev.setdefault("touchedFiles", [])
    ev.setdefault("commandsRan", [])
    ev.setdefault("results", [])
    ev.setdefault("scopeExpansions", [])
    return ev

def task_diff_capture_cwd(state: Dict[str, Any], state_path: Path) -> Path:
    return worktree_for_vcs(state, state_path) or workspace_root_for_state_path(state_path)

def task_diff_declared_paths(task: Dict[str, Any], extra_paths: Optional[List[str]] = None) -> List[str]:
    evidence = ensure_evidence(task)
    paths: List[str] = []
    paths.extend(evidence.get("touchedFiles", []) if isinstance(evidence.get("touchedFiles"), list) else [])
    paths.extend(extra_paths or [])
    latest = latest_implementation_comment(task)
    if latest and isinstance(latest.get("paths"), list):
        paths.extend(latest["paths"])
    return unique_strings(paths)

def refresh_task_diff_evidence(
    state: Dict[str, Any],
    state_path: Path,
    task: Dict[str, Any],
    actor: str,
    extra_paths: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    paths = task_diff_declared_paths(task, extra_paths)
    diffs = capture_task_diff_evidence(
        task_diff_capture_cwd(state, state_path),
        paths,
        actor=actor,
        captured_at=now_iso(),
    )
    ensure_evidence(task)["diffs"] = diffs
    if diffs:
        file_count = len(diffs)
        skipped_count = len([diff for diff in diffs if diff.get("skippedReason")])
        truncated_count = len([diff for diff in diffs if diff.get("truncated")])
        details = [f"{file_count} file{'s' if file_count != 1 else ''}"]
        if skipped_count:
            details.append(f"{skipped_count} skipped")
        if truncated_count:
            details.append(f"{truncated_count} truncated")
        append_task_activity(
            task,
            "evidence",
            actor,
            f"{actor} refreshed diff evidence for {task.get('id')} ({', '.join(details)}).",
        )
    return diffs

def task_is_ready(state: Dict[str, Any], task: Dict[str, Any]) -> bool:
    if task.get("status") not in {"todo", "changes_requested"} or task.get("ownerAgentId"):
        return False
    if task.get("needsTriage") is True:
        return False
    for dep_id in task.get("dependsOn", []):
        dep = next((t for t in state.get("tasks", []) if t.get("id") == dep_id), None)
        if dep is None or dep.get("status") != "done":
            return False
    return True

def refresh_materialized_ready_queue(state_path: Path, state: Dict[str, Any]) -> Dict[str, Any]:
    try:
        return folder_store.sync_state_to_store(state_path.parent, state, state_path=state_path)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc

def read_ready_task_ids(state: Dict[str, Any]) -> List[str]:
    tasks = [task for task in state.get("tasks", []) or [] if isinstance(task, dict)]
    try:
        ordered_ids = folder_store.validate_acyclic_task_graph(tasks)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc
    tasks_by_id = {str(task.get("id")): task for task in tasks if task.get("id")}
    ready_ids: List[str] = []
    changes_requested_ids: List[str] = []
    for task_id in ordered_ids:
        task = tasks_by_id.get(task_id)
        if task and task_is_ready(state, task):
            if task.get("status") == "changes_requested":
                changes_requested_ids.append(task_id)
            else:
                ready_ids.append(task_id)
    return [*changes_requested_ids, *ready_ids]

def optional_non_empty_string(record: Dict[str, Any], key: str) -> Optional[str]:
    value = record.get(key)
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None

def normalize_task_source(raw: Any, task_id: str) -> Optional[Dict[str, Any]]:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise SystemExit(f"Task {task_id} source must be an object.")

    source_type = optional_non_empty_string(raw, "type")
    if source_type not in VALID_TASK_SOURCE_TYPES:
        raise SystemExit(
            f"Task {task_id} source.type must be one of: {', '.join(sorted(VALID_TASK_SOURCE_TYPES))}."
        )

    source: Dict[str, Any] = {"type": source_type}
    for key in ("externalId", "externalUrl", "repo", "title", "externalUpdatedAt", "syncedAt"):
        value = optional_non_empty_string(raw, key)
        if value is not None:
            source[key] = value
    if isinstance(raw.get("body"), str):
        source["body"] = raw["body"]

    sync_status = optional_non_empty_string(raw, "syncStatus")
    if sync_status is not None:
        if sync_status not in VALID_TASK_SOURCE_SYNC_STATUSES:
            raise SystemExit(
                f"Task {task_id} source.syncStatus must be one of: {', '.join(sorted(VALID_TASK_SOURCE_SYNC_STATUSES))}."
            )
        source["syncStatus"] = sync_status

    return source

def normalize_task_needs_input(raw: Any, task_id: str) -> Optional[Dict[str, Any]]:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise SystemExit(f"Task {task_id} needsInput must be an object.")

    kind = optional_non_empty_string(raw, "kind")
    legacy_default_reason = None
    if kind in LEGACY_NEEDS_INPUT_KIND_MAP:
        kind, legacy_default_reason = LEGACY_NEEDS_INPUT_KIND_MAP[kind]
    if kind not in VALID_NEEDS_INPUT_KINDS:
        raise SystemExit(
            f"Task {task_id} needsInput.kind must be one of: {', '.join(sorted(VALID_NEEDS_INPUT_KINDS))}."
        )

    needs_input: Dict[str, Any] = {"kind": kind}
    reason = optional_non_empty_string(raw, "reason")
    if reason is not None:
        needs_input["reason"] = reason
    elif legacy_default_reason:
        needs_input["reason"] = legacy_default_reason
    elif kind in NEEDS_INPUT_KIND_DEFAULT_REASONS:
        needs_input["reason"] = NEEDS_INPUT_KIND_DEFAULT_REASONS[kind]

    for key in ("question", "suggestedResolution", "reportedBy", "reportedAt", "artifactId"):
        value = optional_non_empty_string(raw, key)
        if value is not None:
            needs_input[key] = value
    return needs_input

def normalize_needs_triage(raw: Any, task_id: str) -> bool:
    if raw is None:
        return False
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, str):
        normalized = raw.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
    raise SystemExit(f"Task {task_id} needsTriage must be a boolean.")

def normalize_difficulty_percent_value(value: Any, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > 100:
        raise SystemExit(f"{field_name} must be an integer from 0 to 100.")
    return value

def normalize_task_difficulty(raw: Any, task_id: str) -> Optional[Dict[str, Any]]:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise SystemExit(f"Task {task_id} difficulty must be an object.")
    difficulty: Dict[str, Any] = {}
    for key in ("architectEstimatePct", "implementerActualPct"):
        if key in raw and raw.get(key) is not None:
            difficulty[key] = normalize_difficulty_percent_value(raw.get(key), f"Task {task_id} difficulty.{key}")
    for key in ("architectEstimateReason", "implementerActualReason"):
        value = optional_non_empty_string(raw, key)
        if value is not None:
            difficulty[key] = value
    assessments = raw.get("reviewerAssessments")
    if assessments is not None:
        if not isinstance(assessments, list):
            raise SystemExit(f"Task {task_id} difficulty.reviewerAssessments must be a list.")
        normalized_assessments: List[Dict[str, Any]] = []
        for index, raw_assessment in enumerate(assessments):
            if not isinstance(raw_assessment, dict):
                raise SystemExit(f"Task {task_id} difficulty.reviewerAssessments[{index}] must be an object.")
            dimension = optional_non_empty_string(raw_assessment, "dimension")
            if dimension not in VALID_DIFFICULTY_REVIEWER_DIMENSIONS:
                raise SystemExit(
                    f"Task {task_id} difficulty.reviewerAssessments[{index}].dimension must be one of: "
                    f"{', '.join(sorted(VALID_DIFFICULTY_REVIEWER_DIMENSIONS))}."
                )
            assessment = {
                "pct": normalize_difficulty_percent_value(
                    raw_assessment.get("pct"),
                    f"Task {task_id} difficulty.reviewerAssessments[{index}].pct",
                ),
                "dimension": dimension,
            }
            for key in ("reason", "reviewerAgentId", "reviewerRole", "gateId", "gateAttemptId", "capturedAt"):
                value = optional_non_empty_string(raw_assessment, key)
                if value is not None:
                    assessment[key] = value
            normalized_assessments.append(assessment)
        difficulty["reviewerAssessments"] = normalized_assessments
    return difficulty or None

def normalize_scope_expansion(raw: Any, task_id: str, index: int) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        raise SystemExit(f"Task {task_id} evidence.scopeExpansions entries must be objects.")

    path = str(raw.get("path") or "").strip()
    if not path:
        raise SystemExit(f"Task {task_id} evidence.scopeExpansions[{index}].path cannot be empty.")
    reject_absolute_path_values([path], f"Task {task_id} evidence.scopeExpansions[{index}].path")

    reason = str(raw.get("reason") or "").strip()
    if not reason:
        raise SystemExit(f"Task {task_id} evidence.scopeExpansions[{index}].reason cannot be empty.")

    expansion = {"path": path, "reason": reason}
    risk = str(raw.get("risk") or "").strip()
    if risk:
        expansion["risk"] = risk
    return expansion

def normalize_scope_expansions(raw: Any, task_id: str) -> List[Dict[str, Any]]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise SystemExit(f"Task {task_id} evidence.scopeExpansions must be a list.")
    return [normalize_scope_expansion(entry, task_id, index) for index, entry in enumerate(raw)]

def normalize_diff_evidence(raw: Any, task_id: str) -> List[Dict[str, Any]]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise SystemExit(f"Task {task_id} evidence.diffs must be a list.")
    normalized: List[Dict[str, Any]] = []
    for index, entry in enumerate(raw):
        if not isinstance(entry, dict):
            raise SystemExit(f"Task {task_id} evidence.diffs[{index}] must be an object.")
        path = str(entry.get("path") or "").strip()
        if not path:
            raise SystemExit(f"Task {task_id} evidence.diffs[{index}].path cannot be empty.")
        try:
            folder_store.validate_project_relative_path(path, field=f"Task {task_id} evidence.diffs[{index}].path")
        except ValueError as exc:
            raise SystemExit(str(exc)) from exc
        old_path = str(entry.get("oldPath") or "").strip()
        if old_path:
            try:
                folder_store.validate_project_relative_path(old_path, field=f"Task {task_id} evidence.diffs[{index}].oldPath")
            except ValueError as exc:
                raise SystemExit(str(exc)) from exc
        normalized.append(dict(entry))
    return normalized

def normalize_task(raw: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        raise SystemExit("Each task must be an object.")
    task_id = str(raw.get("id", "")).strip()
    title = str(raw.get("title", "")).strip()
    role = str(raw.get("role", "")).strip()
    if not task_id:
        raise SystemExit("Each task must have a non-empty id.")
    if not title:
        raise SystemExit(f"Task {task_id} must have a non-empty title.")
    role = require_configured_role(role, context=f"Task {task_id}")
    status = str(raw.get("status", "todo")).strip() or "todo"
    if status not in VALID_TASK_STATUSES:
        raise SystemExit(f"Task {task_id} has invalid status {status!r}.")
    ev = raw.get("evidence") if isinstance(raw.get("evidence"), dict) else {}
    owned_paths = [str(i).strip() for i in raw.get("ownedPaths", []) if str(i).strip()]
    touched_files = [str(i).strip() for i in ev.get("touchedFiles", []) if str(i).strip()]
    reject_absolute_path_values(owned_paths, f"Task {task_id} ownedPaths")
    reject_absolute_path_values(touched_files, f"Task {task_id} evidence.touchedFiles")
    task = {
        "id": task_id,
        "title": title,
        "description": str(raw.get("description", "")).strip(),
        "role": role,
        "status": status,
        "ownerAgentId": raw.get("ownerAgentId") or None,
        "dependsOn": [str(i).strip() for i in raw.get("dependsOn", []) if str(i).strip()],
        "ownedPaths": owned_paths,
        "acceptanceCriteria": [str(i).strip() for i in raw.get("acceptanceCriteria", []) if str(i).strip()],
        "implementationNotes": [str(i).strip() for i in raw.get("implementationNotes", []) if str(i).strip()],
        "evidence": {
            "summary": str(ev.get("summary", "")).strip(),
            "touchedFiles": touched_files,
            "commandsRan": [str(i).strip() for i in ev.get("commandsRan", []) if str(i).strip()],
            "results": [str(i).strip() for i in ev.get("results", []) if str(i).strip()],
            "scopeExpansions": normalize_scope_expansions(ev.get("scopeExpansions"), task_id),
        },
        "notes": [str(i).strip() for i in raw.get("notes", []) if str(i).strip()],
        "startedAt": raw.get("startedAt") or None,
        "completedAt": raw.get("completedAt") or None,
        "needsTriage": normalize_needs_triage(raw.get("needsTriage"), task_id),
        # Execution identity: the CLI model/CLI that worked this task, stamped at
        # claim (see assign_task). Retained through handoff for attribution and
        # per-task usage metrics — a fact about the work, not lifecycle state.
        "model": optional_non_empty_string(raw, "model"),
        "cli": optional_non_empty_string(raw, "cli"),
    }
    diff_evidence = normalize_diff_evidence(ev.get("diffs"), task_id)
    if diff_evidence:
        task["evidence"]["diffs"] = diff_evidence
    commit_evidence = unique_strings([str(i).strip() for i in ev.get("commits", []) if str(i).strip()])
    if commit_evidence:
        task["evidence"]["commits"] = commit_evidence
    if "productFacing" in raw:
        task["productFacing"] = bool(raw.get("productFacing"))
    if "producesImplementation" in raw:
        task["producesImplementation"] = bool(raw.get("producesImplementation"))
    source = normalize_task_source(raw.get("source"), task_id)
    if source is not None:
        task["source"] = source
    needs_input = normalize_task_needs_input(raw.get("needsInput"), task_id)
    if needs_input is not None:
        task["needsInput"] = needs_input
    difficulty = normalize_task_difficulty(raw.get("difficulty"), task_id)
    if difficulty is not None:
        task["difficulty"] = difficulty
    if isinstance(raw.get("triage"), dict):
        task["triage"] = raw["triage"]
    if isinstance(raw.get("qualityGates"), list):
        task["qualityGates"] = [
            gate
            for index, raw_gate in enumerate(raw["qualityGates"])
            if (gate := folder_store.normalize_quality_gate(raw_gate, f"gate-{index + 1}")) is not None
        ]
    return task

def reject_absolute_path_values(values: Optional[List[str]], field: str) -> None:
    if not values:
        return
    for value in values:
        try:
            folder_store.validate_project_relative_path(str(value), field=field)
        except ValueError as exc:
            raise SystemExit(str(exc)) from exc

def next_task_id(tasks: List[Dict[str, Any]]) -> str:
    used = {str(t.get("id", "")) for t in tasks if isinstance(t, dict)}
    index = 1
    while f"T{index}" in used:
        index += 1
    return f"T{index}"

def canonical_quality_gate_id(value: str) -> str:
    normalized = str(value or "").strip().replace("-", "_")
    aliases = {
        "architect": "architect_review",
        "architect_review": "architect_review",
        "frontend": "frontend_review",
        "frontend_review": "frontend_review",
        "code_review": "code_reviewer",
        "code_reviewer": "code_reviewer",
        "nuclear_review": "nuclear_reviewer",
        "nuclear_reviewer": "nuclear_reviewer",
        "spec_review": "spec_reviewer",
        "spec_reviewer": "spec_reviewer",
        "validation": "tester",
        "test": "tester",
        "tester": "tester",
        "product_acceptance": "product",
        "product": "product",
        "security_review": "security",
        "security": "security",
        "performance_review": "performance",
        "performance": "performance",
        "production_readiness_review": "production_readiness_reviewer",
        "production_readiness": "production_readiness_reviewer",
        "production_readiness_reviewer": "production_readiness_reviewer",
        "cross_platform_review": "cross_platform",
        "cross_platform": "cross_platform",
    }
    return aliases.get(normalized, normalized)

def quality_gate_spec_for_id(
    gate_id: str,
    policy: Dict[str, Any],
    *,
    workspace_root: Optional[Path] = None,
) -> Optional[Dict[str, Any]]:
    canonical = canonical_quality_gate_id(gate_id)
    gate_specs = policy.get("gates") if isinstance(policy.get("gates"), dict) else {}
    if canonical == "architect_review":
        spec = gate_specs.get("architect")
        return {"id": "architect_review", **spec} if isinstance(spec, dict) else None
    if canonical == "frontend_review":
        return {
            "id": "frontend_review",
            "phase": "review",
            "role": "frontend",
            "required": True,
            "focus": "UI behavior, accessibility, responsive behavior, status labels, and interaction correctness",
        }
    spec = gate_specs.get(canonical)
    if isinstance(spec, dict):
        return {"id": canonical, **spec}
    registry = discover_role_registry(workspace_root=workspace_root)
    try:
        role_entry = registry.role_entry(canonical)
    except KeyError:
        return None
    role = role_entry.value
    if not isinstance(role, RoleManifest):
        return None
    review_capability = next((capability for capability in role.capabilities if capability.kind == "review"), None)
    if review_capability is None:
        return None
    return {
        "id": canonical,
        "phase": review_capability.phase or "review",
        "role": role.normalized_id,
        "required": True,
        "focus": review_capability.default_focus or role.summary or f"{role.label} review",
    }

def build_quality_gate_from_spec(
    gate_id: str,
    spec: Dict[str, Any],
    state: Dict[str, Any],
    *,
    workspace_root: Optional[Path] = None,
) -> Dict[str, Any]:
    role = str(spec.get("role") or "").strip()
    if not role:
        raise SystemExit(f"Quality gate {gate_id!r} has no role.")
    registry = discover_role_registry(workspace_root=workspace_root)
    role = require_configured_role(role, context=f"Quality gate {gate_id!r}", discovery=registry)
    if roster_is_configured(state) and role not in roster_roles(state):
        raise SystemExit(f"Quality gate {gate_id!r} requires role {role!r}, which is not in this Sprint Engine roster.")
    phase = str(spec.get("phase") or "").strip()
    if phase not in {"review", "testing", "product"}:
        raise SystemExit(f"Quality gate {gate_id!r} has invalid phase {phase!r}.")
    return {
        "id": canonical_quality_gate_id(str(spec.get("id") or gate_id)),
        "phase": phase,
        "role": role,
        "status": "pending",
        "required": bool(spec.get("required", True)),
        "allowSelfReview": True,
        "focus": str(spec.get("focus") or ""),
        "attempts": [],
    }

def apply_quality_gate_cli_overrides(task: Dict[str, Any], state: Dict[str, Any], policy: Dict[str, Any], args: argparse.Namespace) -> None:
    if getattr(args, "no_quality_gates", False):
        task["qualityGates"] = []
        return

    gates = list(task.get("qualityGates", []) if isinstance(task.get("qualityGates"), list) else [])
    if getattr(args, "no_review", False):
        gates = [gate for gate in gates if gate.get("phase") != "review"]
    if getattr(args, "no_testing", False):
        gates = [gate for gate in gates if gate.get("phase") != "testing"]
    if getattr(args, "no_product_acceptance", False):
        gates = [gate for gate in gates if gate.get("phase") != "product" and canonical_quality_gate_id(str(gate.get("id") or "")) != "product"]

    skip_ids = {canonical_quality_gate_id(value) for value in (getattr(args, "skip_gate", None) or [])}
    if skip_ids:
        gates = [gate for gate in gates if canonical_quality_gate_id(str(gate.get("id") or "")) not in skip_ids]

    existing_ids = {canonical_quality_gate_id(str(gate.get("id") or "")) for gate in gates}
    workspace_root = workspace_root_for_state_path(args.state) if getattr(args, "state", None) else None
    for required_id in getattr(args, "require_gate", None) or []:
        canonical = canonical_quality_gate_id(required_id)
        if canonical in existing_ids:
            continue
        spec = quality_gate_spec_for_id(canonical, policy, workspace_root=workspace_root)
        if spec is None:
            raise SystemExit(f"Unknown quality gate {required_id!r}.")
        gates.append(build_quality_gate_from_spec(canonical, spec, state, workspace_root=workspace_root))
        existing_ids.add(canonical)

    task["qualityGates"] = gates

def build_task_from_args(args: argparse.Namespace, state: Dict[str, Any]) -> Dict[str, Any]:
    task_id = getattr(args, "task_id", None) or next_task_id(state.get("tasks", []))
    if (
        folder_store.normalize_quality_policy(state.get("sprintengine", {}).get("qualityPolicy") if isinstance(state.get("sprintengine"), dict) else {}).get("enabled", True)
        and not roster_is_configured(state)
    ):
        raise SystemExit("Cannot add quality-gated Sprint Engine tasks before configuring a roster.")
    reject_absolute_path_values(getattr(args, "path", None), "--path")
    raw = {
        "id": task_id,
        "title": args.title,
        "description": getattr(args, "description", "") or "",
        "role": args.role,
        "status": "todo",
        "ownerAgentId": None,
        "dependsOn": getattr(args, "depends_on", None) or [],
        "ownedPaths": getattr(args, "path", None) or [],
        "acceptanceCriteria": getattr(args, "acceptance", None) or [],
        "implementationNotes": getattr(args, "note", None) or [],
        "evidence": {"summary": "", "touchedFiles": [], "commandsRan": [], "results": [], "scopeExpansions": []},
        "notes": getattr(args, "task_note", None) or [],
        "startedAt": None,
        "completedAt": None,
    }
    if getattr(args, "product_facing", False) and getattr(args, "not_product_facing", False):
        raise SystemExit("--product-facing and --not-product-facing cannot be used together.")
    if getattr(args, "product_facing", False):
        raw["productFacing"] = True
    elif getattr(args, "not_product_facing", False):
        raw["productFacing"] = False
    if getattr(args, "produces_implementation", False):
        raw["producesImplementation"] = True
    if getattr(args, "needs_triage", False):
        raw["needsTriage"] = True
    if getattr(args, "difficulty_pct", None) is not None or str(getattr(args, "difficulty_reason", "") or "").strip():
        raw["difficulty"] = {}
        if getattr(args, "difficulty_pct", None) is not None:
            raw["difficulty"]["architectEstimatePct"] = getattr(args, "difficulty_pct")
        if str(getattr(args, "difficulty_reason", "") or "").strip():
            raw["difficulty"]["architectEstimateReason"] = getattr(args, "difficulty_reason")
    task = normalize_task(raw)
    policy = folder_store.normalize_quality_fields(state)
    task["qualityGates"] = folder_store.normalize_task_quality_gates(task, state, policy)
    apply_quality_gate_cli_overrides(task, state, policy, args)
    existing_ids = {str(t.get("id")) for t in state.get("tasks", []) if isinstance(t, dict)}
    if task["id"] in existing_ids:
        raise SystemExit(f"Task id already exists: {task['id']}")
    missing = [dep for dep in task["dependsOn"] if dep not in existing_ids]
    if missing:
        raise SystemExit(f"Unknown dependency for {task['id']}: {', '.join(missing)}")
    try:
        folder_store.validate_acyclic_task_graph([*state.get("tasks", []), task])
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc
    return task

def task_ids(state: Dict[str, Any]) -> set:
    return {str(t.get("id")) for t in state.get("tasks", []) if isinstance(t, dict) and t.get("id")}

def ensure_task_can_be_replanned(task: Dict[str, Any], force: bool = False) -> None:
    if force:
        return
    if task.get("status") != "todo" or task.get("ownerAgentId"):
        raise SystemExit(
            f"Task {task.get('id')} has already started. "
            "Use --force only if you intentionally want to replan active or completed work."
        )

def set_unique_list(task: Dict[str, Any], key: str, values: Optional[List[str]]) -> None:
    if values is None:
        return
    if key in {"ownedPaths", "touchedFiles"}:
        reject_absolute_path_values(values, key)
    task[key] = unique_strings(values)

def add_unique_values(task: Dict[str, Any], key: str, values: List[str]) -> List[str]:
    if key in {"ownedPaths", "touchedFiles"}:
        reject_absolute_path_values(values, key)
    existing = task.setdefault(key, [])
    seen = set(existing)
    added = []
    for value in values:
        item = str(value).strip()
        if not item or item in seen:
            continue
        existing.append(item)
        seen.add(item)
        added.append(item)
    return added

def add_unique_scope_expansions(evidence: Dict[str, Any], expansions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    existing = evidence.setdefault("scopeExpansions", [])
    seen = {
        (
            str(item.get("path") or ""),
            str(item.get("reason") or ""),
            str(item.get("risk") or ""),
        )
        for item in existing
        if isinstance(item, dict)
    }
    added = []
    for expansion in expansions:
        key = (
            str(expansion.get("path") or ""),
            str(expansion.get("reason") or ""),
            str(expansion.get("risk") or ""),
        )
        if key in seen:
            continue
        existing.append(expansion)
        seen.add(key)
        added.append(expansion)
    return added

def remove_values(task: Dict[str, Any], key: str, values: List[str]) -> List[str]:
    targets = {str(value).strip() for value in values if str(value).strip()}
    before = [str(value) for value in task.get(key, [])]
    task[key] = [value for value in before if value not in targets]
    return [value for value in before if value in targets]

def task_dependents(state: Dict[str, Any], task_id: str) -> List[str]:
    return [
        str(task.get("id"))
        for task in state.get("tasks", [])
        if isinstance(task, dict) and task_id in task.get("dependsOn", [])
    ]
