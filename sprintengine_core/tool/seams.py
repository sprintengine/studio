"""Seam information: the plan's `## Seams` section and the hot-seam signal.

Two mechanisms, both INFORMATION, neither a quota (owner philosophy: the
architect alone decides what tasks are needed; nothing else mutates the plan).

**The seam map (MC-1819).** At planning the architect writes a `## Seams`
section into `plan.md`: every file or contract expected to be touched by 2+
tasks, the owning tasks, and the invariant at that seam. Measured need from the
three sprints merged 2026-07-23: conversation had 52% of files touched by 2+
tasks (9 of 12 tasks through one component), terminal-first 37%, global-surface
16% — and every major the post-merge sweep found sat on an UNMAPPED seam. The
plan gate here checks only that the section EXISTS on a multi-task plan, which
is objective. No overlap number ever rejects a plan.

**The hot-seam signal (MC-1822).** When a third task publishes changes to the
same source file or the same IPC contract, the engine tells the ARCHITECT and
stops. It does not add a checkpoint task, reorder the graph, or block the
publish — the architect decides whether a checkpoint review is worth one triage
decision, or notes why not. In terminal-first the T4/T5/T9
review-ipc/preload/electron-api triple was exactly this shape, got no dedicated
look, and the post-merge sweep found a producer with zero consumers sitting on
it (item 1804).

Signals are recorded once per seam (`state["seamSignals"]`) so the architect is
told at the third landing rather than on every publish after it.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

PLAN_SEAMS_HEADING = "## Seams"
# Below this a plan has no seams by construction: one task cannot collide with
# itself. The plan-approval gate is silent for single-task plans.
MULTI_TASK_PLAN_THRESHOLD = 2
# Three landings, not two: two owners on a file is the ordinary shape the seam
# map already predicted and the architect already priced in. The third is the
# point where the seam is demonstrably a thoroughfare rather than a handoff.
HOT_SEAM_OWNER_THRESHOLD = 3

# An IPC contract in this codebase is a main handler + preload bridge + shared
# api triple. Grouping the three files under one contract name means the signal
# fires on "three tasks touched this contract" even when each touched a
# different file of it — which is exactly the T4/T5/T9 shape that went unseen.
_IPC_SEGMENTS = ("preload", "shared", "main")


def plan_seam_section_warnings(state: Dict[str, Any], plan_path: Path) -> List[str]:
    """Objective plan-gate check: does a multi-task plan carry `## Seams`?

    Presence only. The engine never reads the section's content, counts the
    seams in it, or compares them to the task graph — the map is information
    for the architect's decomposition call and the reviewers' reading list,
    and judging it belongs to the human approving the plan.
    """
    tasks = [task for task in state.get("tasks", []) or [] if isinstance(task, dict)]
    planned = [task for task in tasks if task.get("status") != "canceled"]
    if len(planned) < MULTI_TASK_PLAN_THRESHOLD:
        return []
    try:
        content = plan_path.read_text(encoding="utf-8")
    except OSError:
        # No readable plan file is the artifact layer's problem, not this
        # check's — staying quiet here keeps one failure reported once.
        return []
    if _has_heading(content, PLAN_SEAMS_HEADING):
        return []
    return [
        "plan_seam_section_missing: this plan has multiple tasks but no "
        f"`{PLAN_SEAMS_HEADING}` section. List every file or contract 2+ tasks are "
        "expected to touch, the owning task ids, and the invariant that must hold "
        "there — or say `None` and why. It scopes the seam review's acceptance and "
        "the reviewers' reading list."
    ]


def _has_heading(content: str, heading: str) -> bool:
    target = heading.strip().lower()
    for line in content.splitlines():
        stripped = line.strip().lower()
        if stripped == target or stripped.startswith(f"{target} "):
            return True
    return False


def seam_key(path: str) -> str:
    """The seam a changed path belongs to: its IPC contract, else the file.

    `src/main/foo-ipc.ts`, `src/preload/foo.ts` and `src/shared/foo.ts` are one
    contract, so they answer with the same key. Everything else is its own seam
    and answers with its own path.
    """
    normalized = str(path or "").replace("\\", "/").strip().lstrip("./")
    if not normalized:
        return ""
    contract = _ipc_contract_key(normalized)
    return contract or normalized


def _ipc_contract_key(path: str) -> Optional[str]:
    segments = path.split("/")
    for segment in _IPC_SEGMENTS:
        if segment not in segments:
            continue
        stem = segments[-1].rsplit(".", 1)[0]
        # `foo-ipc`, `fooIpc`, `foo.handlers` all name the `foo` contract.
        for suffix in ("-ipc", "-handlers", "-bridge", "-api"):
            if stem.endswith(suffix):
                stem = stem[: -len(suffix)]
                break
        if not stem:
            return None
        return f"ipc:{stem}"
    return None


def published_seam_owners(state: Dict[str, Any]) -> Dict[str, List[str]]:
    """Seam -> the task ids that have PUBLISHED changes to it.

    Published, not planned: `ownedPaths` are documented-unreliable, so the
    signal reads the diff evidence a task actually landed. A task counts once
    per seam no matter how many of its files belong to that seam.
    """
    owners: Dict[str, List[str]] = {}
    for task in state.get("tasks", []) or []:
        if not isinstance(task, dict) or task.get("status") == "canceled":
            continue
        task_id = str(task.get("id") or "")
        if not task_id or not _has_published(task):
            continue
        for key in _task_seam_keys(task):
            bucket = owners.setdefault(key, [])
            if task_id not in bucket:
                bucket.append(task_id)
    return owners


def _has_published(task: Dict[str, Any]) -> bool:
    # A task has landed changes once it is past implementation: `review` is the
    # owner reviewing its own published diff, and `done` is terminal.
    if task.get("status") in {"review", "done"}:
        return True
    return bool(task.get("lastPublishedAt"))


def _task_seam_keys(task: Dict[str, Any]) -> Iterable[str]:
    evidence = task.get("evidence")
    paths: List[str] = []
    if isinstance(evidence, dict):
        for diff in evidence.get("diffs") or []:
            if isinstance(diff, dict) and diff.get("path"):
                paths.append(str(diff["path"]))
        touched = evidence.get("touchedFiles")
        if isinstance(touched, list):
            paths.extend(str(value) for value in touched if value)
    keys = []
    for path in paths:
        key = seam_key(path)
        if key and key not in keys:
            keys.append(key)
    return keys


def hot_seam_signals(state: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Seams that have reached the third landing and have not been reported yet.

    Returns the signal payloads; recording them is `record_seam_signals`, so a
    caller that only wants to look (a projection, a test) never mutates state.
    """
    reported = {
        str(entry.get("seam"))
        for entry in state.get("seamSignals", []) or []
        if isinstance(entry, dict)
    }
    signals = []
    for seam, owners in sorted(published_seam_owners(state).items()):
        if len(owners) < HOT_SEAM_OWNER_THRESHOLD or seam in reported:
            continue
        signals.append({
            "seam": seam,
            "ownerTaskIds": list(owners),
            "landedCount": len(owners),
            "question": (
                f"Seam `{seam}` is hot: {len(owners)} tasks ({', '.join(owners)}) have now "
                "published changes to it. Consider planning a checkpoint review task over it "
                "— or note why one is not warranted. The engine adds no task; this is yours "
                "to decide."
            ),
        })
    return signals


def record_seam_signals(
    state: Dict[str, Any], signals: List[Dict[str, Any]], reported_at: str
) -> List[Dict[str, Any]]:
    """Persist raised signals so the third landing reports once, not forever."""
    if not signals:
        return []
    log = state.setdefault("seamSignals", [])
    for signal in signals:
        log.append({
            "seam": signal["seam"],
            "ownerTaskIds": list(signal["ownerTaskIds"]),
            "landedCount": signal["landedCount"],
            "reportedAt": reported_at,
        })
    return signals
