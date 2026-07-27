"""Reviews are PLANNED TASKS (MC-1818), and what plan approval says about it.

All three sprints merged 2026-07-23 declared four required sweep roles and ran
zero sweep reviewers, because architects believed a staffed role self-dispatches
its review. Nothing does. These tests pin the three things that follow:

- the `review` charter marker survives normalization alongside
  `integration_review`, and a review task is not itself implementation work;
- plan approval WARNS (never blocks) when a code-producing plan plans no review
  at all, or when review tasks leave implementation work uncovered;
- plan approval hands the approver every review task's acceptance criteria
  verbatim (MC-1820), so "this acceptance permits paper verification" is a
  judgment someone is actually given the material to make.

The reflexive part matters: this is the machinery a sprint uses to plan its own
reviews, so it is tested directly rather than left for the next run to reveal.
"""
from __future__ import annotations

import pytest

from helpers import base_state, create_team, get_artifact, read_state, task, write_state
from sprintengine_core.tool.integration import (
    INTEGRATION_REVIEW_KIND,
    REVIEW_KIND,
    is_review_task,
    normalize_task_kind,
    review_acceptance_notices,
    review_planning_warnings,
)
from sprintengine_core.tool.plans import ensure_plan_approval_gate


def review_task(task_id: str, depends_on: list[str], kind: str = REVIEW_KIND, **kwargs) -> dict:
    record = task(task_id, f"Review {task_id}", "developer", depends_on=depends_on, **kwargs)
    record["kind"] = kind
    return record


# --- the marker ---------------------------------------------------------------


def test_review_kind_round_trips_and_work_still_clears() -> None:
    assert normalize_task_kind("review", "T1") == REVIEW_KIND
    assert normalize_task_kind("integration_review", "T1") == INTEGRATION_REVIEW_KIND
    assert normalize_task_kind("work", "T1") is None
    assert normalize_task_kind(None, "T1") is None
    with pytest.raises(SystemExit) as excinfo:
        normalize_task_kind("sweep", "T1")
    # The rejection names the legal set rather than only the one it knew before.
    assert "review" in str(excinfo.value) and "integration_review" in str(excinfo.value)


def test_normalize_task_preserves_the_review_marker() -> None:
    from sprintengine_core.tool.tasks import normalize_task

    raw = task("T1", "Audit the seams", "developer")
    raw["kind"] = REVIEW_KIND
    assert normalize_task(raw).get("kind") == REVIEW_KIND


def test_both_review_kinds_are_review_tasks() -> None:
    assert is_review_task({"kind": REVIEW_KIND})
    assert is_review_task({"kind": INTEGRATION_REVIEW_KIND})
    assert not is_review_task({"kind": "work"})
    assert not is_review_task(None)


def test_a_review_task_does_not_itself_demand_review_coverage() -> None:
    """A review task audits work; counting it as work it must also audit would
    make every plan permanently uncovered."""
    state = base_state("s", [review_task("T1", [], kind=REVIEW_KIND)])
    # The review task has a `developer` role, which is implementation-producing
    # by role — the marker is what takes it out of the implementation set.
    assert review_planning_warnings(state) == []


# --- the plan gate ------------------------------------------------------------


def test_plan_with_implementation_and_no_review_task_warns() -> None:
    state = base_state("s", [task("T1", "Build the feature", "developer")])
    warnings = review_planning_warnings(state)
    assert len(warnings) == 1
    assert "review_tasks_missing" in warnings[0]
    # The warning has to say WHY, because the false belief is the root cause.
    assert "self-dispatch" in warnings[0]


def test_docs_only_plan_is_quiet() -> None:
    state = base_state("s", [task("T1", "Write the runbook", "docs")])
    assert review_planning_warnings(state) == []


def test_review_task_covering_the_work_is_quiet() -> None:
    state = base_state(
        "s",
        [
            task("T1", "Build the feature", "developer"),
            task("T2", "Build the surface", "frontend", depends_on=["T1"]),
            review_task("T3", depends_on=["T2"]),
        ],
    )
    assert review_planning_warnings(state) == []


def test_uncovered_implementation_task_warns_by_name() -> None:
    state = base_state(
        "s",
        [
            task("T1", "Build the feature", "developer"),
            task("T2", "Sidecar work nobody reviews", "developer"),
            review_task("T3", depends_on=["T1"]),
        ],
    )
    warnings = review_planning_warnings(state)
    assert len(warnings) == 1
    assert "review_coverage_incomplete" in warnings[0]
    assert "T2" in warnings[0]


