"""Sprint Engine plan command handlers."""
from __future__ import annotations

import argparse
from typing import Any, Dict

from sprintengine_core import store as folder_store
from sprintengine_core.tool.feedback import set_architect_difficulty_estimate
from pathlib import Path

from sprintengine_core.tool.plans import (
    apply_plan_gate_dependency,
    resolve_planning_role,
)
from sprintengine_core.tool.roles import require_configured_role
from sprintengine_core.tool.merge_graph import assert_no_repo_dependency_cycle
from sprintengine_core.tool.state import (
    append_event,
    append_task_activity,
    ensure_role_in_roster,
    ensure_task_repo_declared,
    find_task,
    task_lease,
    with_locked_state,
)
from sprintengine_core.tool.tasks import (
    add_unique_values,
    assert_backlog_ref_unclaimed,
    assert_phases_within_run_ceiling,
    backlog_ref_from_args,
    build_task_from_args,
    ensure_task_can_be_replanned,
    normalize_task_backlog_ref,
    parse_phases_arg,
    recompute_phase,
    remove_values,
    set_unique_list,
    task_dependents,
    task_ids,
)

def cmd_plan_add_task(args: argparse.Namespace) -> Dict[str, Any]:
    args.role = require_configured_role(args.role, context="Plan task")

    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        ensure_role_in_roster(state, args.role)
        task = build_task_from_args(args, state)
        apply_plan_gate_dependency(task, state, Path(args.state))
        from sprintengine_core.tool.integration import stale_integration_review_warning
        from sprintengine_core.tool.state import repo_binding_lint_warning
        warnings = [
            warning
            for warning in (
                stale_integration_review_warning(state, task),
                repo_binding_lint_warning(state, task),
            )
            if warning
        ]
        state.setdefault("tasks", []).append(task)
        recompute_phase(state)
        event = append_event(state, "task_added", args.actor, f"{args.actor} added {task['id']}: {task['title']}.")
        return {
            "ok": True,
            "task": task,
            "event": event,
            **({"warnings": warnings} if warnings else {}),
        }

    return with_locked_state(args.state, run)

