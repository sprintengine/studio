"""Integration-review charter marker (`kind: integration_review`).

The kind is a marker, not machinery: these tests pin that it survives
normalization, that plan approval WARNS (never blocks) when implementation
work lacks integration coverage, and that adding implementation work after
the integration task completed warns that the check is stale. There is no
proof record, no barrier, no special runtime behavior to test — an
integration task claims, publishes, and completes like any other task.
"""
from __future__ import annotations

import pytest

from helpers import base_state, task
from sprintengine_core.tool.integration import (
    INTEGRATION_REVIEW_KIND,
    integration_review_warnings,
    is_integration_review_task,
    normalize_task_kind,
    stale_integration_review_warning,
)


def integration_task(task_id: str, depends_on: list[str], status: str = "todo") -> dict:
    record = task(task_id, f"Integration review {task_id}", "developer", status=status, depends_on=depends_on)
    record["kind"] = INTEGRATION_REVIEW_KIND
    return record


def test_normalize_task_kind_round_trip() -> None:
    assert normalize_task_kind("integration_review", "T1") == INTEGRATION_REVIEW_KIND
    assert normalize_task_kind("work", "T1") is None
    assert normalize_task_kind(None, "T1") is None
    assert normalize_task_kind("", "T1") is None
    with pytest.raises(SystemExit):
        normalize_task_kind("integration_proof", "T1")


def test_normalize_task_preserves_marker_and_drops_work() -> None:
    from sprintengine_core.tool.tasks import normalize_task

    raw = task("T1", "Integrate", "developer")
    raw["kind"] = INTEGRATION_REVIEW_KIND
    assert normalize_task(raw).get("kind") == INTEGRATION_REVIEW_KIND

    raw = task("T2", "Build", "developer")
    raw["kind"] = "work"
    assert "kind" not in normalize_task(raw)


def test_no_warnings_without_implementation_tasks() -> None:
    state = base_state("s", [task("T1", "Write docs", "docs")])
    assert integration_review_warnings(state) == []


def test_missing_integration_task_warns() -> None:
    state = base_state("s", [task("T1", "Build feature", "developer")])
    warnings = integration_review_warnings(state)
    assert len(warnings) == 1
    assert "integration_review_missing" in warnings[0]


def test_covered_plan_is_quiet() -> None:
    state = base_state(
        "s",
        [
            task("T1", "Build feature", "developer"),
            task("T2", "Build surface", "frontend", depends_on=["T1"]),
            integration_task("T3", depends_on=["T2"]),
        ],
    )
    assert integration_review_warnings(state) == []


def test_uncovered_implementation_task_warns() -> None:
    state = base_state(
        "s",
        [
            task("T1", "Build feature", "developer"),
            task("T2", "Sidecar work", "developer"),
            integration_task("T3", depends_on=["T1"]),
        ],
    )
    warnings = integration_review_warnings(state)
    assert len(warnings) == 1
    assert "integration_review_incomplete_coverage" in warnings[0]
    assert "T2" in warnings[0]


def test_producesimplementation_flag_counts_as_implementation() -> None:
    flagged = task("T1", "Wire pipeline", "devops")
    flagged["producesImplementation"] = True
    state = base_state("s", [flagged])
    assert "integration_review_missing" in integration_review_warnings(state)[0]


def test_canceled_tasks_do_not_demand_coverage() -> None:
    state = base_state(
        "s",
        [
            task("T1", "Build feature", "developer", status="canceled"),
            task("T2", "Write docs", "docs"),
        ],
    )
    assert integration_review_warnings(state) == []


def test_stale_warning_when_integration_already_done() -> None:
    state = base_state(
        "s",
        [
            task("T1", "Build feature", "developer", status="done"),
            integration_task("T2", depends_on=["T1"], status="done"),
        ],
    )
    late = task("T3", "Late fix", "developer")
    warning = stale_integration_review_warning(state, late)
    assert warning is not None and "integration_review_stale" in warning and "T2" in warning


def test_no_stale_warning_while_integration_still_open() -> None:
    state = base_state(
        "s",
        [
            task("T1", "Build feature", "developer", status="done"),
            integration_task("T2", depends_on=["T1"], status="done"),
            integration_task("T4", depends_on=["T1"]),
        ],
    )
    assert stale_integration_review_warning(state, task("T3", "Late fix", "developer")) is None


def test_non_implementation_addition_never_warns_stale() -> None:
    state = base_state(
        "s",
        [
            task("T1", "Build feature", "developer", status="done"),
            integration_task("T2", depends_on=["T1"], status="done"),
        ],
    )
    assert stale_integration_review_warning(state, task("T3", "Update docs", "docs")) is None


def test_is_integration_review_task_shape_guard() -> None:
    assert not is_integration_review_task(None)
    assert not is_integration_review_task({"kind": "work"})
    assert is_integration_review_task({"kind": INTEGRATION_REVIEW_KIND})
