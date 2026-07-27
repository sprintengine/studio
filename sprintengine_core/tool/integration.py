"""Review-task charter: markers, warnings, no machinery.

A `review` or `integration_review` task is an ORDINARY task in every runtime
respect — claim, publish, phase walk, done. The kind changes nothing about how
the engine runs it. The markers exist so that:

- plan approval can WARN (never block) when a code-producing plan plans no
  review tasks at all, or when review tasks leave implementation work
  uncovered (MC-1818: roles never self-dispatch, so an unplanned review is no
  review);
- plan approval can SHOW the approver each review task's acceptance criteria
  verbatim, so "this acceptance permits paper verification" is a judgment
  someone makes rather than one nobody is given the material for (MC-1820);
- plan approval can WARN when a code-producing plan has no terminal
  integration check covering the implementation work;
- `plan add-task` can WARN when implementation work is added after the
  integration check already completed (the check is stale by graph shape);
- surfaces can badge the task.

The charter content itself — "prove the pieces work together: build, run the
app, exercise the seams between tasks" — belongs to the task's description
and acceptance criteria, authored by the planner. The engine injects no
prompts for it (prompt-layer ownership: one behavior per layer).

Freshness is graph shape, not machinery: the integration task `dependsOn`
the implementation work, so it necessarily runs against the final tree. Work
added after it completes makes the graph shape wrong, which is exactly what
the add-task warning names. Human plan approval is the decision point; there
is no gate, no proof record, no invalidation state.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

INTEGRATION_REVIEW_KIND = "integration_review"
# MC-1818: reviews are PLANNED TASKS. Roles never self-dispatch — a staffed
# reviewer role produces no review unless the architect planned one — so the
# plan needs a marker the approver can see. `review` marks a review of specific
# tasks' work; `integration_review` marks the terminal seam check. Both are
# ordinary tasks at runtime; the kind changes nothing about how they execute.
REVIEW_KIND = "review"
REVIEW_TASK_KINDS = (REVIEW_KIND, INTEGRATION_REVIEW_KIND)
VALID_TASK_KINDS = ("work", *REVIEW_TASK_KINDS)

# Roles the `--produces-implementation` flag documents as implicitly
# implementation-producing ("even when its role is not developer/frontend").
_IMPLEMENTATION_ROLES = {"developer", "frontend"}


def is_integration_review_task(task: Any) -> bool:
    return isinstance(task, dict) and task.get("kind") == INTEGRATION_REVIEW_KIND


def is_review_task(task: Any) -> bool:
    """Either review kind. `integration_review` IS a review — the seam one."""
    return isinstance(task, dict) and task.get("kind") in REVIEW_TASK_KINDS


def normalize_task_kind(raw: Any, task_id: str) -> Optional[str]:
    """Review kinds survive; `work`/absent normalize to None (plain task)."""
    kind = str(raw or "").strip()
    if not kind or kind == "work":
        return None
    if kind not in REVIEW_TASK_KINDS:
        raise SystemExit(f"Task {task_id} kind must be one of: {', '.join(VALID_TASK_KINDS)}.")
    return kind


def _produces_implementation(task: Dict[str, Any]) -> bool:
    # A review task audits work; it does not produce the work needing review.
    if is_review_task(task):
        return False
    if task.get("status") == "canceled":
        return False
    if task.get("producesImplementation"):
        return True
    return str(task.get("role") or "").strip() in _IMPLEMENTATION_ROLES


def _depends_transitively(tasks_by_id: Dict[str, Dict[str, Any]], source_id: str, target_id: str) -> bool:
    pending = list((tasks_by_id.get(source_id) or {}).get("dependsOn", []) or [])
    seen: set[str] = set()
    while pending:
        candidate = str(pending.pop()).strip()
        if not candidate or candidate in seen:
            continue
        if candidate == target_id:
            return True
        seen.add(candidate)
        pending.extend((tasks_by_id.get(candidate) or {}).get("dependsOn", []) or [])
    return False


def integration_review_warnings(state: Dict[str, Any]) -> List[str]:
    """Plan-shape advisories for the human approving an architect plan.

    Warnings, never errors: the approver may accept a plan without an
    integration task (docs-only runs, spikes) — the point is that the absence
    is a visible decision, not an accident.
    """
    tasks = [task for task in state.get("tasks", []) or [] if isinstance(task, dict)]
    tasks_by_id = {str(task.get("id")): task for task in tasks if task.get("id")}
    impl_ids = [str(task.get("id")) for task in tasks if _produces_implementation(task)]
    if not impl_ids:
        return []
    integration_ids = [
        str(task.get("id"))
        for task in tasks
        if is_integration_review_task(task) and task.get("status") != "canceled"
    ]
    if not integration_ids:
        return [
            "integration_review_missing: this plan produces implementation but has no "
            f"kind={INTEGRATION_REVIEW_KIND} task. Add a terminal integration task that "
            "dependsOn the implementation work and charters proving the pieces work together."
        ]
    uncovered = [
        impl_id
        for impl_id in impl_ids
        if not any(
            _depends_transitively(tasks_by_id, integration_id, impl_id)
            for integration_id in integration_ids
        )
    ]
    if uncovered:
        return [
            "integration_review_incomplete_coverage: integration task(s) "
            f"{', '.join(integration_ids)} do not depend (transitively) on implementation "
            f"task(s) {', '.join(uncovered)}; the integration check will not necessarily "
            "run after that work."
        ]
    return []


def review_planning_warnings(state: Dict[str, Any]) -> List[str]:
    """Does this plan ENGAGE with the review expectation? (MC-1818 plan gate.)

    Warnings, never errors, and never a quota. All three 2026-07-23 sprints
    declared four required sweep roles and ran zero sweep reviewers, because
    architects believed a staffed role self-dispatches its review. Nothing does.
    So the only objective question a plan gate can ask is whether review tasks
    were PLANNED at all, and which implementation work no review task covers.

    Enforcement depth is the run's existing approval mode, not this function's
    business: in manual / approved-artifacts modes the human reads these
    warnings and judges the plan like any artifact; in fully autonomous mode
    auto-approval stands and the planning directive is the guidance. No new
    approval requirement is introduced anywhere (owner ruling 2026-07-23:
    autonomous means autonomous).
    """
    tasks = [task for task in state.get("tasks", []) or [] if isinstance(task, dict)]
    tasks_by_id = {str(task.get("id")): task for task in tasks if task.get("id")}
    impl_ids = [str(task.get("id")) for task in tasks if _produces_implementation(task)]
    if not impl_ids:
        return []
    review_ids = [
        str(task.get("id"))
        for task in tasks
        if is_review_task(task) and task.get("status") != "canceled"
    ]
    if not review_ids:
        return [
            "review_tasks_missing: this plan produces implementation but plans no review "
            f"task (kind={REVIEW_KIND} or kind={INTEGRATION_REVIEW_KIND}). Roles never "
            "self-dispatch — a staffed reviewer role reviews nothing unless a task says so. "
            "Plan review tasks that dependsOn the work they audit, or record in plan.md why "
            "none are needed."
        ]
    uncovered = [
        impl_id
        for impl_id in impl_ids
        if not any(
            _depends_transitively(tasks_by_id, review_id, impl_id) for review_id in review_ids
        )
    ]
    if uncovered:
        return [
            "review_coverage_incomplete: review task(s) "
            f"{', '.join(review_ids)} do not depend (transitively) on implementation task(s) "
            f"{', '.join(uncovered)}, so that work reaches done unreviewed by anyone but its "
            "own author."
        ]
    return []


def review_acceptance_notices(state: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Every planned review task's acceptance, verbatim, for the plan approver.

    MC-1820: T15 satisfied its integration acceptance with "confirm from
    evidence" — re-reading sibling tasks' claims, zero new tests — and that was
    visible AT PLANNING TIME in the acceptance criteria. The fix is judgment,
    not machinery: no diff-shape rule, no ownedPaths cross-check (ownedPaths are
    documented-unreliable and diff shape is gameable both ways). The engine's
    whole job is to put the acceptance text in front of the human who approves
    the plan, so "permits paper verification" is a decision someone actually
    makes. This function judges nothing — it surfaces.
    """
    return [
        {
            "taskId": str(task.get("id") or ""),
            "kind": str(task.get("kind") or ""),
            "title": str(task.get("title") or ""),
            "role": str(task.get("role") or ""),
            "acceptance": [
                str(criterion)
                for criterion in (task.get("acceptanceCriteria") or [])
                if str(criterion).strip()
            ],
        }
        for task in state.get("tasks", []) or []
        if isinstance(task, dict) and is_review_task(task) and task.get("status") != "canceled"
    ]


def stale_integration_review_warning(state: Dict[str, Any], new_task: Dict[str, Any]) -> Optional[str]:
    """Warn when implementation work lands after the integration check finished."""
    if not _produces_implementation(new_task):
        return None
    completed = [
        str(task.get("id"))
        for task in state.get("tasks", []) or []
        if isinstance(task, dict) and is_integration_review_task(task) and task.get("status") == "done"
    ]
    open_integration = any(
        is_integration_review_task(task) and task.get("status") not in {"done", "canceled"}
        for task in state.get("tasks", []) or []
        if isinstance(task, dict)
    )
    if not completed or open_integration:
        return None
    return (
        f"integration_review_stale: integration task(s) {', '.join(completed)} completed before "
        f"{new_task.get('id')} was planned; the new work is not covered. Plan a fresh "
        f"kind={INTEGRATION_REVIEW_KIND} task depending on it."
    )
