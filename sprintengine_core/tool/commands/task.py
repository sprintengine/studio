"""Sprint Engine task command handlers."""
from __future__ import annotations

import argparse
from typing import Any, Dict, List

from sprintengine_core import store as folder_store
from sprintengine_core.tool.artifacts import release_task_from_owner, resolve_task_input
from sprintengine_core.tool.common import parse_json_object_arg
from sprintengine_core.tool.constants import ACTIVE_TASK_STATUSES, ARCHITECT_ROUTED_NEEDS_INPUT_KINDS, NEEDS_INPUT_KIND_DEFAULT_REASONS, VALID_NEEDS_INPUT_KINDS
from sprintengine_core.tool.feedback import (
    append_reviewer_difficulty_assessment,
    append_feedback_record,
    attach_feedback_payload,
    build_feedback_payload,
    feedback_args_present,
    parse_scope_expansion_args,
    set_implementer_actual_difficulty,
)
from sprintengine_core.tool.gates import (
    apply_gate_verdict,
    claim_gate_for_agent,
    find_active_gate_claim,
    gate_is_claimable_for_role,
    open_required_quality_gates,
    task_status_done_requires_closed_gates,
)
from sprintengine_core.tool.paths import now_iso
from sprintengine_core.tool.review_prompts import build_gate_review_prompt, build_rework_prompt
from sprintengine_core.tool.roles import require_configured_role
from sprintengine_core.tool.shell import commit_task_changes_if_needed
from sprintengine_core.tool.state import (
    append_agent_notification_event,
    append_event,
    append_task_activity,
    assign_task,
    clear_non_active_task_owner_claims,
    clear_task_refs,
    create_task_comment,
    ensure_gate_dispatch,
    ensure_agent,
    ensure_agent_in_roster,
    find_task,
    gate_attempts,
    dispatch_target_key,
    reconcile_agent,
    release_expired_agent_targets,
    select_round_robin_target,
    set_agent_idle,
    task_quality_gates,
    with_locked_state,
)
from sprintengine_core.tool.tasks import (
    add_unique_scope_expansions,
    add_unique_values,
    ensure_evidence,
    publish_task,
    read_ready_task_ids,
    recompute_phase,
    refresh_materialized_ready_queue,
    refresh_task_diff_evidence,
    reject_absolute_path_values,
    task_is_ready,
)
from sprintengine_core.tool.commands.run import auto_mode_continuation

def cmd_task_list(args: argparse.Namespace) -> Dict[str, Any]:
    if getattr(args, "role", None):
        args.role = require_configured_role(args.role, context="Task list")

    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        ready_ids = read_ready_task_ids(state)
        tasks_by_id = {
            str(t.get("id")): t
            for t in state.get("tasks", [])
            if isinstance(t, dict) and t.get("id")
        }
        ready = []
        for task_id in ready_ids:
            t = tasks_by_id.get(task_id)
            if not t:
                continue
            if getattr(args, "role", None) and t.get("role") != args.role:
                continue
            ready.append({"id": t.get("id"), "title": t.get("title"), "role": t.get("role"), "status": t.get("status"), "dependsOn": t.get("dependsOn", [])})
        return {"ok": True, "readyTasks": ready, "write": False}
    return with_locked_state(args.state, run)

def cmd_task_gate_list(args: argparse.Namespace) -> Dict[str, Any]:
    if getattr(args, "role", None):
        args.role = require_configured_role(args.role, context="Gate list")

    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        gates = []
        for task in state.get("tasks", []) or []:
            if not isinstance(task, dict):
                continue
            if getattr(args, "task_id", None) and task.get("id") != args.task_id:
                continue
            for gate in task_quality_gates(task):
                if getattr(args, "role", None) and gate.get("role") != args.role:
                    continue
                gates.append({
                    "taskId": task.get("id"),
                    "taskTitle": task.get("title"),
                    "taskStatus": task.get("status"),
                    "id": gate.get("id"),
                    "phase": gate.get("phase"),
                    "role": gate.get("role"),
                    "status": gate.get("status"),
                    "required": gate.get("required"),
                    "allowSelfReview": gate.get("allowSelfReview"),
                    "focus": gate.get("focus"),
                    "attempts": gate_attempts(gate),
                })
        return {"ok": True, "gates": gates, "write": False}

    return with_locked_state(args.state, run)

