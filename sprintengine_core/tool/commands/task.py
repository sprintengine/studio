"""Sprint Engine task command handlers."""
from __future__ import annotations

import argparse
import json
from typing import Any, Dict, List, Optional, Tuple

from sprintengine_core import store as folder_store
from sprintengine_core.tool.artifacts import (
    release_task_from_owner,
    resolve_task_input,
    supersede_stale_gate_placeholder_on_completion,
)
from sprintengine_core.tool.common import parse_json_object_arg
from sprintengine_core.tool.constants import (
    ACTIVE_TASK_STATUSES,
    PLANNER_ROUTED_NEEDS_INPUT_KINDS,
    NEEDS_INPUT_KIND_DEFAULT_REASONS,
    VALID_NEEDS_INPUT_KINDS,
    VALID_TASK_PHASES,
)
from sprintengine_core.tool.feedback import (
    append_feedback_record,
    attach_feedback_payload,
    build_feedback_payload,
    feedback_args_present,
    parse_scope_expansion_args,
    set_implementer_actual_difficulty,
)
from sprintengine_core.tool.paths import now_iso
from sprintengine_core.tool.phase_prompts import (
    build_phase_directive,
    build_phase_respawn_brief,
    build_rework_prompt,
)
from sprintengine_core.tool.plans import resolve_planning_role
from sprintengine_core.tool.roles import require_configured_role
from sprintengine_core.tool.shell import commit_task_changes_if_needed
from sprintengine_core.tool.state import (
    append_agent_notification_event,
    append_event,
    append_task_activity,
    assign_task,
    create_task_comment,
    end_lease,
    ensure_role_in_roster,
    ensure_task_repo_declared,
    find_task,
    mint_lease,
    reconcile_worker,
    release_expired_agent_targets,
    worker_has_active_lease,
    worker_role,
    worker_view,
    with_locked_state,
)
from sprintengine_core.tool.tasks import (
    add_unique_scope_expansions,
    add_unique_values,
    advance_task,
    claim_phase_session,
    ensure_evidence,
    normalize_needs_input_kind,
    publish_task,
    read_ready_task_ids,
    recompute_phase,
    refresh_materialized_ready_queue,
    refresh_task_diff_evidence,
    reject_absolute_path_values,
    task_awaiting_phase_session,
    task_is_ready,
)
from sprintengine_core.tool.task_reviews import (
    approve_cross_task_rework,
    assert_task_can_complete,
    pending_phase_reapproval_for_reviewer,
    reassign_review_request,
    request_task_changes,
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

def _resolve_execution_identity(args: argparse.Namespace) -> Tuple[Optional[str], Optional[str]]:
    """Explicit CLI model/CLI override to stamp onto a claimed task.

    Only the `--model`/`--cli` flags are read here — an explicit override for
    headless / non-Multicode CLI callers. When absent (the normal Multicode
    path, where claims arrive over the shared HTTP MCP hub with no per-agent
    context), assign_task falls back to the run's per-role runtime map. We do
    NOT read process env: the hub is a single app-process server, so an env var
    there would not be the claiming agent's and could mis-stamp every task.
    """

    def _clean(value: Optional[str]) -> Optional[str]:
        if not isinstance(value, str):
            return None
        stripped = value.strip()
        return stripped or None

    return _clean(getattr(args, "model", None)), _clean(getattr(args, "cli", None))


def cmd_task_next(args: argparse.Namespace) -> Dict[str, Any]:
    args.role = require_configured_role(args.role, context="Task")

    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        with folder_store.FolderLock(args.state.parent / folder_store.CLAIM_QUEUE_LOCK_FILE):
            ensure_role_in_roster(state, args.role)
            expired = release_expired_agent_targets(state, actor="sprintengine", excluding_agent_id=args.id)
            runtime = reconcile_worker(state, args.id, args.role)
            active = runtime["activeTask"]
            agent = worker_view(state, args.id)
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
                        "write": runtime["dirty"] or expired["dirty"],
                    }
                # Flow 6 — an owner revived mid-phase (its terminal died, or the
                # supervisor respawned it) reconnects here. It has no diff in
                # context, so it gets the phase respawn brief (task card + published
                # diff + the phase directive), not the implementation rework prompt.
                # This is the SECOND and last directive delivery channel; the first
                # is inline in the owner's own publish/advance response.
                active_status = str(active.get("status") or "")
                resume_prompt = (
                    build_phase_respawn_brief(state, args.state, active, active_status)
                    if active_status in VALID_TASK_PHASES
                    else build_rework_prompt(args.state, active)
                )
                return {
                    "ok": True,
                    "claimed": False,
                    "reason": "agent_already_has_active_task",
                    "task": active,
                    "agent": agent,
                    "prompt": resume_prompt,
                    **({"phase": active_status} if active_status in VALID_TASK_PHASES else {}),
                    "releasedExpired": expired["released"],
                    "write": runtime["dirty"] or expired["dirty"],
                }

            reserved_target = pending_phase_reapproval_for_reviewer(state, args.id)
            if reserved_target:
                phase_dirty = recompute_phase(state)
                return {
                    "ok": True,
                    "claimed": False,
                    "reason": "review_reapproval_pending",
                    "message": (
                        f"{args.id} is reserved to re-approve {reserved_target.get('id')}; "
                        "do not claim unrelated work while its review request is open."
                    ),
                    "task": {"id": reserved_target.get("id"), "status": reserved_target.get("status")},
                    "agent": agent,
                    "releasedExpired": expired["released"],
                    "write": runtime["dirty"] or phase_dirty or expired["dirty"],
                }

            # MC-1543 phase sessions are claimed by task id via `task.claim` (pinned
            # to the exact bound-runtime session the supervisor spawned), NOT
            # auto-grabbed here: matching on role alone let a concurrent CHEAP
            # same-role session win the review and silently downgrade the paid-for
            # runtime. `task.next` therefore only serves ready work now.
            # The repo this session works in (MC-1610), bound by the MCP server
            # from the worktree the session was spawned into. A session can only
            # claim work in its own tree: its cwd, its commit lock, and its
            # task's repo-relative paths must all name one repo, and no session
            # can move itself to another. Absent (single-repo runs, the CLI)
            # means unbound — every ready task for the role is a candidate,
            # exactly as before repos existed.
            session_repo = str(getattr(args, "repo", None) or "").strip()
            if session_repo:
                session_repo = ensure_task_repo_declared(state, session_repo, context=f"Worker {args.id}")
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
                if session_repo and folder_store.task_repo(t) != session_repo:
                    continue
                candidates.append(t)
            # Ready ids are already priority-ordered by the materialized ready
            # queue; a worker takes the first ready task for its role. The old
            # round-robin cursor (dispatchCursors) was deleted with the dispatch
            # mechanism (MC-1591): leases, not a cursor, prevent double-claims.
            selected = candidates[0] if candidates else None
            if selected and worker_has_active_lease(state, args.id, excluding_task_id=selected.get("id")):
                # Lease uniqueness: a worker already holding an active lease cannot
                # claim a second task. Leave it ready for a fresh id and stop this
                # one; a worker whose task is done holds no active lease and may claim.
                phase_dirty = recompute_phase(state)
                return {
                    "ok": True,
                    "claimed": False,
                    "reason": "worker_task_capacity_reached",
                    "message": f"{args.id} already holds an active lease; another worker must claim {selected.get('id')}.",
                    "task": {"id": selected.get("id"), "status": selected.get("status")},
                    "agent": agent,
                    "releasedExpired": expired["released"],
                    "write": runtime["dirty"] or phase_dirty or expired["dirty"],
                }
            if selected:
                ensure_task_repo_declared(
                    state, folder_store.task_repo(selected), context=f"Task {selected.get('id')}"
                )
                model, cli = _resolve_execution_identity(args)
                result = assign_task(state, selected, args.id, model=model, cli=cli)
                recompute_phase(state)
                event = append_event(state, "task_claimed", args.id, f"{args.id} claimed {selected.get('id')}.")
                return {"ok": True, "claimed": True, "task": selected, "agent": result["agent"], "prompt": build_rework_prompt(args.state, selected), "event": event, "releasedExpired": expired["released"]}

            phase_dirty = recompute_phase(state)
            scope = f" in {session_repo}" if session_repo else ""
            return {"ok": True, "claimed": False, "reason": "no_ready_task", "message": f"No ready {args.role} tasks{scope}. Stop.", "releasedExpired": expired["released"], "write": runtime["dirty"] or phase_dirty or expired["dirty"]}

    return with_locked_state(args.state, run)

