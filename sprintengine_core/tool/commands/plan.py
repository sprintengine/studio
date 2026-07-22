"""Sprint Engine plan command handlers."""
from __future__ import annotations

import argparse
from typing import Any, Dict

from sprintengine_core import store as folder_store
from sprintengine_core.skill_layers import run_is_backlog_sourced
from sprintengine_core.tool.artifacts import project_relative_display_path
from sprintengine_core.tool.feedback import set_architect_difficulty_estimate
from pathlib import Path

from sprintengine_core.tool.plans import (
    apply_plan_gate_dependency,
    build_address_reviews_prompt,
    build_plan_review_prompt,
    build_plan_review_status,
    build_plan_review_template,
    expected_plan_reviewers,
    parse_review_metadata,
    plan_fingerprint,
    plan_path_for_state,
    plan_reviews_dir_for_state,
    resolve_planning_role,
    safe_review_filename,
)
from sprintengine_core.tool.roles import require_configured_role
from sprintengine_core.tool.merge_graph import assert_no_repo_dependency_cycle
from sprintengine_core.tool.state import (
    active_lease_worker,
    append_event,
    ensure_role_in_roster,
    ensure_task_repo_declared,
    find_task,
    load_mutation_state,
    with_locked_state,
)
from sprintengine_core.tool.tasks import (
    add_unique_values,
    assert_phases_within_run_ceiling,
    build_task_from_args,
    ensure_task_can_be_replanned,
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
        stale_warning = stale_integration_review_warning(state, task)
        state.setdefault("tasks", []).append(task)
        recompute_phase(state)
        event = append_event(state, "task_added", args.actor, f"{args.actor} added {task['id']}: {task['title']}.")
        return {
            "ok": True,
            "task": task,
            "event": event,
            **({"warnings": [stale_warning]} if stale_warning else {}),
        }

    return with_locked_state(args.state, run)

def cmd_plan_update_task(args: argparse.Namespace) -> Dict[str, Any]:
    if args.role is not None:
        args.role = require_configured_role(args.role, context="Plan task")

    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        ensure_task_can_be_replanned(task, args.force)

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
            if new_repo != current_repo and active_lease_worker(task) is not None:
                # A live worker is already editing `current_repo`'s worktree. Moving
                # only the lease's repo (the old behavior) left that session in the
                # old tree while its commit and diff evidence resolved through the new
                # one — commits stage nothing and real edits orphan. Refuse until the
                # task is released so the pool respawns in the correct tree; a
                # same-repo set is a no-op and stays allowed.
                raise SystemExit(
                    f"Cannot re-target {task.get('id') or args.task_id} from project "
                    f"{current_repo!r} to {new_repo!r} while it is being worked. Release "
                    "the task first so it respawns in the new project's worktree."
                )
            task["repo"] = new_repo

        if args.clear_paths:
            task["ownedPaths"] = []
        set_unique_list(task, "ownedPaths", args.path)

        if args.clear_acceptance:
            task["acceptanceCriteria"] = []
        set_unique_list(task, "acceptanceCriteria", args.acceptance)

        if args.clear_notes:
            task["implementationNotes"] = []
        set_unique_list(task, "implementationNotes", args.note)

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

def cmd_plan_start_review(args: argparse.Namespace) -> Dict[str, Any]:
    args.role = require_configured_role(args.role, context="Plan review")
    state = load_mutation_state(args.state)
    # No planner reviews its own plan. The guard follows the run's planning role, so
    # a general that planned its own run cannot sign off on that plan just because it
    # is not literally an architect.
    planning_role = resolve_planning_role(state)
    if args.role == planning_role:
        raise SystemExit(
            f"{planning_role.capitalize()} does not review its own Sprint Engine plan through plan start-review."
        )
    ensure_role_in_roster(state, args.role)
    plan_path = plan_path_for_state(args.state)
    reviews_dir = plan_reviews_dir_for_state(args.state)
    fingerprint = plan_fingerprint(plan_path)
    reviews_dir.mkdir(parents=True, exist_ok=True)

    review_path = reviews_dir / safe_review_filename(args.id)
    existing_review = review_path.exists()
    if not existing_review:
        review_path.write_text(
            build_plan_review_template(args.id, args.role, plan_path, fingerprint),
            encoding="utf-8",
        )

    prompt = build_plan_review_prompt(
        args.id,
        args.role,
        args.state,
        plan_path,
        review_path,
        fingerprint,
        existing_review,
        backlog_sourced=run_is_backlog_sourced(state),
    )
    known_reviewers = expected_plan_reviewers(state)
    return {
        "ok": True,
        "role": args.role,
        "agentId": args.id,
        "action": "plan_review",
        "planPath": project_relative_display_path(args.state, plan_path),
        "reviewPath": project_relative_display_path(args.state, review_path),
        "reviewExisted": existing_review,
        "planFingerprint": fingerprint,
        "knownReviewers": known_reviewers,
        "prompt": prompt,
    }

def cmd_plan_review_status(args: argparse.Namespace) -> Dict[str, Any]:
    state = load_mutation_state(args.state)
    return {"ok": True, "action": "plan_review_status", **build_plan_review_status(state, args.state)}

def cmd_plan_address_reviews(args: argparse.Namespace) -> Dict[str, Any]:
    state = load_mutation_state(args.state)
    reviews_dir = plan_reviews_dir_for_state(args.state)
    status = build_plan_review_status(state, args.state)
    reviews = []

    if reviews_dir.exists():
        for path in sorted(reviews_dir.glob("*.md")):
            metadata = parse_review_metadata(path)
            reviews.append({
                "path": str(path),
                "agentId": metadata.get("agentId"),
                "role": metadata.get("role"),
                "verdict": metadata.get("verdict"),
            })

    prompt = build_address_reviews_prompt(state, args.state, status, reviews)
    return {
        "ok": True,
        "role": "architect",
        "actor": args.actor,
        "action": "address_plan_reviews",
        "planPath": status["planPath"],
        "reviewsDirectory": status["reviewsDirectory"],
        "reviewCount": len(reviews),
        "reviews": reviews,
        "status": status,
        "prompt": prompt,
    }

add_task = cmd_plan_add_task
update_task = cmd_plan_update_task
delete_task = cmd_plan_delete_task
add_dependency = cmd_plan_add_dependency
remove_dependency = cmd_plan_remove_dependency
list_tasks = cmd_plan_list
start_review = cmd_plan_start_review
review_status = cmd_plan_review_status
address_reviews = cmd_plan_address_reviews