def cmd_task_gate_next(args: argparse.Namespace) -> Dict[str, Any]:
    args.role = require_configured_role(args.role, context="Gate")

    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        with folder_store.FolderLock(args.state.parent / folder_store.GATE_QUEUE_LOCK_FILE):
            ensure_agent_in_roster(state, args.id, args.role)
            expired = release_expired_agent_targets(state, actor="sprintengine", excluding_agent_id=args.id)
            active = find_active_gate_claim(state, args.id, args.role)
            if active:
                agent = ensure_agent(state, args.id, args.role)
                agent["status"] = "running"
                agent["currentTaskId"] = active["task"].get("id")
                agent["currentGateId"] = active["gate"].get("id")
                agent["currentGate"] = {
                    "taskId": active["task"].get("id"),
                    "gateId": active["gate"].get("id"),
                    "attemptId": active["attempt"].get("id"),
                }
                dispatch_dirty = ensure_gate_dispatch(
                    state,
                    agent,
                    active["task"],
                    active["gate"],
                    active["attempt"],
                    args.id,
                    args.role,
                )
                prompt = build_gate_review_prompt(state, args.state, active["task"], active["gate"], active["attempt"], args.id)
                return {"ok": True, "claimed": True, "resumed": True, "task": active["task"], "gate": active["gate"], "attempt": active["attempt"], "agent": agent, "prompt": prompt, "releasedExpired": expired["released"], "write": dispatch_dirty or expired["dirty"]}

            candidates = []
            for task in state.get("tasks", []) or []:
                if not isinstance(task, dict):
                    continue
                for gate in task_quality_gates(task):
                    if not gate_is_claimable_for_role(task, gate, args.role, args.id):
                        continue
                    candidates.append({"task": task, "gate": gate})
            selected = select_round_robin_target(
                state,
                role=args.role,
                target_kind="gate",
                candidates=candidates,
                key_fn=lambda item: dispatch_target_key("gate", item["task"].get("id"), item["gate"].get("id")),
            )
            if selected:
                task = selected["task"]
                gate = selected["gate"]
                result = claim_gate_for_agent(state, task, gate, args.role, args.id)
                recompute_phase(state)
                event = append_event(state, "task_gate_claimed", args.id, f"{args.id} claimed gate {gate.get('id')} on {task.get('id')}.")
                prompt = build_gate_review_prompt(state, args.state, task, gate, result["attempt"], args.id)
                return {"ok": True, "claimed": True, "resumed": False, **result, "prompt": prompt, "event": event, "releasedExpired": expired["released"]}

            phase_dirty = recompute_phase(state)
            return {"ok": True, "claimed": False, "reason": "no_ready_gate", "message": f"No ready {args.role} gates. Stop.", "releasedExpired": expired["released"], "write": phase_dirty or expired["dirty"]}

    return with_locked_state(args.state, run)

def cmd_task_gate_claim(args: argparse.Namespace) -> Dict[str, Any]:
    args.role = require_configured_role(args.role, context="Gate")

    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        with folder_store.FolderLock(args.state.parent / folder_store.GATE_QUEUE_LOCK_FILE):
            ensure_agent_in_roster(state, args.id, args.role)
            task = find_task(state, args.task_id)
            gate = next((candidate for candidate in task_quality_gates(task) if candidate.get("id") == args.gate_id), None)
            if gate is None:
                return {"ok": False, "error": "Gate not found.", "write": False}
            if not gate_is_claimable_for_role(task, gate, args.role, args.id):
                return {"ok": False, "error": "Gate is not claimable.", "task": {"id": task.get("id"), "status": task.get("status")}, "gate": {"id": gate.get("id"), "status": gate.get("status"), "role": gate.get("role"), "phase": gate.get("phase")}, "write": False}
            result = claim_gate_for_agent(state, task, gate, args.role, args.id)
            recompute_phase(state)
            event = append_event(state, "task_gate_claimed", args.id, f"{args.id} claimed gate {gate.get('id')} on {task.get('id')}.")
            prompt = build_gate_review_prompt(state, args.state, task, gate, result["attempt"], args.id)
            return {"ok": True, **result, "prompt": prompt, "event": event}

    return with_locked_state(args.state, run)