def cmd_task_claim(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        with folder_store.FolderLock(args.state.parent / folder_store.CLAIM_QUEUE_LOCK_FILE):
            task = find_task(state, args.task_id)
            # MC-1543: an awaiting phase session is claimed here, pinned to THIS task
            # id, by the fresh session the supervisor spawned on the phase's bound
            # runtime. claim_phase_session re-stamps the bound runtime and returns the
            # diff-seeded brief WITHOUT rewinding the phase status. A fresh id needs no
            # membership check — the lease it mints is the authority.
            if task_awaiting_phase_session(task):
                if worker_has_active_lease(state, args.id, excluding_task_id=task.get("id")):
                    return {
                        "ok": False,
                        "error": "Worker already holds an active lease; another worker must run this phase.",
                        "reason": "worker_task_capacity_reached",
                        "task": {"id": task.get("id"), "status": task.get("status")},
                        "write": False,
                    }
                claimed_phase = claim_phase_session(state, task, args.id)
                recompute_phase(state)
                event = append_event(
                    state, "task_phase_session_claimed", args.id,
                    f"{args.id} claimed the {claimed_phase['phase']} phase of {task.get('id')}.",
                )
                return {
                    "ok": True,
                    "task": task,
                    "agent": claimed_phase["agent"],
                    "phase": claimed_phase["phase"],
                    "prompt": build_phase_respawn_brief(state, args.state, task, claimed_phase["phase"]),
                    "event": event,
                }
            reserved_target = pending_phase_reapproval_for_reviewer(state, args.id)
            if reserved_target and reserved_target.get("id") != task.get("id"):
                return {
                    "ok": False,
                    "error": f"Worker is reserved to re-approve {reserved_target.get('id')}.",
                    "reason": "review_reapproval_pending",
                    "task": {"id": task.get("id"), "status": task.get("status")},
                    "write": False,
                }
            ensure_role_in_roster(state, str(task.get("role") or ""))
            ensure_task_repo_declared(
                state, folder_store.task_repo(task), context=f"Task {task.get('id')}"
            )
            ready_ids = set(read_ready_task_ids(state))
            if args.task_id not in ready_ids or not task_is_ready(state, task):
                return {"ok": False, "error": "Task is not ready.", "task": {"id": task.get("id"), "status": task.get("status")}, "write": False}
            if worker_has_active_lease(state, args.id, excluding_task_id=task.get("id")):
                return {
                    "ok": False,
                    "error": "Worker already holds an active lease; another worker must claim this task.",
                    "reason": "worker_task_capacity_reached",
                    "task": {"id": task.get("id"), "status": task.get("status")},
                    "write": False,
                }
            model, cli = _resolve_execution_identity(args)
            result = assign_task(state, task, args.id, model=model, cli=cli)
            recompute_phase(state)
            event = append_event(state, "task_claimed", args.id, f"{args.id} claimed {args.task_id}.")
            return {"ok": True, "task": task, "agent": result["agent"], "event": event}
    return with_locked_state(args.state, run)

def cmd_task_status(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        actor = args.id or task.get("ownerAgentId") or task.get("role") or "agent"
        previous_status = task.get("status")
        if args.status in VALID_TASK_PHASES:
            # A phase status is entered only by `task.publish` (which composes the
            # phase directive and runs change detection) and stepped by `task.advance`
            # — never hand-set here, which would skip the whole diff-driven walk.
            raise SystemExit(
                f"{args.status!r} is a review phase entered via publish/advance, "
                "not a status you set directly."
            )
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
        task["status"] = args.status
        if args.status == "needs_input" and wants_needs_input_routing:
            kind = normalize_needs_input_kind(args.needs_input_kind or "architect")
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
        if args.status == "in_progress":
            # Reopening a published or completed task (Flow 5, the human Inbox loop).
            # The old `changes_requested` column was claimable; `in_progress` is not
            # (`task_is_ready` queues only `todo`), so an unowned reopen would strand
            # the task. Re-bind it to the agent that implemented it — the supervisor
            # re-engages that owner (live paste, or `--resume` respawn). If the owner
            # is truly gone, the expiry sweep releases the task to `todo` and a fresh
            # id claims it. With no implementer on record (a never-claimed task),
            # return it to the queue rather than leave it unclaimable.
            task["completedAt"] = None
            if not task.get("startedAt"):
                task["startedAt"] = now_iso()
            if not task.get("ownerAgentId"):
                previous_implementer = str(task.get("lastImplementedByAgentId") or "").strip()
                if previous_implementer:
                    task["ownerAgentId"] = previous_implementer
                    append_task_activity(
                        task,
                        "status_change",
                        str(actor),
                        f"{actor} reopened {args.task_id} for rework; {previous_implementer} owns it again.",
                        {"status": "in_progress", "ownerAgentId": previous_implementer, "reason": "human_feedback"},
                    )
                else:
                    task["status"] = "todo"
                    task["startedAt"] = None
        if args.status == "todo":
            task["ownerAgentId"] = None
            task["startedAt"] = None
            task["completedAt"] = None
        if args.status == "done":
            from sprintengine_core.tool.integration_proof import is_proof_task
            if is_proof_task(task):
                raise SystemExit("integration_proof_uses_proof_record: ordinary status cannot complete a proof task.")
            assert_task_can_complete(state, task)
            task["completedAt"] = now_iso()
            if previous_status in {"in_progress", "review", "needs_input"}:
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
            supersede_stale_gate_placeholder_on_completion(state, task, str(actor))
            refresh_task_diff_evidence(state, args.state, task, str(actor))
            commit_sha = commit_task_changes_if_needed(state, args.state, task, str(actor))
        if task.get("ownerAgentId") and args.status in ACTIVE_TASK_STATUSES:
            # The owner holds the task's lease while it is active (a Flow-5 reopen
            # re-binds it to its implementer).
            mint_lease(task, task["ownerAgentId"], task.get("role"))
        if args.status not in ACTIVE_TASK_STATUSES:
            end_lease(task)
            task["ownerAgentId"] = None
        feedback_payload = build_feedback_payload(args, state, args.state, task, actor)
        if feedback_payload:
            attach_feedback_payload(state, feedback_payload, actor)
        # The requested status is not always the status that landed: reopening a
        # never-claimed task returns it to `todo` because an unowned `in_progress`
        # task is unclaimable. Report, log, and event the status the store actually
        # holds — a response that says `in_progress` over a `todo` row is a lie the
        # board and the caller both act on.
        final_status = str(task.get("status") or args.status)
        append_task_activity(
            task,
            "status_change" if final_status != "needs_input" else "needs_input",
            str(actor),
            f"{actor} moved {args.task_id} to {final_status}.",
            {"status": final_status, **({"requestedStatus": args.status} if final_status != args.status else {})},
        )
        recompute_phase(state)
        event = append_event(state, "task_status_changed", actor, f"{actor} moved {args.task_id} to {final_status}.")
        continuation = auto_mode_continuation(state, str(task.get("role") or ""), str(actor)) if final_status == "done" else None
        return {
            "ok": True,
            "task": task,
            "status": final_status,
            **({"requestedStatus": args.status} if final_status != args.status else {}),
            "event": event,
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
        # A mid-phase escalation resumes IN that phase, so the owner needs the phase
        # directive plus the ruling — not the implementation prompt it already ran.
        resume_phase = result.get("resumePhase")
        next_directive = build_phase_directive(state, args.state, task, resume_phase) if resume_phase else None
        return {
            "ok": True,
            "task": task,
            "transition": result,
            **({"nextDirective": next_directive} if next_directive else {}),
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


def planner_actionable_needs_input_tasks(state: Dict[str, Any]) -> List[Dict[str, Any]]:
    """needs_input tasks the run's PLANNER must triage — architect or general."""
    tasks = []
    for task in state.get("tasks", []):
        if task.get("status") != "needs_input":
            continue
        needs_input = task.get("needsInput")
        if not isinstance(needs_input, dict):
            continue
        if needs_input.get("kind") in PLANNER_ROUTED_NEEDS_INPUT_KINDS:
            tasks.append(task)
    return tasks


# Legacy alias: the old name asserted the triager is an architect, which is what
# left general-only runs unable to triage anything.
architect_actionable_needs_input_tasks = planner_actionable_needs_input_tasks


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

        # Repeatable feedback channel (best-effort, like the advance path): a
        # sweep audits N tasks and records one assessment per audited task via
        # the --review-target-* trio; without the trio the fields land as the
        # agent's own self-report. No feedback args -> zero-cost no-op.
        feedback_warnings: List[str] = []
        feedback_payload = build_feedback_payload(
            args, state, args.state, task, str(args.id), best_effort=True
        )
        if feedback_payload:
            feedback_warnings.extend(feedback_payload.get("warnings") or [])
            attach_feedback_payload(state, feedback_payload, str(args.id))

        return {
            "ok": True,
            "task": task,
            "event": event,
            **({"feedbackWarnings": feedback_warnings} if feedback_warnings else {}),
            "_feedbackRecord": feedback_payload["record"] if feedback_payload else None,
        }

    result = with_locked_state(args.state, run)
    feedback_record = result.pop("_feedbackRecord", None)
    if feedback_record:
        result["feedbackRecorded"] = True
        result["feedbackMetricsPath"] = append_feedback_record(args.state, feedback_record)
    return result

def cmd_task_publish(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        actor = args.id or task.get("ownerAgentId") or task.get("role") or "agent"
        from sprintengine_core.tool.integration_proof import is_proof_task, normalize_integration_proof
        if is_proof_task(task):
            raise SystemExit("integration_proof_uses_proof_record: proof tasks complete only through proof.record or local human approval.")
        if "integrationProof" in state and task.get("producesImplementation") and not normalize_integration_proof(state.get("integrationProof")).get("required"):
            task["status"] = "needs_input"
            task["completedAt"] = None
            task["needsInput"] = {
                "kind": "architect",
                "reason": "task_scope",
                "question": "This task is publishing product code, but the plan exempted the run from integration proof.",
                "suggestedResolution": "Add one integration_proof task, set a proof mode, and update the seam manifest before publishing.",
                "reportedBy": str(actor),
                "reportedAt": now_iso(),
            }
            recompute_phase(state)
            event = append_event(state, "integration_proof_exemption_revoked", str(actor), f"{args.task_id} attempted to publish product code under a proof exemption.")
            return {
                "ok": False,
                "error": "integration_proof_required_for_code: planner action is required before product code can publish.",
                "task": task,
                "event": event,
            }
        summary_data = parse_json_object_arg(getattr(args, "summary_data_json", None), "--summary-data-json")
        refresh_task_diff_evidence(state, args.state, task, str(actor), args.path or [])
        # Guard BEFORE the backstop commit: an orphan is owned by no task, so this
        # task's commit never stages it and the orphan set is identical either way.
        # Checking first means a blocked publish commits nothing and aborts cleanly
        # (a raised SystemExit discards the state write in with_locked_state, so a
        # commit made here would otherwise persist in git but go unrecorded in the
        # run store).
        from sprintengine_core.tool.shell import get_run_vcs, task_scoped_orphaned_dirty_paths
        if get_run_vcs(state):
            orphaned = task_scoped_orphaned_dirty_paths(state, args.state, task)
            if orphaned:
                raise SystemExit(
                    "Cannot publish: "
                    f"{len(orphaned)} changed path(s) in this task's working directories are uncommitted and owned by no task: "
                    f"{', '.join(orphaned)}. A clean checkout of the published commit would be missing these files. "
                    "If they belong to this task, add them to its ownedPaths (`sprintengine plan update-task`) or commit "
                    "them with `sprintengine vcs commit --task-id "
                    f"{args.task_id} --id {actor} --path <file>`, then publish again."
                )
        commit_sha = commit_task_changes_if_needed(state, args.state, task, str(actor))
        set_implementer_actual_difficulty(
            task,
            getattr(args, "actual_difficulty_pct", None),
            getattr(args, "actual_difficulty_reason", "") or "",
        )
        result = publish_task(state, args.state, task, str(actor), args.summary, paths=args.path or [], data=summary_data)
        recompute_phase(state)
        event = append_event(state, "task_published", str(actor), f"{actor} published {args.task_id} to {result['nextStatus']}.")
        continuation = auto_mode_continuation(state, str(task.get("role") or ""), str(actor))
        # The owner is in-session and mid-tool-call: hand it the phase directive here
        # rather than pasting into its terminal. There is no third delivery channel
        # (see phase_prompts) — the only other one is the respawn brief for a dead owner.
        # MC-1543: when the phase is bound to a different runtime the directive is NOT
        # returned inline; it rides the diff-seeded brief of the session the supervisor
        # spawns on that runtime.
        awaiting = result.get("awaitingPhaseSession")
        next_directive = (
            build_phase_directive(state, args.state, task, result["nextStatus"])
            if result["nextStatus"] != "done" and not awaiting
            else None
        )
        return {
            "ok": True,
            "task": task,
            "comment": result["comment"],
            "nextStatus": result["nextStatus"],
            "previousStatus": result["previousStatus"],
            "producedChanges": result["producedChanges"],
            "phases": result["phases"],
            **({"awaitingPhaseSession": awaiting} if awaiting else {}),
            **({"nextDirective": next_directive} if next_directive else {}),
            "committed": bool(commit_sha),
            "commitSha": commit_sha,
            "event": event,
            **(continuation or {}),
        }

    return with_locked_state(args.state, run)


def cmd_task_advance(args: argparse.Namespace) -> Dict[str, Any]:
    """Close the task's current phase and step forward. Owner-only."""

    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        actor = str(args.id or task.get("ownerAgentId") or "agent")
        needs_input = None
        if args.outcome == "escalate":
            kind = normalize_needs_input_kind(getattr(args, "needs_input_kind", None) or "architect")
            if kind not in VALID_NEEDS_INPUT_KINDS:
                raise SystemExit(f"--needs-input-kind must be one of: {', '.join(sorted(VALID_NEEDS_INPUT_KINDS))}.")
            needs_input = {
                "kind": kind,
                "reason": getattr(args, "needs_input_reason", None) or NEEDS_INPUT_KIND_DEFAULT_REASONS.get(kind, "blocked_other"),
                "question": (getattr(args, "needs_input_question", None) or "").strip(),
                "suggestedResolution": (getattr(args, "needs_input_suggested_resolution", None) or "").strip(),
            }
        result = advance_task(state, task, actor, args.phase, args.outcome, args.summary, needs_input=needs_input)

        feedback_warnings: List[str] = []
        # Findings are best-effort telemetry: a bad enum must never block the
        # operational transition (the same rule gate verdicts carried).
        feedback_payload = build_feedback_payload(
            args,
            state,
            args.state,
            task,
            actor,
            phase_context={"phase": result["phase"], "outcome": args.outcome},
            best_effort=True,
        )
        if feedback_payload:
            feedback_warnings.extend(feedback_payload.get("warnings") or [])
            attach_feedback_payload(state, feedback_payload, actor)

        recompute_phase(state)
        event = append_event(
            state,
            "task_phase_advanced",
            actor,
            f"{actor} advanced {args.task_id} out of {result['phase']} with {args.outcome}.",
            {"taskId": args.task_id, "phase": result["phase"], "outcome": args.outcome, "status": result["nextStatus"]},
        )
        continuation = auto_mode_continuation(state, str(task.get("role") or ""), actor)
        awaiting = result.get("awaitingPhaseSession")
        next_directive = (
            build_phase_directive(state, args.state, task, result["nextPhase"])
            if result["nextPhase"] and not awaiting
            else None
        )
        return {
            "ok": True,
            "task": task,
            "comment": result["comment"],
            "phase": result["phase"],
            "outcome": args.outcome,
            "nextStatus": result["nextStatus"],
            **({"nextPhase": result["nextPhase"]} if result["nextPhase"] else {}),
            **({"awaitingPhaseSession": awaiting} if awaiting else {}),
            **({"nextDirective": next_directive} if next_directive else {}),
            "event": event,
            **(continuation or {}),
            **({"feedbackWarnings": feedback_warnings} if feedback_warnings else {}),
            "_feedbackRecord": feedback_payload["record"] if feedback_payload else None,
        }

    result = with_locked_state(args.state, run)
    feedback_record = result.pop("_feedbackRecord", None)
    if feedback_record:
        result["feedbackRecorded"] = True
        result["feedbackMetricsPath"] = append_feedback_record(args.state, feedback_record)
    return result


def _structured_findings(values: Any) -> List[Any]:
    findings: List[Any] = []
    for value in values or []:
        if isinstance(value, dict):
            findings.append(value)
            continue
        try:
            parsed = json.loads(str(value))
        except json.JSONDecodeError as exc:
            raise SystemExit(f"--finding-json must be valid JSON: {exc}") from exc
        if not isinstance(parsed, dict):
            raise SystemExit("--finding-json must be a JSON object.")
        findings.append(parsed)
    return findings


def cmd_task_request_changes(args: argparse.Namespace) -> Dict[str, Any]:
    """Open or continue one reviewer-owned, closed rework thread."""

    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        actor = str(args.id or "").strip()
        result = request_task_changes(
            state,
            args.state,
            task,
            actor,
            args.feedback,
            source_task_id=getattr(args, "source_task_id", None),
            paths=list(getattr(args, "path", None) or []),
            findings=_structured_findings(getattr(args, "finding_json", None)),
        )
        recompute_phase(state)
        event = append_event(
            state,
            "task_rework_requested" if result["status"] != "escalated" else "task_rework_escalated",
            actor,
            f"{actor} requested changes on {args.task_id} ({result['request']['id']}, cycle {result['request']['cycle']}).",
            {
                "taskId": args.task_id,
                "sourceTaskId": result["request"]["sourceTaskId"],
                "reviewRequestId": result["request"]["id"],
                "cycle": result["request"]["cycle"],
                "status": result["status"],
            },
        )
        return {
            "ok": True,
            "task": task,
            "comment": result["comment"],
            "reviewRequest": result["request"],
            "status": result["status"],
            "event": event,
        }

    return with_locked_state(args.state, run)


def cmd_task_approve_rework(args: argparse.Namespace) -> Dict[str, Any]:
    """The original cross-task requester approves a fresh rework publish."""

    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        actor = str(args.id or "").strip()
        result = approve_cross_task_rework(state, task, actor, args.source_task_id, args.summary)
        supersede_stale_gate_placeholder_on_completion(state, task, actor)
        recompute_phase(state)
        event = append_event(
            state,
            "task_rework_approved",
            actor,
            f"{actor} approved {args.task_id} rework ({result['request']['id']}).",
            {
                "taskId": args.task_id,
                "sourceTaskId": args.source_task_id,
                "reviewRequestId": result["request"]["id"],
                "cycle": result["request"]["cycle"],
            },
        )
        return {
            "ok": True,
            "task": task,
            "comment": result["comment"],
            "status": "done",
            "reviewRequestId": result["request"]["id"],
            "event": event,
        }

    return with_locked_state(args.state, run)


def cmd_task_reassign_review(args: argparse.Namespace) -> Dict[str, Any]:
    """Planner explicitly replaces an unrecoverable review requester."""

    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        request = reassign_review_request(
            state,
            task,
            args.id,
            args.reviewer_id,
            args.reviewer_role,
            args.reason,
            reviewer_cli=getattr(args, "reviewer_cli", None),
            reviewer_model=getattr(args, "reviewer_model", None),
        )
        recompute_phase(state)
        event = append_event(
            state,
            "task_review_reassigned",
            args.id,
            f"{args.id} reassigned {args.task_id} review request {request['id']} to {args.reviewer_id}.",
            {
                "taskId": args.task_id,
                "reviewRequestId": request["id"],
                "reviewerAgentId": args.reviewer_id,
                "reviewerRole": args.reviewer_role,
                "reason": args.reason,
            },
        )
        return {"ok": True, "task": task, "reviewRequest": request, "event": event}

    return with_locked_state(args.state, run)

def cmd_task_note(args: argparse.Namespace) -> Dict[str, Any]:
    # Runtime notes flow through task.comments so the body, author, and timestamp
    # appear in the activity feed. task.notes stays reserved for plan-time design
    # intent set via `plan add-task --task-note`.
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        actor = args.id or "user"
        # The author's role is derived from the run's own records (lease / owned
        # tasks / minted-id convention) — never the agents map. Planner feedback is
        # typed by the run's planning role, not the literal "architect": a general
        # planning its own run was writing `user_note`, so its direction to a worker
        # read as human-typed.
        role = worker_role(state, actor).strip().lower()
        comment_type = "architect_feedback" if role and role == resolve_planning_role(state) else "user_note"
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
next_task = cmd_task_next
claim = cmd_task_claim
status = cmd_task_status
resolve_input = cmd_task_resolve_input
release = cmd_task_release
refresh_ready = cmd_task_refresh_ready
log = cmd_task_log
publish = cmd_task_publish
advance = cmd_task_advance
request_changes = cmd_task_request_changes
approve_rework = cmd_task_approve_rework
reassign_review = cmd_task_reassign_review
note = cmd_task_note

def comment(args: argparse.Namespace) -> Dict[str, Any]:
    if args.comment_action == "list":
        return cmd_task_comment_list(args)
    return cmd_task_comment(args)

comment_list = cmd_task_comment_list