def cmd_plan_update_task(args: argparse.Namespace) -> Dict[str, Any]:
    if args.role is not None:
        args.role = require_configured_role(args.role, context="Plan task")

    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        try:
            ensure_task_can_be_replanned(task, args.force)
        except SystemExit:
            # Planner repo retarget (MC-1752): the repo binding is operational
            # routing, not plan content. The planning role may correct a
            # mis-bound repo on a started task — the exact stranding the
            # post-merge-hardening T11 hit — as a repo-ONLY, audited update.
            # Everything else on a started task still requires --force.
            planning_role = resolve_planning_role(state)
            actor = str(args.actor or "")
            actor_is_planner = actor == planning_role or actor.startswith(f"{planning_role}-")
            if getattr(args, "repo", None) is None or not actor_is_planner:
                raise
            other_field_requested = any([
                args.title is not None,
                args.description is not None,
                args.clear_description,
                args.role is not None,
                args.clear_paths,
                args.path,
                args.clear_acceptance,
                args.acceptance,
                args.clear_notes,
                args.note,
                getattr(args, "clear_source_docs", False),
                getattr(args, "source_doc", None),
                getattr(args, "backlog_ref", None),
                getattr(args, "backlog_key", None),
                getattr(args, "clear_backlog_ref", False),
                args.clear_task_notes,
                args.task_note,
                args.product_facing,
                args.not_product_facing,
                getattr(args, "produces_implementation", False),
                getattr(args, "kind", None) is not None,
                getattr(args, "needs_triage", None) is True,
                getattr(args, "clear_needs_triage", False),
                getattr(args, "phases", None) is not None,
                getattr(args, "difficulty_pct", None) is not None,
            ])
            if other_field_requested:
                raise SystemExit(
                    f"Task {task.get('id')} has already started: only its repo binding can be "
                    "retargeted without --force. Send the repo change on its own."
                )
            previous_repo = str(task.get("repo") or "primary")
            new_repo = ensure_task_repo_declared(
                state, args.repo, context=f"Task {task.get('id') or args.task_id}"
            )
            task["repo"] = new_repo
            lease = task_lease(task)
            if lease is not None:
                lease["repo"] = new_repo
            append_task_activity(
                task,
                "status_change",
                actor,
                f"{actor} retargeted {args.task_id} repo {previous_repo} -> {new_repo} on a started task.",
                {"repo": new_repo, "previousRepo": previous_repo, "reason": "planner_repo_retarget"},
            )
            recompute_phase(state)
            event = append_event(
                state,
                "task_updated",
                actor,
                f"{actor} retargeted {args.task_id} repo {previous_repo} -> {new_repo}.",
            )
            return {"ok": True, "task": task, "event": event, "repoRetargeted": True}

        if args.title is not None:
            title = args.title.strip()
            if not title:
                raise SystemExit("Task title cannot be empty.")
            task["title"] = title
        if args.description is not None:
            task["description"] = args.description.strip()
        if args.clear_description:
            task["description"] = ""
        if args.role is not None:
            ensure_role_in_roster(state, args.role)
            task["role"] = args.role
        if getattr(args, "repo", None) is not None:
            new_repo = ensure_task_repo_declared(
                state, args.repo, context=f"Task {task.get('id') or args.task_id}"
            )
            current_repo = folder_store.task_repo(task)
            task["repo"] = new_repo
            if new_repo != current_repo:
                # Repo is routing, not a cage (MC-1752): a re-target on a worked
                # task moves the live lease along with the binding, exactly like
                # the planner retarget path above, so commits and diff evidence
                # resolve through the tree the task now targets.
                lease = task_lease(task)
                if lease is not None:
                    lease["repo"] = new_repo

        if args.clear_paths:
            task["ownedPaths"] = []
        set_unique_list(task, "ownedPaths", args.path)

        if args.clear_acceptance:
            task["acceptanceCriteria"] = []
        set_unique_list(task, "acceptanceCriteria", args.acceptance)

        if args.clear_notes:
            task["implementationNotes"] = []
        set_unique_list(task, "implementationNotes", args.note)

        if getattr(args, "clear_source_docs", False):
            task.pop("sourceDocs", None)
        set_unique_list(task, "sourceDocs", getattr(args, "source_doc", None))

        if getattr(args, "clear_backlog_ref", False):
            task.pop("backlogRef", None)
        requested_backlog_ref = backlog_ref_from_args(args)
        if requested_backlog_ref is not None:
            edited_task_id = str(task.get("id") or args.task_id)
            backlog_ref = normalize_task_backlog_ref(requested_backlog_ref, edited_task_id)
            # After the repo edit above, so a re-target and a new pointer in the
            # same call are checked against the project the task ends up in.
            assert_backlog_ref_unclaimed(state, backlog_ref, task)
            task["backlogRef"] = backlog_ref

        if args.clear_task_notes:
            task["notes"] = []
        set_unique_list(task, "notes", args.task_note)

        if args.product_facing and args.not_product_facing:
            raise SystemExit("--product-facing and --not-product-facing cannot be used together.")
        if args.product_facing:
            task["productFacing"] = True
        elif args.not_product_facing:
            task["productFacing"] = False
        if getattr(args, "produces_implementation", False):
            task["producesImplementation"] = True
        if getattr(args, "kind", None) is not None:
            from sprintengine_core.tool.integration import normalize_task_kind
            kind = normalize_task_kind(args.kind, str(task.get("id") or args.task_id))
            if kind is None:
                task.pop("kind", None)
            else:
                task["kind"] = kind
        if getattr(args, "needs_triage", None) is True:
            task["needsTriage"] = True
        elif getattr(args, "clear_needs_triage", False):
            task["needsTriage"] = False
        phases = parse_phases_arg(getattr(args, "phases", None))
        if phases is not None:
            assert_phases_within_run_ceiling(state, phases, str(task.get("id") or args.task_id))
            task["phases"] = phases
        set_architect_difficulty_estimate(
            task,
            getattr(args, "difficulty_pct", None),
            getattr(args, "difficulty_reason", "") or "",
        )

        candidates = [candidate for candidate in state.get("tasks", []) if isinstance(candidate, dict)]
        try:
            folder_store.validate_acyclic_task_graph(candidates)
        except ValueError as exc:
            raise SystemExit(str(exc)) from exc
        # Re-targeting a task's project rewrites the repo graph under dependencies that
        # were legal where the task used to live, so the loop check belongs here too.
        assert_no_repo_dependency_cycle(candidates)
        recompute_phase(state)
        event = append_event(state, "task_updated", args.actor, f"{args.actor} updated {args.task_id}.")
        return {"ok": True, "task": task, "event": event}

    return with_locked_state(args.state, run)