def cmd_task_gate_verdict(args: argparse.Namespace) -> Dict[str, Any]:
    args.role = require_configured_role(args.role, context="Gate")

    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        with folder_store.FolderLock(args.state.parent / folder_store.GATE_QUEUE_LOCK_FILE):
            ensure_agent_in_roster(state, args.id, args.role)
            task = find_task(state, args.task_id)
            gate = next((candidate for candidate in task_quality_gates(task) if candidate.get("id") == args.gate_id), None)
            if gate is None:
                return {"ok": False, "error": "Gate not found.", "write": False}
            if gate.get("role") != args.role:
                return {"ok": False, "error": "Gate role does not match caller role.", "write": False}
            needs_input = None
            if args.verdict == "blocked":
                kind = args.needs_input_kind or "architect"
                if kind not in VALID_NEEDS_INPUT_KINDS:
                    raise SystemExit(
                        f"--needs-input-kind must be one of: {', '.join(sorted(VALID_NEEDS_INPUT_KINDS))}."
                    )
                needs_input = {
                    "kind": kind,
                    "reason": args.needs_input_reason or "blocked_other",
                    "question": (args.needs_input_question or "").strip(),
                    "suggestedResolution": (args.needs_input_suggested_resolution or "").strip(),
                }
            result = apply_gate_verdict(
                state,
                args.state,
                task,
                gate,
                args.id,
                args.verdict,
                args.summary,
                required_actions=args.required_action or [],
                needs_input=needs_input,
                artifact_path=args.artifact_path,
                artifact_title=args.artifact_title,
                artifact_kind=args.artifact_kind,
            )
            append_reviewer_difficulty_assessment(
                task,
                pct=getattr(args, "reviewed_difficulty_pct", None),
                dimension=getattr(args, "reviewed_difficulty_dimension", "") or "",
                reason=getattr(args, "reviewed_difficulty_reason", "") or "",
                reviewer_agent_id=args.id,
                reviewer_role=args.role,
                gate_id=str(gate.get("id") or ""),
                gate_attempt_id=str(result["attempt"].get("id") or ""),
            )
            feedback_payload = build_feedback_payload(
                args,
                state,
                args.state,
                task,
                args.id,
                gate_context={
                    "phase": gate.get("phase"),
                    "gateId": gate.get("id"),
                    "attemptId": result["attempt"].get("id"),
                    "verdict": args.verdict,
                    "role": args.role,
                },
            )
            if feedback_payload:
                attach_feedback_payload(state, feedback_payload, args.id)
            recompute_phase(state)
            event = append_event(state, "task_gate_verdict", args.id, f"{args.id} submitted {args.verdict} for gate {args.gate_id} on {args.task_id}.")
            continuation = auto_mode_continuation(state, args.role, args.id)
            return {
                "ok": True,
                "task": task,
                "gate": gate,
                "attempt": result["attempt"],
                "comment": result["comment"],
                "artifact": result["artifact"],
                "nextStatus": result["nextStatus"],
                "event": event,
                **(continuation or {}),
                "_feedbackRecord": feedback_payload["record"] if feedback_payload else None,
            }

    result = with_locked_state(args.state, run)
    feedback_record = result.pop("_feedbackRecord", None)
    if feedback_record:
        result["feedbackRecorded"] = True
        result["feedbackMetricsPath"] = append_feedback_record(args.state, feedback_record)
    return result

