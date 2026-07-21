"""Closed reviewer-requested task rework loops."""
from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional

from sprintengine_core.role_registry import discover_role_registry
from sprintengine_core.tool.paths import now_iso, workspace_root_for_state_path
from sprintengine_core.tool.state import (
    append_agent_notification_event,
    append_task_activity,
    create_task_comment,
    end_lease,
    find_task,
    mint_lease,
    worker_role,
)

OPEN_REVIEW_REQUEST_STATUSES = {"rework", "awaiting_reapproval", "escalated"}
DEFAULT_REVIEW_REWORK_CYCLE_CAP = 3


def normalize_open_review_request(raw: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict):
        return None
    request_id = str(raw.get("id") or "").strip()
    requester = str(raw.get("requestedByAgentId") or "").strip()
    source_task_id = str(raw.get("sourceTaskId") or "").strip()
    status = str(raw.get("status") or "").strip()
    requested_role = str(raw.get("requestedByRole") or "").strip()
    requested_at = str(raw.get("requestedAt") or "").strip()
    if (
        not request_id
        or not requester
        or not requested_role
        or not source_task_id
        or not requested_at
        or status not in OPEN_REVIEW_REQUEST_STATUSES
    ):
        return None
    cycle = raw.get("cycle")
    if not isinstance(cycle, int) or isinstance(cycle, bool) or cycle < 1:
        cycle = 1
    result: Dict[str, Any] = {
        "id": request_id,
        "status": status,
        "requestedByAgentId": requester,
        "requestedByRole": requested_role,
        "sourceTaskId": source_task_id,
        "cycle": cycle,
        "requestedAt": requested_at,
        "feedbackCommentIds": [
            str(value).strip() for value in raw.get("feedbackCommentIds", []) or [] if str(value).strip()
        ],
    }
    for key in ("implementationAgentId", "reworkedAt"):
        value = str(raw.get(key) or "").strip()
        if value:
            result[key] = value
    runtime = raw.get("reviewerRuntime")
    if isinstance(runtime, dict):
        cli = str(runtime.get("cli") or "").strip()
        model = str(runtime.get("model") or "").strip()
        if cli:
            result["reviewerRuntime"] = {"cli": cli, "model": model or None}
    return result