def cmd_plan_delete_task(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        ensure_task_can_be_replanned(task, args.force)

        dependents = task_dependents(state, args.task_id)
        if dependents and not args.unlink_dependents:
            return {
                "ok": False,
                "error": f"Task {args.task_id} is still a dependency of: {', '.join(dependents)}. Use --unlink-dependents to remove those links.",
                "write": False,
            }
        if args.unlink_dependents:
            for candidate in state.get("tasks", []):
                if isinstance(candidate, dict):
                    candidate["dependsOn"] = [dep for dep in candidate.get("dependsOn", []) if dep != args.task_id]

        remaining = [
            candidate for candidate in state.get("tasks", [])
            if isinstance(candidate, dict) and candidate.get("id") != args.task_id
        ]
        try:
            folder_store.validate_acyclic_task_graph(remaining)
        except ValueError as exc:
            raise SystemExit(str(exc)) from exc
        state["tasks"] = remaining
        recompute_phase(state)
        event = append_event(state, "task_deleted", args.actor, f"{args.actor} deleted {args.task_id}.")
        return {"ok": True, "deletedTaskId": args.task_id, "unlinkedDependents": dependents if args.unlink_dependents else [], "event": event}

    return with_locked_state(args.state, run)

def cmd_plan_add_dependency(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        ensure_task_can_be_replanned(task, args.force)
        ids = task_ids(state)
        deps = args.depends_on or []
        missing = [dep for dep in deps if dep not in ids]
        if missing:
            raise SystemExit(f"Unknown dependency for {args.task_id}: {', '.join(missing)}")
        if args.task_id in deps:
            raise SystemExit("A task cannot depend on itself.")

        original_deps = list(task.get("dependsOn", []))
        candidate_deps = list(original_deps)
        for dep in deps:
            if dep not in candidate_deps:
                candidate_deps.append(dep)
        candidate_tasks = []
        for candidate in state.get("tasks", []):
            if not isinstance(candidate, dict):
                continue
            if candidate.get("id") == args.task_id:
                preview = dict(candidate)
                preview["dependsOn"] = candidate_deps
                candidate_tasks.append(preview)
            else:
                candidate_tasks.append(candidate)
        try:
            folder_store.validate_acyclic_task_graph(candidate_tasks)
        except ValueError as exc:
            raise SystemExit(str(exc)) from exc
        # An orderable TASK graph can still be an unorderable REPO graph: the new edge
        # may be the one that makes two projects each wait for the other to merge.
        assert_no_repo_dependency_cycle(candidate_tasks)
        added = add_unique_values(task, "dependsOn", deps)
        recompute_phase(state)
        event = append_event(state, "task_dependencies_added", args.actor, f"{args.actor} added dependencies to {args.task_id}: {', '.join(added) or 'none'}.")
        return {"ok": True, "task": task, "added": added, "event": event}

    return with_locked_state(args.state, run)

def cmd_plan_remove_dependency(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        ensure_task_can_be_replanned(task, args.force)
        original_deps = list(task.get("dependsOn", []))
        candidate_deps = [dep for dep in original_deps if dep not in (args.depends_on or [])]
        candidate_tasks = []
        for candidate in state.get("tasks", []):
            if not isinstance(candidate, dict):
                continue
            if candidate.get("id") == args.task_id:
                preview = dict(candidate)
                preview["dependsOn"] = candidate_deps
                candidate_tasks.append(preview)
            else:
                candidate_tasks.append(candidate)
        try:
            folder_store.validate_acyclic_task_graph(candidate_tasks)
        except ValueError as exc:
            raise SystemExit(str(exc)) from exc
        removed = remove_values(task, "dependsOn", args.depends_on or [])
        recompute_phase(state)
        event = append_event(state, "task_dependencies_removed", args.actor, f"{args.actor} removed dependencies from {args.task_id}: {', '.join(removed) or 'none'}.")
        return {"ok": True, "task": task, "removed": removed, "event": event}

    return with_locked_state(args.state, run)

def cmd_plan_list(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        tasks = state.get("tasks", [])
        rows = [
            {
                "id": t.get("id"),
                "title": t.get("title"),
                "role": t.get("role"),
                "status": t.get("status"),
                "dependsOn": t.get("dependsOn", []),
                "descriptionPresent": bool(str(t.get("description", "")).strip()),
                "pathCount": len(t.get("ownedPaths", []) if isinstance(t.get("ownedPaths"), list) else []),
                "acceptanceCount": len(t.get("acceptanceCriteria", []) if isinstance(t.get("acceptanceCriteria"), list) else []),
                "noteCount": len(t.get("implementationNotes", []) if isinstance(t.get("implementationNotes"), list) else []),
            }
            for t in tasks
            if isinstance(t, dict)
        ]
        return {"ok": True, "tasks": rows, "write": False}

    return with_locked_state(args.state, run)

add_task = cmd_plan_add_task
update_task = cmd_plan_update_task
delete_task = cmd_plan_delete_task
add_dependency = cmd_plan_add_dependency
remove_dependency = cmd_plan_remove_dependency
list_tasks = cmd_plan_list
