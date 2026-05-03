from __future__ import annotations

from copy import deepcopy
from pathlib import Path

import pytest

from multiloop_core.state import StateValidationError, validate_state
from tests.multiloop_tool.test_m1_cli import MultiloopCli, read_state, write_state
from tests.multiloop_tool.test_m4_review_bundle import m4_verdict_state


def m4_revision_state() -> dict:
    state = m4_verdict_state()
    state["roadmap"].append(
        {
            "id": "M3",
            "title": "Future renderer integration",
            "status": "planned",
            "goal": "Expose Multiloop review output in the app later.",
            "entryCriteria": ["CLI review bundle is accepted."],
            "acceptanceCriteria": ["Renderer can inspect review output."],
            "finalGoalContribution": "Makes the proven CLI workflow visible.",
            "learnedFacts": [],
            "blockers": [],
            "reviewVerdicts": [],
        }
    )
    return state


def test_roadmap_revise_updates_planned_future_milestone_with_visible_rationale(tmp_path: Path) -> None:
    state_path = tmp_path / "multiloop" / "m4" / "state.json"
    write_state(state_path, m4_revision_state())
    before = read_state(state_path)
    accepted_milestone_before = deepcopy(before["roadmap"][0])
    accepted_task_before = deepcopy(before["tasks"][0])
    cli = MultiloopCli(tmp_path, state_path)

    revised = cli.run(
        "roadmap",
        "revise",
        "M3",
        "--title",
        "Review-informed renderer integration",
        "--goal",
        "Expose approved review bundle output in the app after CLI validation.",
        "--entry-criterion",
        "M4 review bundle is accepted.",
        "--acceptance-criterion",
        "Renderer surfaces compact read-only review context.",
        "--final-goal-contribution",
        "Makes review learning visible without editing accepted history.",
        "--learned-fact",
        "Reviewers need read-only bundle context before UI work.",
        "--rationale",
        "Product review narrowed renderer scope after M4 evidence.",
        "--id",
        "developer-t12",
    )
    roadmap = cli.run("roadmap", "show").stdout
    milestone = cli.run("milestone", "show", "M3").stdout

    assert "Revised milestone: M3 [planned]: Review-informed renderer integration" in revised.stdout
    assert "Revision: R1 - Product review narrowed renderer scope after M4 evidence." in revised.stdout
    assert "Latest revision: R1 - Product review narrowed renderer scope after M4 evidence." in roadmap
    assert "Review-informed renderer integration" in roadmap
    assert "Revisions:" in milestone
    assert "Updated acceptance criteria." in milestone
    assert "Reviewers need read-only bundle context before UI work." in milestone
    after = read_state(state_path)
    assert after["roadmap"][0] == accepted_milestone_before
    assert after["tasks"][0] == accepted_task_before
    assert after["roadmap"][2]["revisions"] == [
        {
            "id": "R1",
            "rationale": "Product review narrowed renderer scope after M4 evidence.",
            "changes": [
                "Updated title.",
                "Updated goal.",
                "Updated final-goal contribution.",
                "Updated entry criteria.",
                "Updated acceptance criteria.",
                "Added learned fact: Reviewers need read-only bundle context before UI work.",
            ],
            "createdAt": after["roadmap"][2]["revisions"][0]["createdAt"],
            "revisedBy": "developer-t12",
        }
    ]


def test_roadmap_revise_rejects_accepted_milestones_and_noop_revisions(tmp_path: Path) -> None:
    state_path = tmp_path / "multiloop" / "m4" / "state.json"
    state = m4_revision_state()
    write_state(state_path, state)
    before = read_state(state_path)
    cli = MultiloopCli(tmp_path, state_path)

    accepted = cli.run_failure(
        "roadmap",
        "revise",
        "M1",
        "--goal",
        "Rewrite accepted history.",
        "--rationale",
        "Should be rejected.",
    )
    noop = cli.run_failure(
        "roadmap",
        "revise",
        "M3",
        "--rationale",
        "No fields were provided.",
    )

    assert "Cannot revise accepted milestone: M1" in accepted.stderr
    assert "At least one roadmap field or --learned-fact is required." in noop.stderr
    assert read_state(state_path) == before


def test_roadmap_revise_rejects_active_current_milestone_scope(tmp_path: Path) -> None:
    state_path = tmp_path / "multiloop" / "m4" / "state.json"
    write_state(state_path, m4_revision_state())
    before = read_state(state_path)
    cli = MultiloopCli(tmp_path, state_path)

    result = cli.run_failure(
        "roadmap",
        "revise",
        "M2",
        "--goal",
        "Rewrite active milestone scope.",
        "--rationale",
        "Active milestone scope changes need normal milestone work, not roadmap revision.",
    )

    assert "Can only revise planned or blocked milestones; M2 is active" in result.stderr
    assert read_state(state_path) == before


def test_roadmap_revise_supports_blocked_revise_scope_review_flow(tmp_path: Path) -> None:
    state_path = tmp_path / "multiloop" / "m4" / "state.json"
    state = m4_revision_state()
    state["loop"]["status"] = "blocked"
    state["roadmap"][1]["status"] = "blocked"
    state["roadmap"][1]["reviewVerdicts"] = [
        {
            "id": "V1",
            "role": "product",
            "createdBy": "product-1",
            "verdict": "revise_scope",
            "evidence": ["Current M4 evidence shows renderer work should wait."],
            "blockers": ["Renderer scope is premature."],
            "finalGoalImplications": ["Final goal is better served by delaying UI integration."],
            "nextRecommendation": "Revise M3 before accepting M4.",
            "createdAt": "2026-01-02T00:00:00Z",
        }
    ]
    write_state(state_path, state)
    cli = MultiloopCli(tmp_path, state_path)

    revised = cli.run(
        "roadmap",
        "revise",
        "M3",
        "--learned-fact",
        "revise_scope verdict V1 deferred renderer work.",
        "--rationale",
        "Blocked M4 review verdict requires future roadmap scope change.",
    )
    after = read_state(state_path)

    assert "Revised milestone: M3 [planned]: Future renderer integration" in revised.stdout
    assert after["roadmap"][1]["status"] == "blocked"
    assert after["roadmap"][1]["reviewVerdicts"][0]["verdict"] == "revise_scope"
    assert after["roadmap"][2]["learnedFacts"] == ["revise_scope verdict V1 deferred renderer work."]
    assert after["roadmap"][2]["revisions"][0]["rationale"] == "Blocked M4 review verdict requires future roadmap scope change."


def test_state_validation_rejects_malformed_roadmap_revision_records() -> None:
    state = m4_revision_state()
    state["roadmap"][2]["revisions"] = [
        {
            "id": "R1",
            "rationale": "Review learning changed future scope.",
            "changes": ["Updated goal."],
            "createdAt": "2026-01-02T00:00:00Z",
        }
    ]
    validate_state(state)

    empty_changes = deepcopy(state)
    empty_changes["roadmap"][2]["revisions"][0]["changes"] = []
    with pytest.raises(
        StateValidationError,
        match=r"\$\.roadmap\[2\]\.revisions\[0\]\.changes: expected at least one item",
    ):
        validate_state(empty_changes)

    missing_rationale = deepcopy(state)
    del missing_rationale["roadmap"][2]["revisions"][0]["rationale"]
    with pytest.raises(
        StateValidationError,
        match=r"\$\.roadmap\[2\]\.revisions\[0\]\.rationale: missing required field",
    ):
        validate_state(missing_rationale)
