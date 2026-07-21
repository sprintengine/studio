"""Integration-review charter: a marker, a warning, no machinery.

An `integration_review` task is an ORDINARY task in every runtime respect —
claim, publish, phase walk, done. The kind changes nothing about how the
engine runs it. It exists so that:

- plan approval can WARN (never block) when a code-producing plan has no
  terminal integration check covering the implementation work;
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

# Roles the `--produces-implementation` flag documents as implicitly
# implementation-producing ("even when its role is not developer/frontend").
_IMPLEMENTATION_ROLES = {"developer", "frontend"}


def is_integration_review_task(task: Any) -> bool:
    return isinstance(task, dict) and task.get("kind") == INTEGRATION_REVIEW_KIND


def normalize_task_kind(raw: Any, task_id: str) -> Optional[str]:
    """`integration_review` survives; `work`/absent normalize to None (plain task)."""
    kind = str(raw or "").strip()
    if not kind or kind == "work":
        return None
    if kind != INTEGRATION_REVIEW_KIND:
        raise SystemExit(f"Task {task_id} kind must be work or {INTEGRATION_REVIEW_KIND}.")
    return INTEGRATION_REVIEW_KIND


def _produces_implementation(task: Dict[str, Any]) -> bool:
    if is_integration_review_task(task):
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
