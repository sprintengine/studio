"""T9 cross-slice validation: the Sprint Inbox feature's data path.

No single slice test proves the slices *compose* in the one payload the renderer
actually consumes — the `build_projection` output. This test seeds a run the way
a backlog launch does and asserts a single projection carries, together:

  * source / sourceBundle (T2 projection of the T3 seed) → the "Started from" data;
  * an approved artifact's `approvalMode` (T5) → the T6 manual/policy glyph split;
  * a `recorded` artifact (T6) surfaced in the top-level artifacts list (the
    renderer's Evidence partition reads it) AND on `task.recordedArtifacts`.

Real paths only: the real `artifact approve --approval-mode` CLI and the real
`build_projection`; state is seeded directly the way the existing projection
tests do. The stuck-draft invariant (T7) and the honest-badge/glyph logic (T1/T6)
are proven in their own suites; this guards the seam between them.
"""
from __future__ import annotations

from pathlib import Path

from helpers import create_team, read_state, task, write_state
from sprintengine_core import store


SOURCE = {
    "kind": "markdown",
    "origin": "reference",
    "planKind": "epic",
    "path": "backlog/epics/auth-revamp.md",
    "capturedAt": "2026-07-05T00:00:00Z",
}
SOURCE_BUNDLE = [
    {"kind": "unknown", "origin": "reference", "path": "backlog/login.md", "capturedAt": "2026-07-05T00:00:00Z"},
    {"kind": "html_mockup", "origin": "reference", "path": "docs/flow.html", "capturedAt": "2026-07-05T00:00:00Z"},
]


def _write_file(fixture, relative_path: str) -> None:
    path = fixture.team_dir / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("# Seed\n", encoding="utf-8")


def _projected_artifact(projection: dict, artifact_id: str) -> dict:
    for artifact in projection["artifacts"]:
        if artifact.get("id") == artifact_id:
            return artifact
    raise AssertionError(f"artifact {artifact_id} missing from the projected artifacts list")


def _projected_task(projection: dict, task_id: str) -> dict:
    for projected in projection["tasks"]:
        if projected.get("id") == task_id:
            return projected
    raise AssertionError(f"task {task_id} missing from the projection")


def test_inbox_projection_composes_source_approval_mode_and_recorded_evidence(tmp_path: Path) -> None:
    fixture = create_team(
        tmp_path,
        "inbox-cross-slice",
        [task("T1", "Ship auth", "developer", "needs_input", owner="developer-fixture")],
    )
    _write_file(fixture, "review.md")
    _write_file(fixture, "legacy.md")
    _write_file(fixture, "validation.md")

    state = read_state(fixture.state_path)
    # The seed the backlog launch persisted (T3) — projected by T2.
    state["source"] = SOURCE
    state["sourceBundle"] = SOURCE_BUNDLE
    state["artifacts"] = [
        # Awaiting approval; CLI-approved below with an explicit approvalMode (T5).
        {
            "id": "A1",
            "kind": "code_review",
            "title": "Policy review",
            "path": "review.md",
            "status": "ready_for_review",
            "createdBy": "reviewer-fixture",
            "taskId": "T1",
            "reviewHistory": [],
            "recommendedTasks": [],
        },
        # A legacy approval with no approvalMode — must project as plain approved
        # (T6 renders it as the filled/manual tick).
        {
            "id": "A2",
            "kind": "design_notes",
            "title": "Legacy approval",
            "path": "legacy.md",
            "status": "approved",
            "createdBy": "reviewer-fixture",
            "taskId": "T1",
            "reviewHistory": [{"action": "approved", "actor": "user", "timestamp": "2026-07-05T00:00:00Z"}],
            "recommendedTasks": [],
        },
        # Recorded evidence — must not be dropped and must not read as a draft.
        {
            "id": "A3",
            "kind": "validation_report",
            "title": "Tester validation",
            "path": "validation.md",
            "status": "recorded",
            "createdBy": "tester-fixture",
            "taskId": "T1",
            "gateId": "tester",
            "reviewHistory": [{"action": "recorded", "actor": "tester-fixture", "timestamp": "2026-07-05T00:00:00Z"}],
            "recommendedTasks": [],
        },
    ]
    write_state(fixture.state_path, state)

    # Real approve path (T5): auto-run policy provenance.
    fixture.cli.run("artifact", "approve", "--artifact-id", "A1", "--id", "user", "--approval-mode", "policy")

    projection = store.build_projection(fixture.state_path.parent, state_path=fixture.state_path)

    # "Started from" data (T2/T3): the seed rides the run payload.
    assert projection["run"]["source"] == SOURCE
    assert projection["run"]["sourceBundle"] == SOURCE_BUNDLE

    # Approval provenance (T5) survives into the payload the renderer normalizes,
    # so T6 can split the glyph. Policy on A1; legacy/absent on A2.
    assert _projected_artifact(projection, "A1")["status"] == "approved"
    assert _projected_artifact(projection, "A1")["approvalMode"] == "policy"
    assert "approvalMode" not in _projected_artifact(projection, "A2")

    # Recorded evidence (T6): present in the top-level artifacts list with its real
    # status (the renderer's Evidence partition + honest badge read this), never
    # dropped, never a draft.
    recorded = _projected_artifact(projection, "A3")
    assert recorded["status"] == "recorded"
    assert recorded["kind"] == "validation_report"

    # And it is also projected onto the owning task's recordedArtifacts.
    projected_task = _projected_task(projection, "T1")
    assert "A3" in [item.get("id") for item in projected_task.get("recordedArtifacts", [])]
    # A recorded artifact is not approval-blocking, so no draft placeholder is
    # implied by its presence.
    assert all(a["status"] != "draft" for a in projection["artifacts"])