def open_review_request(task: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    request = normalize_open_review_request(task.get("openReviewRequest"))
    return request if request and request.get("status") in OPEN_REVIEW_REQUEST_STATUSES else None


def outbound_review_requests(state: Dict[str, Any], source_task_id: str) -> List[Dict[str, Any]]:
    clean_source = str(source_task_id or "").strip()
    return [
        {"task": task, "request": request}
        for task in state.get("tasks", []) or []
        if isinstance(task, dict)
        for request in [open_review_request(task)]
        if request and request.get("sourceTaskId") == clean_source
    ]


def pending_phase_reapproval_for_reviewer(state: Dict[str, Any], reviewer_id: str) -> Optional[Dict[str, Any]]:
    """Return the target reserved for a phase reviewer until its thread closes.

    The stable requester id is the approval authority. Letting that identity
    claim unrelated ready work while implementation is in flight would either
    violate one-lease capacity at reapproval time or force an implicit reviewer
    substitution, so ordinary dispatch treats the open thread as a reservation.
    """
    clean_reviewer = str(reviewer_id or "").strip()
    for task in state.get("tasks", []) or []:
        if not isinstance(task, dict):
            continue
        request = open_review_request(task)
        if (
            request
            and request.get("sourceTaskId") == task.get("id")
            and request.get("requestedByAgentId") == clean_reviewer
        ):
            return task
    return None


def assert_task_can_complete(state: Dict[str, Any], task: Dict[str, Any]) -> None:
    request = open_review_request(task)
    if request:
        raise SystemExit(
            f"open_review_request: task {task.get('id')} cannot complete until review request "
            f"{request.get('id')} is approved."
        )
    outbound = outbound_review_requests(state, str(task.get("id") or ""))
    if outbound:
        targets = ", ".join(str(entry["task"].get("id")) for entry in outbound)
        raise SystemExit(
            f"open_outbound_review_request: review task {task.get('id')} cannot complete while "
            f"requested rework is open on {targets}."
        )


def _depends_transitively(state: Dict[str, Any], source_task_id: str, target_task_id: str) -> bool:
    by_id = {
        str(task.get("id")): task
        for task in state.get("tasks", []) or []
        if isinstance(task, dict) and task.get("id")
    }
    pending = list((by_id.get(source_task_id) or {}).get("dependsOn", []) or [])
    seen: set[str] = set()
    while pending:
        candidate = str(pending.pop()).strip()
        if not candidate or candidate in seen:
            continue
        if candidate == target_task_id:
            return True
        seen.add(candidate)
        pending.extend((by_id.get(candidate) or {}).get("dependsOn", []) or [])
    return False


def _is_sweep_role(state_path: Path, role: str) -> bool:
    registry = discover_role_registry(workspace_root=workspace_root_for_state_path(state_path))
    try:
        manifest = registry.get_role(role)
    except KeyError:
        return False
    return getattr(manifest, "sweep", None) is not None


def _cycle_cap(state: Dict[str, Any]) -> int:
    policy = state.get("sprintengine", {}).get("reviewPolicy")
    raw = policy.get("maxReworkCycles") if isinstance(policy, dict) else None
    return raw if isinstance(raw, int) and not isinstance(raw, bool) and raw > 0 else DEFAULT_REVIEW_REWORK_CYCLE_CAP


def _next_request_id(task: Dict[str, Any]) -> str:
    max_index = 0
    for activity in task.get("activity", []) or []:
        if not isinstance(activity, dict):
            continue
        request_id = str((activity.get("reviewRequestId") or "")).strip()
        if request_id.startswith("RR") and request_id[2:].isdigit():
            max_index = max(max_index, int(request_id[2:]))
    current = normalize_open_review_request(task.get("openReviewRequest"))
    if current and str(current.get("id", "")).startswith("RR") and str(current["id"])[2:].isdigit():
        max_index = max(max_index, int(str(current["id"])[2:]))
    return f"RR{max_index + 1}"


def _resolve_feedback(task: Dict[str, Any], comment_ids: List[str], actor: str) -> None:
    wanted = set(comment_ids)
    for comment in task.get("comments", []) or []:
        if not isinstance(comment, dict) or str(comment.get("id")) not in wanted:
            continue
        data = dict(comment.get("data") or {}) if isinstance(comment.get("data"), dict) else {}
        data.update({"status": "resolved", "resolvedBy": actor, "resolvedAt": now_iso()})
        comment["data"] = data


def request_task_changes(
    state: Dict[str, Any],
    state_path: Path,
    target: Dict[str, Any],
    actor: str,
    feedback: str,
    *,
    source_task_id: Optional[str] = None,
    paths: Optional[List[str]] = None,
    findings: Optional[List[Any]] = None,
) -> Dict[str, Any]:
    requester = str(actor or "").strip()
    if not requester:
        raise SystemExit("Reviewer id is required.")
    clean_feedback = str(feedback or "").strip()
    if not clean_feedback:
        raise SystemExit("review_feedback_required: blocking feedback cannot be empty.")
    target_id = str(target.get("id") or "")
    explicit_source_id = str(source_task_id or "").strip()
    if explicit_source_id:
        source_id = explicit_source_id
    elif target.get("status") == "review" and str(target.get("ownerAgentId") or "") == requester:
        source_id = target_id
    else:
        owned_sources = [
            str(candidate.get("id") or "")
            for candidate in state.get("tasks", []) or []
            if isinstance(candidate, dict)
            and candidate.get("id") != target_id
            and candidate.get("status") in {"in_progress", "review", "needs_input"}
            and str(candidate.get("ownerAgentId") or "") == requester
        ]
        if len(owned_sources) != 1:
            raise SystemExit(
                "review_source_ambiguous: pass sourceTaskId unless the requester owns exactly one active review source."
            )
        source_id = owned_sources[0]
    source = find_task(state, source_id)
    phase_review = source_id == target_id
    existing = open_review_request(target)

    if existing:
        if existing.get("requestedByAgentId") != requester or existing.get("sourceTaskId") != source_id:
            raise SystemExit(
                f"review_request_conflict: {target_id} already has open request {existing.get('id')} "
                f"owned by {existing.get('requestedByAgentId')}."
            )
        if existing.get("status") != "awaiting_reapproval":
            raise SystemExit(f"review_request_not_awaiting_reapproval: {existing.get('id')} is in {existing.get('status')}.")
        cycle = int(existing.get("cycle") or 1) + 1
        request_id = str(existing.get("id"))
    else:
        cycle = 1
        request_id = _next_request_id(target)

    if phase_review:
        if target.get("status") != "review" or str(target.get("ownerAgentId") or "") != requester:
            raise SystemExit("phase_review_request_requires_owned_review: requester must own the target review phase.")
        if str(target.get("lastImplementedByAgentId") or "") == requester:
            raise SystemExit("independent_reviewer_required: self-review cannot open an independent rework request.")
        if not str(target.get("cli") or "").strip():
            raise SystemExit("reviewer_runtime_unavailable: independent reviewer CLI identity was not recorded.")
    else:
        if str(source.get("ownerAgentId") or "") != requester or source.get("status") not in {"in_progress", "review", "needs_input"}:
            raise SystemExit("cross_task_review_requires_source_owner: requester must own an active review source task.")
        from sprintengine_core.tool.plans import resolve_planning_role
        requester_role = worker_role(state, requester) or str(source.get("role") or "")
        if requester_role != resolve_planning_role(state) and not _is_sweep_role(state_path, requester_role):
            raise SystemExit("cross_task_review_role_not_permitted: source owner must be the planner or a manifest sweep role.")
        if not _depends_transitively(state, source_id, target_id):
            raise SystemExit("review_target_not_dependency: the review source must depend transitively on the target.")
        if target.get("status") not in {"done", "review"}:
            raise SystemExit("cross_task_review_target_not_reviewable: target must be done or awaiting reapproval.")

    comment = create_task_comment(
        state,
        target,
        actor=requester,
        body=clean_feedback,
        comment_type="review_feedback",
        source="agent",
        paths=paths or [],
        data={"status": "open", "reviewRequestId": request_id, "findings": list(findings or [])},
    )
    feedback_ids = list(existing.get("feedbackCommentIds", []) if existing else [])
    feedback_ids.append(comment["id"])
    implementation_agent = str(target.get("lastImplementedByAgentId") or "").strip()
    reviewer_runtime = {
        "cli": str(target.get("cli") or "").strip(),
        "model": str(target.get("model") or "").strip() or None,
    }
    request: Dict[str, Any] = {
        "id": request_id,
        "status": "rework",
        "requestedByAgentId": requester,
        "requestedByRole": worker_role(state, requester) or str(source.get("role") or ""),
        "sourceTaskId": source_id,
        "implementationAgentId": implementation_agent,
        "cycle": cycle,
        "requestedAt": str((existing or {}).get("requestedAt") or now_iso()),
        "feedbackCommentIds": feedback_ids,
    }
    if phase_review and reviewer_runtime["cli"]:
        request["reviewerRuntime"] = reviewer_runtime

    if cycle > _cycle_cap(state):
        request["status"] = "escalated"
        target["openReviewRequest"] = request
        target["status"] = "todo"
        target["needsTriage"] = True
        target["ownerAgentId"] = None
        target["completedAt"] = None
        end_lease(target)
        source["status"] = "needs_input"
        if phase_review:
            source["ownerAgentId"] = requester
            mint_lease(source, requester, source.get("role"))
        source["needsInput"] = {
            "kind": "architect",
            "reason": "task_scope",
            "question": f"Review request {request_id} exceeded {_cycle_cap(state)} rework cycles on {target_id}.",
            "suggestedResolution": "Repair the plan/task graph, explicitly reassign the reviewer if needed, or close the thread with rationale.",
            "reportedBy": requester,
            "reportedAt": now_iso(),
        }
        append_task_activity(target, "needs_input", requester, f"{request_id} escalated after repeated rework.", {"reviewRequestId": request_id, "cycle": cycle})
        return {"request": request, "comment": comment, "status": "escalated"}

    target["openReviewRequest"] = request
    target["preferredOwnerAgentId"] = implementation_agent or None
    target["status"] = "todo"
    target.pop("needsTriage", None)
    target["ownerAgentId"] = None
    target["completedAt"] = None
    target.pop("awaitingPhaseSession", None)
    target.pop("needsInput", None)
    end_lease(target)
    append_task_activity(
        target,
        "status_change",
        requester,
        f"{requester} requested changes on {target_id}; implementation returned to the ready queue.",
        {"status": "todo", "reviewRequestId": request_id, "cycle": cycle, "preferredOwnerAgentId": implementation_agent},
    )
    notification = append_agent_notification_event(
        state,
        requester,
        implementation_agent or None,
        target_id,
        "task_rework_requested",
        f"Review {request_id} requests changes on {target_id}.",
    )
    return {"request": request, "comment": comment, "status": "rework", "notification": notification}


def route_published_rework_to_reapproval(state: Dict[str, Any], task: Dict[str, Any], actor: str) -> Optional[Dict[str, Any]]:
    request = open_review_request(task)
    if not request or request.get("status") != "rework":
        return None
    request["status"] = "awaiting_reapproval"
    request["reworkedAt"] = now_iso()
    task["openReviewRequest"] = request
    # publish_task has already entered the review walk through its sole phase
    # transition. Keep this helper limited to request/ownership routing so no
    # second writer can put a task into a phase.
    task["completedAt"] = None
    task.pop("needsInput", None)
    task.pop("preferredOwnerAgentId", None)
    source_id = str(request.get("sourceTaskId") or "")
    if source_id == str(task.get("id") or ""):
        runtime = request.get("reviewerRuntime")
        if not isinstance(runtime, dict) or not str(runtime.get("cli") or "").strip():
            raise SystemExit("reviewer_runtime_unavailable: cannot restore the requesting phase reviewer.")
        task["ownerAgentId"] = None
        end_lease(task)
        task["awaitingPhaseSession"] = {
            "phase": "review",
            "runtime": runtime,
            "agentId": request.get("requestedByAgentId"),
            "role": request.get("requestedByRole"),
        }
    else:
        task["ownerAgentId"] = None
        end_lease(task)
        task.pop("awaitingPhaseSession", None)
        append_agent_notification_event(
            state,
            actor,
            str(request.get("requestedByAgentId") or "") or None,
            str(task.get("id") or ""),
            "task_rework_ready_for_approval",
            f"{task.get('id')} was reworked and awaits review request {request.get('id')} approval.",
        )
    return request


def phase_review_request_for_approval(task: Dict[str, Any], actor: str) -> Optional[Dict[str, Any]]:
    request = open_review_request(task)
    if not request or request.get("status") != "awaiting_reapproval" or request.get("sourceTaskId") != task.get("id"):
        return None
    if request.get("requestedByAgentId") != actor:
        raise SystemExit("review_approver_mismatch: only the requesting reviewer may approve this rework.")
    return request


def close_review_request(task: Dict[str, Any], request: Dict[str, Any], actor: str) -> None:
    _resolve_feedback(task, list(request.get("feedbackCommentIds") or []), actor)
    task.pop("openReviewRequest", None)
    task.pop("preferredOwnerAgentId", None)


def reassign_review_request(
    state: Dict[str, Any],
    target: Dict[str, Any],
    actor: str,
    new_reviewer_id: str,
    new_reviewer_role: str,
    reason: str,
    *,
    reviewer_cli: Optional[str] = None,
    reviewer_model: Optional[str] = None,
) -> Dict[str, Any]:
    """Planner repair for a requester that cannot resume.

    This is deliberately explicit: approval authority never follows a source
    lease or role change silently. The caller records one canonical event after
    this mutation succeeds.
    """
    request = open_review_request(target)
    if not request:
        raise SystemExit("open_review_request_required: target has no review authority to reassign.")
    clean_actor = str(actor or "").strip()
    clean_id = str(new_reviewer_id or "").strip()
    clean_role = str(new_reviewer_role or "").strip()
    clean_reason = str(reason or "").strip()
    if not clean_actor or not clean_id or not clean_role or not clean_reason:
        raise SystemExit("review_reassignment_fields_required: actor, reviewer id/role, and reason are required.")

    from sprintengine_core.tool.plans import resolve_planning_role
    planning_role = resolve_planning_role(state)
    known_actor_role = worker_role(state, clean_actor)
    if known_actor_role and known_actor_role != planning_role:
        raise SystemExit("review_reassignment_requires_planner: only the run planning role may replace approval authority.")

    source_id = str(request.get("sourceTaskId") or "")
    phase_review = source_id == str(target.get("id") or "")
    previous_reviewer = str(request.get("requestedByAgentId") or "")
    request["requestedByAgentId"] = clean_id
    request["requestedByRole"] = clean_role

    if phase_review:
        runtime = dict(request.get("reviewerRuntime") or {}) if isinstance(request.get("reviewerRuntime"), dict) else {}
        cli = str(reviewer_cli or runtime.get("cli") or "").strip()
        model = str(reviewer_model or runtime.get("model") or "").strip()
        if not cli:
            raise SystemExit("reviewer_runtime_unavailable: replacement phase reviewer needs a CLI runtime.")
        request["reviewerRuntime"] = {"cli": cli, "model": model or None}
    else:
        source = find_task(state, source_id)
        if (
            str(source.get("ownerAgentId") or "") != clean_id
            or source.get("status") not in {"in_progress", "review", "needs_input"}
        ):
            raise SystemExit(
                "replacement_review_source_not_owned: recover/reassign the source task to the replacement reviewer first."
            )

    if request.get("status") == "escalated":
        request["status"] = "rework"
        target["status"] = "todo"
        target["ownerAgentId"] = None
        target["completedAt"] = None
        target["preferredOwnerAgentId"] = request.get("implementationAgentId") or None
        target.pop("needsInput", None)
        target.pop("needsTriage", None)
        target.pop("awaitingPhaseSession", None)
        end_lease(target)
    elif request.get("status") == "awaiting_reapproval" and phase_review:
        if target.get("status") != "review":
            raise SystemExit("review_target_not_ready: awaiting phase reapproval target must remain in review.")
        target["ownerAgentId"] = None
        target["completedAt"] = None
        end_lease(target)
        target["awaitingPhaseSession"] = {
            "phase": "review",
            "runtime": request["reviewerRuntime"],
            "agentId": clean_id,
            "role": clean_role,
        }
    elif request.get("status") == "awaiting_reapproval":
        append_agent_notification_event(
            state,
            clean_actor,
            clean_id,
            str(target.get("id") or ""),
            "task_rework_ready_for_approval",
            f"You now own approval for review request {request.get('id')} on {target.get('id')}.",
        )

    target["openReviewRequest"] = request
    append_task_activity(
        target,
        "status_change",
        clean_actor,
        f"{clean_actor} reassigned review request {request.get('id')} from {previous_reviewer} to {clean_id}: {clean_reason}",
        {
            "reviewRequestId": request.get("id"),
            "previousReviewerAgentId": previous_reviewer,
            "reviewerAgentId": clean_id,
            "reason": clean_reason,
        },
    )
    return request


def approve_cross_task_rework(state: Dict[str, Any], target: Dict[str, Any], actor: str, source_task_id: str, summary: str) -> Dict[str, Any]:
    clean_summary = str(summary or "").strip()
    if not clean_summary:
        raise SystemExit("rework_approval_summary_required: approval summary cannot be empty.")
    request = open_review_request(target)
    if not request or request.get("status") != "awaiting_reapproval":
        raise SystemExit("review_request_not_awaiting_reapproval: target has no rework ready to approve.")
    if request.get("sourceTaskId") == target.get("id"):
        raise SystemExit("phase_review_uses_advance: an independent phase reviewer approves with task.advance.")
    if request.get("sourceTaskId") != source_task_id or request.get("requestedByAgentId") != actor:
        raise SystemExit("review_approver_mismatch: only the stored requester/source task may approve this rework.")
    source = find_task(state, source_task_id)
    if str(source.get("ownerAgentId") or "") != actor:
        raise SystemExit("review_source_not_owned: requester must still own the source review task.")
    if target.get("status") != "review" or target.get("ownerAgentId"):
        raise SystemExit("review_target_not_ready: target must be unowned in review.")
    comment = create_task_comment(
        state,
        target,
        actor=actor,
        body=clean_summary,
        comment_type="implementation_summary",
        source="agent",
        data={"reviewRequestId": request.get("id"), "outcome": "approved"},
    )
    close_review_request(target, request, actor)
    target["status"] = "done"
    target["completedAt"] = now_iso()
    target["ownerAgentId"] = None
    end_lease(target)
    append_task_activity(target, "status_change", actor, f"{actor} approved rework on {target.get('id')}.", {"status": "done", "reviewRequestId": request.get("id")})
    return {"request": request, "comment": comment}