def cmd_task_next(args: argparse.Namespace) -> Dict[str, Any]:
    args.role = require_configured_role(args.role, context="Task")

    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        with folder_store.FolderLock(args.state.parent / folder_store.CLAIM_QUEUE_LOCK_FILE):
            ensure_agent_in_roster(state, args.id, args.role)
            expired = release_expired_agent_targets(state, actor="sprintengine", excluding_agent_id=args.id)
            stale_owner_dirty = clear_non_active_task_owner_claims(state)
            runtime = reconcile_agent(state, args.id, args.role)
            agent = runtime["agent"]
            active = runtime["activeTask"]
            if active:
                if active.get("status") == "needs_input":
                    needs_input = active.get("needsInput") if isinstance(active.get("needsInput"), dict) else {}
                    question = str(needs_input.get("question") or "").strip()
                    return {
                        "ok": True,
                        "claimed": False,
                        "reason": "task_needs_input",
                        "message": "Current task is blocked on needs_input. Stop until input is resolved.",
                        "task": active,
                        "agent": agent,
                        "blocker": {
                            "reason": "needs_input",
                            "kind": str(needs_input.get("kind") or ""),
                            "question": question,
                        },
                        "releasedExpired": expired["released"],
                        "write": runtime["dirty"] or expired["dirty"] or stale_owner_dirty,
                    }
                return {"ok": True, "claimed": False, "reason": "agent_already_has_active_task", "task": active, "agent": agent, "prompt": build_rework_prompt(args.state, active), "releasedExpired": expired["released"], "write": runtime["dirty"] or expired["dirty"] or stale_owner_dirty}

            ready_ids = read_ready_task_ids(state)
            tasks_by_id = {
                str(t.get("id")): t
                for t in state.get("tasks", [])
                if isinstance(t, dict) and t.get("id")
            }
            candidates = []
            for task_id in ready_ids:
                t = tasks_by_id.get(task_id)
                if not t or t.get("role") != args.role or not task_is_ready(state, t):
                    continue
                candidates.append(t)
            selected = select_round_robin_target(
                state,
                role=args.role,
                target_kind="task",
                candidates=candidates,
                key_fn=lambda item: dispatch_target_key("task", item.get("id")),
            )
            if selected:
                result = assign_task(state, selected, args.id)
                recompute_phase(state)
                event = append_event(state, "task_claimed", args.id, f"{args.id} claimed {selected.get('id')}.")
                return {"ok": True, "claimed": True, "task": selected, "agent": result["agent"], "prompt": build_rework_prompt(args.state, selected), "event": event, "releasedExpired": expired["released"]}

            phase_dirty = recompute_phase(state)
            return {"ok": True, "claimed": False, "reason": "no_ready_task", "message": f"No ready {args.role} tasks. Stop.", "releasedExpired": expired["released"], "write": runtime["dirty"] or phase_dirty or expired["dirty"] or stale_owner_dirty}

    return with_locked_state(args.state, run)