def test_integration_review_alone_satisfies_the_review_expectation() -> None:
    """The seam review IS a review. A plan carrying only an integration check
    over all the work is engaged with the expectation, not silently short."""
    state = base_state(
        "s",
        [
            task("T1", "Build the feature", "developer"),
            review_task("T2", depends_on=["T1"], kind=INTEGRATION_REVIEW_KIND),
        ],
    )
    assert review_planning_warnings(state) == []


def test_canceled_review_task_does_not_count_as_planned_review() -> None:
    state = base_state(
        "s",
        [
            task("T1", "Build the feature", "developer"),
            review_task("T2", depends_on=["T1"], status="canceled"),
        ],
    )
    assert "review_tasks_missing" in review_planning_warnings(state)[0]


# --- MC-1820: the approver gets the acceptance text ---------------------------


def test_review_acceptance_is_surfaced_verbatim_for_the_approver() -> None:
    paper = review_task("T2", depends_on=["T1"], kind=INTEGRATION_REVIEW_KIND)
    paper["acceptanceCriteria"] = ["Confirm from evidence that the tasks integrated."]
    real = review_task("T3", depends_on=["T1"])
    real["acceptanceCriteria"] = ["New test exercises the ipc + preload + shared triple."]
    state = base_state("s", [task("T1", "Build", "developer"), paper, real])

    notices = review_acceptance_notices(state)
    assert [notice["taskId"] for notice in notices] == ["T2", "T3"]
    # Verbatim: the engine judges nothing here. "Confirm from evidence" reaches
    # the approver as written, which is the whole point — it was visible AT
    # PLANNING TIME on T15 and nobody was shown it.
    assert notices[0]["acceptance"] == ["Confirm from evidence that the tasks integrated."]
    assert notices[0]["kind"] == INTEGRATION_REVIEW_KIND
    assert notices[1]["acceptance"] == ["New test exercises the ipc + preload + shared triple."]


def test_plans_with_no_review_tasks_surface_no_acceptance_notices() -> None:
    state = base_state("s", [task("T1", "Build", "developer")])
    assert review_acceptance_notices(state) == []


# --- end to end through artifact approval -------------------------------------


def _seed_plan(fixture, tasks: list[dict], plan_body: str) -> dict:
    state = read_state(fixture.state_path)
    state.setdefault("sprintengine", {})["rosterConfigured"] = True
    state["configuredRoles"] = ["architect", "developer"]
    ensure_plan_approval_gate(state, fixture.state_path, "sprintengine", start_active=False)
    state.setdefault("tasks", []).extend(tasks)
    write_state(fixture.state_path, state)
    (fixture.team_dir / "plan.md").write_text(plan_body, encoding="utf-8")
    return read_state(fixture.state_path)


def test_plan_approval_reports_but_never_blocks(tmp_path) -> None:
    """The gate is advisory in every mode. Enforcement depth is the run's
    EXISTING approval mode — this call is the auto-approval path, and it
    approves. Autonomous means autonomous."""
    fixture = create_team(tmp_path, "review-gate-e2e", [])
    _seed_plan(
        fixture,
        [task("T5", "Build the feature", "developer", depends_on=["T0"])],
        "# Plan\n\nNo seam section here either.\n",
    )
    fixture.cli.run("artifact", "ready", "--artifact-id", "A1", "--id", "architect-1")
    approved = fixture.cli.run("artifact", "approve", "--artifact-id", "A1", "--id", "user")

    assert approved["ok"] is True
    assert approved["taskCompleted"] is True
    assert get_artifact(read_state(fixture.state_path), "A1")["status"] == "approved"

    joined = " ".join(approved["integrationWarnings"])
    assert "review_tasks_missing" in joined
    assert "plan_seam_section_missing" in joined


def test_an_engaged_plan_approves_quietly(tmp_path) -> None:
    fixture = create_team(tmp_path, "review-gate-quiet", [])
    reviewer = review_task("T6", depends_on=["T5"], kind=INTEGRATION_REVIEW_KIND)
    reviewer["acceptanceCriteria"] = ["New cross-module test covers T5's seam."]
    _seed_plan(
        fixture,
        [task("T5", "Build the feature", "developer", depends_on=["T0"]), reviewer],
        "# Plan\n\n## Seams\n\n- `src/main/foo.ts` — T5 owns it; nobody else writes it.\n",
    )
    fixture.cli.run("artifact", "ready", "--artifact-id", "A1", "--id", "architect-1")
    approved = fixture.cli.run("artifact", "approve", "--artifact-id", "A1", "--id", "user")

    assert approved["ok"] is True
    assert "integrationWarnings" not in approved
    # The acceptance still reaches the approver — that notice is not a warning,
    # it is the material the judgment needs.
    assert approved["reviewAcceptance"][0]["acceptance"] == ["New cross-module test covers T5's seam."]
