"""Sprint Engine task command handlers."""
from __future__ import annotations

import argparse
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
    TERMINAL_TASK_STATUSES,
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
    declared_repo_ids,
    end_lease,
    ensure_role_in_roster,
    ensure_task_repo_declared,
    find_task,
    mint_lease,
    reconcile_worker,
    refuse_if_run_canceled,
    release_expired_agent_targets,
    run_is_canceled,
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
        # A canceled run dispatches nothing: report it as canceled rather than the
        # generic "no ready task" so the caller stops instead of reading it as a
        # transient lull. Cancel already released every non-done task's owner, so
        # there is no active task to resume here either.
        if run_is_canceled(state):
            return {
                "ok": True,
                "claimed": False,
                "reason": "run_canceled",
                "message": "This Sprint Engine run was canceled. No work will be claimed; stop.",
                "write": False,
            }
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
                # An unbound session (headless/CLI, an older app build) carries no
                # worktree binding, so it is unfiltered by design. But in a multi-repo
                # run that lets it grab a sibling-repo task while it likely sits in the
                # primary checkout — the commit lock, cwd, and repo-relative paths would
                # then resolve against the wrong tree and only fail at publish/commit.
                # Surface it here, at claim time, instead of failing late; the claim
                # still proceeds so a session genuinely in the sibling tree is not blocked.
                selected_repo = folder_store.task_repo(selected)
                unbound_cross_tree_warning = (
                    f"Session {args.id} is not bound to a project but claimed {selected.get('id')} in "
                    f"{selected_repo!r}. If this session is not running in that project's worktree, its "
                    "commits and paths will resolve against the wrong tree — pass --repo to bind it."
                    if not session_repo
                    and selected_repo != folder_store.DEFAULT_TASK_REPO
                    and len(declared_repo_ids(state)) > 1
                    else None
                )
                model, cli = _resolve_execution_identity(args)
                result = assign_task(state, selected, args.id, model=model, cli=cli)
                recompute_phase(state)
                event = append_event(state, "task_claimed", args.id, f"{args.id} claimed {selected.get('id')}.")
                return {
                    "ok": True,
                    "claimed": True,
                    "task": selected,
                    "agent": result["agent"],
                    "prompt": build_rework_prompt(args.state, selected),
                    "event": event,
                    "releasedExpired": expired["released"],
                    **({"warnings": [unbound_cross_tree_warning]} if unbound_cross_tree_warning else {}),
                }

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
        # Canceled runs refuse this writer like every other one: a same-status
        # `--status done` re-send would otherwise reach the commit sweep and land
        # a commit on the canceled run's branch, and the human send-back would
        # reopen a task no writer can ever move again (publish/advance/log all
        # refuse), wedging it in_progress for good.
        refuse_if_run_canceled(state, "task.status")
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
        if previous_status in TERMINAL_TASK_STATUSES and args.status != previous_status:
            # Done is terminal (fix-forward): agents never resurrect completed
            # work. The one sanctioned reopen is the human Inbox send-back
            # (done -> in_progress under the implementer), marked by the
            # supervisor-only --actor-kind human flag.
            human_send_back = (
                getattr(args, "actor_kind", "agent") == "human"
                and previous_status == "done"
                and args.status == "in_progress"
            )
            if not human_send_back:
                raise SystemExit(
                    f"{args.task_id} is {previous_status} and terminal. Completed tasks are never "
                    "reopened (fix-forward): create a new task for the follow-up work "
                    "(sprintengine.plan.add_task) instead."
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
        refuse_if_run_canceled(state, "task.log")
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
        # reviewer audits N tasks and records one assessment per audited task via
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
        # Refuse before any commit: a canceled run must not land a commit on the
        # branch or drive a canceled task toward done (see refuse_if_run_canceled).
        refuse_if_run_canceled(state, "task.publish")
        task = find_task(state, args.task_id)
        actor = args.id or task.get("ownerAgentId") or task.get("role") or "agent"
        summary_data = parse_json_object_arg(getattr(args, "summary_data_json", None), "--summary-data-json")
        refresh_task_diff_evidence(state, args.state, task, str(actor), args.path or [])
        # Guard BEFORE the backstop commit: an orphan is owned by no task, so this
        # task's commit never stages it and the orphan set is identical either way.
        # Checking first means a blocked publish commits nothing and aborts cleanly
        # (a raised SystemExit discards the state write in with_locked_state, so a
        # commit made here would otherwise persist in git but go unrecorded in the
        # run store).
        from sprintengine_core.tool.repo_model import get_run_vcs
        from sprintengine_core.tool.shell import task_scoped_orphaned_dirty_paths
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
        result = publish_task(
            state, args.state, task, str(actor), args.summary,
            paths=args.path or [], data=summary_data,
            no_changes_ok=bool(getattr(args, "no_changes_ok", False)),
        )
        recompute_phase(state)
        # The analysis-only exit is loud everywhere it surfaces (MC-1753): the
        # event says so, and a feedback row still lands so the metrics stream
        # keeps one row per completed task.
        no_changes_suffix = " (no changes — analysis-only)" if result.get("completionKind") == "no_changes" else ""
        event = append_event(
            state, "task_published", str(actor),
            f"{actor} published {args.task_id} to {result['nextStatus']}{no_changes_suffix}.",
        )
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
        # Post-commit leftover check (MC-1753): after the sweep, in-scope dirty
        # paths anywhere mean a commit path failed — surface it loudly.
        from sprintengine_core.tool.shell import _task_in_scope_dirty_paths, vcs_repos
        leftover_dirty: List[str] = []
        if get_run_vcs(state):
            for repo in vcs_repos(get_run_vcs(state)):
                for path in _task_in_scope_dirty_paths(state, args.state, task, repo):
                    leftover_dirty.append(f"{repo.get('id')}:{path}")
        no_changes_record = None
        if result.get("completionKind") == "no_changes":
            from pathlib import Path as _Path

            from sprintengine_core.tool.constants import FEEDBACK_SCHEMA_VERSION
            from sprintengine_core.tool.feedback import difficulty_snapshot, observed_task_metrics
            team_slug = str(state.get("sprintengine", {}).get("name") or _Path(args.state).parent.name)
            no_changes_record = {
                "schema_version": FEEDBACK_SCHEMA_VERSION,
                "run_id": team_slug,
                "team_slug": team_slug,
                "task_id": str(task.get("id") or args.task_id),
                "agent_id": str(actor),
                "role": str(task.get("role") or ""),
                "task_title": task.get("title") or "",
                "captured_at": now_iso(),
                "source": "publish_no_changes",
                "scores": {},
                "counts": {},
                "observed": observed_task_metrics(task),
                "phase": "review",
                "phase_outcome": "pass",
                "no_changes": True,
            }
            difficulty = difficulty_snapshot(task)
            if difficulty:
                no_changes_record["difficulty"] = difficulty
        return {
            "ok": True,
            "task": task,
            "comment": result["comment"],
            "nextStatus": result["nextStatus"],
            "previousStatus": result["previousStatus"],
            "producedChanges": result["producedChanges"],
            "phases": result["phases"],
            **({"completionKind": result["completionKind"]} if result.get("completionKind") else {}),
            **({"awaitingPhaseSession": awaiting} if awaiting else {}),
            **({"nextDirective": next_directive} if next_directive else {}),
            **({
                "warnings": [
                    "In-scope changes remain uncommitted after publish "
                    f"({', '.join(leftover_dirty[:10])}) — a commit path failed; "
                    "run sprintengine vcs commit and investigate."
                ],
            } if leftover_dirty else {}),
            "committed": bool(commit_sha),
            "commitSha": commit_sha,
            "event": event,
            "_noChangesFeedbackRecord": no_changes_record,
            **(continuation or {}),
        }

    result = with_locked_state(args.state, run)
    feedback_record = result.pop("_noChangesFeedbackRecord", None)
    if feedback_record:
        result["feedbackRecorded"] = True
        result["feedbackMetricsPath"] = append_feedback_record(args.state, feedback_record)
    return result


def cmd_task_advance(args: argparse.Namespace) -> Dict[str, Any]:
    """Close the task's current phase and step forward. Owner-only."""

    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        refuse_if_run_canceled(state, "task.advance")
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
note = cmd_task_note

def comment(args: argparse.Namespace) -> Dict[str, Any]:
    if args.comment_action == "list":
        return cmd_task_comment_list(args)
    return cmd_task_comment(args)

comment_list = cmd_task_comment_list