def cmd_task_claim(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        with folder_store.FolderLock(args.state.parent / folder_store.CLAIM_QUEUE_LOCK_FILE):
            task = find_task(state, args.task_id)
            ensure_agent_in_roster(state, args.id, str(task.get("role") or ""))
            agent = ensure_agent(state, args.id, task.get("role"))
            clear_non_active_task_owner_claims(state)
            ready_ids = set(read_ready_task_ids(state))
            if args.task_id not in ready_ids or not task_is_ready(state, task):
                return {"ok": False, "error": "Task is not ready.", "task": {"id": task.get("id"), "status": task.get("status")}, "write": False}
            result = assign_task(state, task, args.id)
            recompute_phase(state)
            event = append_event(state, "task_claimed", args.id, f"{args.id} claimed {args.task_id}.")
            return {"ok": True, "task": task, "agent": result["agent"], "event": event}
    return with_locked_state(args.state, run)

def cmd_task_status(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        actor = args.id or task.get("ownerAgentId") or task.get("role") or "agent"
        previous_status = task.get("status")
        previous_owner_id = task.get("ownerAgentId")
        if feedback_args_present(args) and args.status != "done":
            raise SystemExit("Feedback flags on `sprintengine task status` are only supported with --status done.")
        if args.status != "needs_input" and (
            getattr(args, "needs_input_kind", None)
            or getattr(args, "needs_input_question", None)
            or getattr(args, "needs_input_suggested_resolution", None)
        ):
            raise SystemExit("Needs-input fields are only supported with --status needs_input.")
        wants_needs_input_routing = (
            getattr(args, "needs_input_kind", None)
            or getattr(args, "needs_input_reason", None)
            or getattr(args, "needs_input_artifact_id", None)
            or getattr(args, "needs_input_question", None)
            or getattr(args, "needs_input_suggested_resolution", None)
        )
        if args.status == "needs_input" and wants_needs_input_routing and not (args.needs_input_question or "").strip():
            raise SystemExit("--needs-input-question is required when writing routed needs_input metadata.")
        if args.status == "done" and task_status_done_requires_closed_gates(state, task):
            open_gates = open_required_quality_gates(task)
            if open_gates:
                gate_summary = ", ".join(
                    f"{gate.get('id')}:{gate.get('status') or 'pending'}"
                    for gate in open_gates
                )
                raise SystemExit(
                    "Cannot mark task done while required quality gates remain open. "
                    "Use `sprintengine task publish` and `sprintengine task gate verdict` to close required gates first. "
                    f"Open gates: {gate_summary}."
                )
        task["status"] = args.status
        if args.status == "needs_input" and wants_needs_input_routing:
            kind = args.needs_input_kind or "architect"
            if kind not in VALID_NEEDS_INPUT_KINDS:
                raise SystemExit(
                    f"--needs-input-kind must be one of: {', '.join(sorted(VALID_NEEDS_INPUT_KINDS))}."
                )
            reason = args.needs_input_reason or NEEDS_INPUT_KIND_DEFAULT_REASONS.get(kind, "blocked_other")
            needs_input = {
                "kind": kind,
                "reason": reason,
                "question": (args.needs_input_question or "").strip(),
                "suggestedResolution": (args.needs_input_suggested_resolution or "").strip(),
                "artifactId": (args.needs_input_artifact_id or "").strip(),
                "reportedBy": actor,
                "reportedAt": now_iso(),
            }
            task["needsInput"] = {key: value for key, value in needs_input.items() if value}
        elif args.status == "needs_input":
            task.pop("needsInput", None)
        elif "needsInput" in task:
            task.pop("needsInput", None)
        if args.status == "in_progress" and not task.get("startedAt"):
            task["startedAt"] = now_iso()
        if args.status == "todo":
            if previous_owner_id:
                set_agent_idle(ensure_agent(state, previous_owner_id, task.get("role")))
            task["ownerAgentId"] = None
            task["startedAt"] = None
            task["completedAt"] = None
        if args.status == "done":
            task["completedAt"] = now_iso()
            if previous_status in {"in_progress", "changes_requested", "needs_input"}:
                task["lastImplementedByAgentId"] = str(actor)
                task["lastPublishedAt"] = task["completedAt"]
            set_implementer_actual_difficulty(
                task,
                getattr(args, "actual_difficulty_pct", None),
                getattr(args, "actual_difficulty_reason", "") or "",
            )
        if getattr(args, "summary", None):
            ensure_evidence(task)["summary"] = args.summary
        commit_sha = None
        if args.status == "done":
            refresh_task_diff_evidence(state, args.state, task, str(actor))
            commit_sha = commit_task_changes_if_needed(state, args.state, task, str(actor))
        if task.get("ownerAgentId"):
            agent = ensure_agent(state, task["ownerAgentId"], task.get("role"))
            if args.status == "in_progress":
                agent["status"] = "running"
                agent["currentTaskId"] = args.task_id
            elif args.status == "needs_input":
                agent["status"] = "needs_input"
                agent["currentTaskId"] = args.task_id
        cleared = []
        if args.status not in ACTIVE_TASK_STATUSES:
            cleared = clear_task_refs(state, args.task_id)
            if previous_owner_id:
                set_agent_idle(ensure_agent(state, previous_owner_id, task.get("role")))
            task["ownerAgentId"] = None
        feedback_payload = build_feedback_payload(args, state, args.state, task, actor)
        if feedback_payload:
            attach_feedback_payload(state, feedback_payload, actor)
        append_task_activity(
            task,
            "status_change" if args.status != "needs_input" else "needs_input",
            str(actor),
            f"{actor} moved {args.task_id} to {args.status}.",
            {"status": args.status},
        )
        recompute_phase(state)
        event = append_event(state, "task_status_changed", actor, f"{actor} moved {args.task_id} to {args.status}.")
        continuation = auto_mode_continuation(state, str(task.get("role") or ""), str(actor)) if args.status == "done" else None
        return {
            "ok": True,
            "task": task,
            "event": event,
            "clearedAgents": cleared,
            "commitSha": commit_sha,
            **(continuation or {}),
            "_feedbackRecord": feedback_payload["record"] if feedback_payload else None,
        }
    result = with_locked_state(args.state, run)
    feedback_record = result.pop("_feedbackRecord", None)
    if feedback_record:
        result["feedbackRecorded"] = True
        result["feedbackMetricsPath"] = append_feedback_record(args.state, feedback_record)
    return result

def cmd_task_resolve_input(args: argparse.Namespace) -> Dict[str, Any]:
    resolution = args.resolution.strip()
    if not resolution:
        raise SystemExit("--resolution is required.")

    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        result = resolve_task_input(state, task, args.id, resolution, complete=bool(args.complete))
        recompute_phase(state)
        event = append_event(
            state,
            "task_input_resolved",
            args.id,
            f"{args.id} resolved input for {args.task_id}.",
            {
                "taskId": args.task_id,
                "targetAgentId": result.get("ownerAgentId"),
                "resolution": resolution,
                "completed": bool(args.complete),
            },
        )
        notification = append_agent_notification_event(
            state,
            args.id,
            result.get("ownerAgentId"),
            args.task_id,
            "task_completed_after_input_resolution" if args.complete else "task_resume_requested",
            (
                f"Input was resolved for {args.task_id} by {args.id}; the task is complete."
                if args.complete
                else f"Input was resolved for {args.task_id} by {args.id}; resume through the claim tool."
            ),
        )
        return {
            "ok": True,
            "task": task,
            "transition": result,
            "event": event,
            "notification": notification,
        }

    return with_locked_state(args.state, run)

def cmd_task_release(args: argparse.Namespace) -> Dict[str, Any]:
    reason = args.reason.strip()
    if not reason:
        raise SystemExit("--reason is required.")

    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        result = release_task_from_owner(state, task, args.id, reason)
        recompute_phase(state)
        event = append_event(
            state,
            "task_released",
            args.id,
            f"{args.id} released {args.task_id} from {result.get('previousOwnerAgentId') or 'unowned'}.",
            {
                "taskId": args.task_id,
                "previousOwnerAgentId": result.get("previousOwnerAgentId"),
                "reason": reason,
            },
        )
        notification = append_agent_notification_event(
            state,
            args.id,
            result.get("previousOwnerAgentId"),
            args.task_id,
            "task_released_from_owner",
            f"{args.task_id} was released by {args.id} and returned to the ready queue.",
        )
        return {
            "ok": True,
            "task": task,
            "transition": result,
            "event": event,
            "notification": notification,
        }

    return with_locked_state(args.state, run)


def architect_actionable_needs_input_tasks(state: Dict[str, Any]) -> List[Dict[str, Any]]:
    tasks = []
    for task in state.get("tasks", []):
        if task.get("status") != "needs_input":
            continue
        needs_input = task.get("needsInput")
        if not isinstance(needs_input, dict):
            continue
        if needs_input.get("kind") in ARCHITECT_ROUTED_NEEDS_INPUT_KINDS:
            tasks.append(task)
    return tasks


def normalized_needs_input_for_routing(needs_input: Any) -> Dict[str, Any]:
    if not isinstance(needs_input, dict):
        return {}
    normalized = dict(needs_input)
    kind = str(normalized.get("kind") or "").strip()
    if kind and not normalized.get("reason"):
        normalized["reason"] = NEEDS_INPUT_KIND_DEFAULT_REASONS.get(kind, "blocked_other")
    return normalized


def artifacts_for_task(state: Dict[str, Any], task_id: Any) -> List[Dict[str, Any]]:
    return [
        artifact for artifact in state.get("artifacts", [])
        if isinstance(artifact, dict) and artifact.get("taskId") == task_id
    ]

def cmd_task_ready(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        dispatch = task.get("dispatch")
        actor = args.id or "user"
        if not isinstance(dispatch, dict) or dispatch.get("mode") != "manual":
            return {
                "ok": False,
                "error": "Task does not use manual dispatch.",
                "task": {"id": task.get("id"), "dispatch": dispatch},
                "write": False,
            }
        if task.get("status") != "todo" or task.get("ownerAgentId"):
            return {
                "ok": False,
                "error": "Only unclaimed todo tasks can be moved to Ready.",
                "task": {"id": task.get("id"), "status": task.get("status"), "ownerAgentId": task.get("ownerAgentId")},
                "write": False,
            }

        if dispatch.get("status") != "ready":
            dispatch["status"] = "ready"
            dispatch["triagedBy"] = args.triaged_by
            dispatch["readyAt"] = now_iso()
        else:
            dispatch.setdefault("triagedBy", args.triaged_by)
            dispatch.setdefault("readyAt", now_iso())

        recompute_phase(state)
        event = append_event(state, "task_dispatch_ready", actor, f"{actor} moved {args.task_id} to Ready.")
        return {"ok": True, "task": task, "event": event}

    return with_locked_state(args.state, run)

def cmd_task_refresh_ready(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        refresh = refresh_materialized_ready_queue(args.state, state)
        return {
            "ok": True,
            "readyTaskIds": refresh["readyTaskIds"],
            "orderedTaskIds": refresh["orderedTaskIds"],
        }

    return with_locked_state(args.state, run)

def cmd_task_log(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        ev = ensure_evidence(task)
        if getattr(args, "summary", None):
            ev["summary"] = args.summary
        reject_absolute_path_values(args.file or [], "--file")
        add_unique_values(ev, "touchedFiles", args.file or [])
        add_unique_scope_expansions(ev, parse_scope_expansion_args(args, args.task_id))
        ev["commandsRan"].extend(args.command or [])
        ev["results"].extend(args.result or [])
        append_task_activity(task, "evidence", args.id, f"{args.id} logged evidence for {args.task_id}.")
        event = append_event(state, "task_evidence_appended", args.id, f"{args.id} logged evidence for {args.task_id}.")
        return {"ok": True, "task": task, "event": event}
    return with_locked_state(args.state, run)

def cmd_task_publish(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        actor = args.id or task.get("ownerAgentId") or task.get("role") or "agent"
        summary_data = parse_json_object_arg(getattr(args, "summary_data_json", None), "--summary-data-json")
        refresh_task_diff_evidence(state, args.state, task, str(actor), args.path or [])
        commit_sha = commit_task_changes_if_needed(state, args.state, task, str(actor))
        set_implementer_actual_difficulty(
            task,
            getattr(args, "actual_difficulty_pct", None),
            getattr(args, "actual_difficulty_reason", "") or "",
        )
        result = publish_task(state, task, str(actor), args.summary, paths=args.path or [], data=summary_data)
        recompute_phase(state)
        event = append_event(state, "task_published", str(actor), f"{actor} published {args.task_id} to {result['nextStatus']}.")
        continuation = auto_mode_continuation(state, str(task.get("role") or ""), str(actor))
        return {
            "ok": True,
            "task": task,
            "comment": result["comment"],
            "nextStatus": result["nextStatus"],
            "previousStatus": result["previousStatus"],
            "clearedAgents": result["clearedAgents"],
            "committed": bool(commit_sha),
            "commitSha": commit_sha,
            "event": event,
            **(continuation or {}),
        }

    return with_locked_state(args.state, run)

def cmd_task_note(args: argparse.Namespace) -> Dict[str, Any]:
    # Runtime notes flow through task.comments so the body, author, and timestamp
    # appear in the activity feed. task.notes stays reserved for plan-time design
    # intent set via `plan add-task --task-note`.
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        actor = args.id or "user"
        role = str(state.get("agents", {}).get(actor, {}).get("role") or "").strip().lower()
        comment_type = "architect_feedback" if role == "architect" else "user_note"
        comment = create_task_comment(
            state,
            task,
            actor=actor,
            body=args.note,
            comment_type=comment_type,
        )
        event = append_event(state, "task_note_added", actor, f"{actor} added note to {args.task_id}.")
        return {"ok": True, "task": task, "comment": comment, "event": event}
    return with_locked_state(args.state, run)

def cmd_task_comment(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        actor = args.id or "user"
        comment_type = args.comment_type or ("user_note" if args.source == "user" else "system_note" if args.source == "system" else "implementation_summary")
        comment = create_task_comment(
            state,
            task,
            actor=actor,
            body=args.body,
            comment_type=comment_type,
            source=args.source,
            paths=args.path or [],
            data=parse_json_object_arg(getattr(args, "data_json", None), "--data-json"),
        )
        event = append_event(state, "task_comment_added", actor, f"{actor} commented on {args.task_id}.")
        return {"ok": True, "task": task, "comment": comment, "event": event}
    return with_locked_state(args.state, run)

def cmd_task_comment_list(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        comments = [comment for comment in task.get("comments", []) or [] if isinstance(comment, dict)]
        return {"ok": True, "taskId": task.get("id"), "comments": comments, "write": False}

    return with_locked_state(args.state, run)

list_tasks = cmd_task_list
gate_list = cmd_task_gate_list
gate_next = cmd_task_gate_next
gate_claim = cmd_task_gate_claim
gate_verdict = cmd_task_gate_verdict
next_task = cmd_task_next
claim = cmd_task_claim
status = cmd_task_status
resolve_input = cmd_task_resolve_input
release = cmd_task_release
ready = cmd_task_ready
refresh_ready = cmd_task_refresh_ready
log = cmd_task_log
publish = cmd_task_publish
note = cmd_task_note

def comment(args: argparse.Namespace) -> Dict[str, Any]:
    if args.comment_action == "list":
        return cmd_task_comment_list(args)
    return cmd_task_comment(args)

comment_list = cmd_task_comment_list
