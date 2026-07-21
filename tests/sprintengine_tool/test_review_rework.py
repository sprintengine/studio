"""Reviewer findings form a closed rework and re-approval loop (MC-1741)."""
from __future__ import annotations

from pathlib import Path

import pytest

from helpers import create_team, get_task, read_state, task, write_state
from sprintengine_core.tool.artifacts import mark_task_done_if_artifacts_approved, resolve_task_input
from sprintengine_core.tool.state import assign_task, with_locked_state
from sprintengine_core.tool.task_reviews import (
    approve_cross_task_rework,
    request_task_changes,
)
from sprintengine_core.tool.tasks import advance_task, claim_phase_session, publish_task


def mutate(fixture, callback):
    return with_locked_state(fixture.state_path, lambda state: {"ok": True, **callback(state)})


def force_changed_publish(monkeypatch, fixture, task_id: str, actor: str):
    monkeypatch.setattr("sprintengine_core.tool.tasks.task_produced_changes", lambda *_args: True)
    return mutate(fixture, lambda state: {
        "result": publish_task(state, fixture.state_path, get_task(state, task_id), actor, "reworked")
    })["result"]


def test_independent_phase_reviewer_returns_to_same_requester(monkeypatch, tmp_path: Path) -> None:
    record = task("T1", "Implement", "developer", status="review", owner="reviewer-1")
    record.update({
        "lastImplementedByAgentId": "developer-1",
        "cli": "claude-code",
        "model": "fable",
    })
    unrelated = task("T2", "Unrelated work", "developer")
    fixture = create_team(tmp_path, "phase-rework", [record, unrelated])

    requested = mutate(fixture, lambda state: {
        "result": request_task_changes(
            state,
            fixture.state_path,
            get_task(state, "T1"),
            "reviewer-1",
            "Fix the boundary.",
        )
    })["result"]
    assert requested["request"]["cycle"] == 1
    reopened = read_state(fixture.state_path)["tasks"][0]
    assert reopened["status"] == "todo"
    assert reopened["preferredOwnerAgentId"] == "developer-1"
    assert reopened["ownerAgentId"] is None

    reserved = fixture.cli.run("task", "next", "--role", "developer", "--id", "reviewer-1")
    assert reserved["claimed"] is False
    assert reserved["reason"] == "review_reapproval_pending"

    mutate(fixture, lambda state: {"claim": assign_task(state, get_task(state, "T1"), "developer-1")})
    published = force_changed_publish(monkeypatch, fixture, "T1", "developer-1")
    assert published["nextStatus"] == "review"
    awaiting = read_state(fixture.state_path)["tasks"][0]["awaitingPhaseSession"]
    assert awaiting["agentId"] == "reviewer-1"
    assert awaiting["runtime"] == {"cli": "claude-code", "model": "fable"}

    with pytest.raises(SystemExit, match="phase_reviewer_mismatch"):
        mutate(fixture, lambda state: {"claim": claim_phase_session(state, get_task(state, "T1"), "reviewer-2")})
    mutate(fixture, lambda state: {"claim": claim_phase_session(state, get_task(state, "T1"), "reviewer-1")})
    mutate(fixture, lambda state: {
        "advance": advance_task(state, get_task(state, "T1"), "reviewer-1", "review", "pass", "Approved")
    })
    completed = read_state(fixture.state_path)["tasks"][0]
    assert completed["status"] == "done"
    assert "openReviewRequest" not in completed
    assert completed["comments"][0]["data"]["status"] == "resolved"


def test_cross_task_reviewer_keeps_one_lease_and_blocks_source_completion(monkeypatch, tmp_path: Path) -> None:
    target = task("T1", "Implement", "developer", status="done")
    target["lastImplementedByAgentId"] = "developer-1"
    source = task("T2", "Final review", "architect", status="in_progress", owner="architect-1", depends_on=["T1"])
    fixture = create_team(tmp_path, "cross-rework", [target, source])
    state = read_state(fixture.state_path)
    state["configuredRoles"] = ["architect", "developer"]
    write_state(fixture.state_path, state)

    mutate(fixture, lambda current: {
        "result": request_task_changes(
            current,
            fixture.state_path,
            get_task(current, "T1"),
            "architect-1",
            "Connect the consumer.",
            # The one active source is derived when sourceTaskId is omitted.
        )
    })
    current = read_state(fixture.state_path)
    assert get_task(current, "T2")["ownerAgentId"] == "architect-1"
    assert get_task(current, "T1")["ownerAgentId"] is None

    monkeypatch.setattr("sprintengine_core.tool.tasks.task_produced_changes", lambda *_args: False)
    with pytest.raises(SystemExit, match="open_outbound_review_request"):
        mutate(fixture, lambda current: {
            "result": publish_task(current, fixture.state_path, get_task(current, "T2"), "architect-1", "review done")
        })

    mutate(fixture, lambda current: {"claim": assign_task(current, get_task(current, "T1"), "developer-1")})
    force_changed_publish(monkeypatch, fixture, "T1", "developer-1")
    waiting = read_state(fixture.state_path)
    assert get_task(waiting, "T1")["status"] == "review"
    assert get_task(waiting, "T1")["ownerAgentId"] is None

    mutate(fixture, lambda current: {
        "approval": approve_cross_task_rework(
            current,
            get_task(current, "T1"),
            "architect-1",
            "T2",
            "The seam is now connected.",
        )
    })
    completed = read_state(fixture.state_path)
    assert get_task(completed, "T1")["status"] == "done"
    assert "openReviewRequest" not in get_task(completed, "T1")


def test_cross_task_request_rejects_unrelated_target(tmp_path: Path) -> None:
    target = task("T1", "Implement", "developer", status="done")
    source = task("T2", "Review", "architect", status="in_progress", owner="architect-1")
    fixture = create_team(tmp_path, "unrelated-rework", [target, source])
    state = read_state(fixture.state_path)
    state["configuredRoles"] = ["architect", "developer"]
    write_state(fixture.state_path, state)

    with pytest.raises(SystemExit, match="review_target_not_dependency"):
        mutate(fixture, lambda current: {
            "result": request_task_changes(
                current,
                fixture.state_path,
                get_task(current, "T1"),
                "architect-1",
                "Unrelated.",
                source_task_id="T2",
            )
        })


def test_request_changes_rejects_empty_feedback(tmp_path: Path) -> None:
    record = task("T1", "Implement", "developer", status="review", owner="reviewer-1")
    record.update({"lastImplementedByAgentId": "developer-1", "cli": "claude-code"})
    fixture = create_team(tmp_path, "empty-review-feedback", [record])

    with pytest.raises(SystemExit, match="review_feedback_required"):
        mutate(fixture, lambda state: {
            "result": request_task_changes(
                state,
                fixture.state_path,
                get_task(state, "T1"),
                "reviewer-1",
                "   ",
            )
        })


def test_fourth_phase_rejection_escalates_to_planner_triage(tmp_path: Path) -> None:
    record = task("T1", "Implement", "developer", status="review", owner="reviewer-1")
    record.update({
        "lastImplementedByAgentId": "developer-1",
        "cli": "claude-code",
        "model": "fable",
        "openReviewRequest": {
            "id": "RR1",
            "status": "awaiting_reapproval",
            "requestedByAgentId": "reviewer-1",
            "requestedByRole": "developer",
            "sourceTaskId": "T1",
            "implementationAgentId": "developer-1",
            "cycle": 3,
            "requestedAt": "2026-07-21T00:00:00Z",
            "reworkedAt": "2026-07-21T00:10:00Z",
            "feedbackCommentIds": [],
            "reviewerRuntime": {"cli": "claude-code", "model": "fable"},
        },
    })
    fixture = create_team(tmp_path, "phase-rework-cap", [record])

    result = mutate(fixture, lambda state: {
        "result": request_task_changes(
            state,
            fixture.state_path,
            get_task(state, "T1"),
            "reviewer-1",
            "Still incorrect.",
        )
    })["result"]
    assert result["status"] == "escalated"
    escalated = read_state(fixture.state_path)["tasks"][0]
    assert escalated["status"] == "needs_input"
    assert escalated["ownerAgentId"] == "reviewer-1"
    assert escalated["needsInput"]["kind"] == "architect"
    assert escalated["openReviewRequest"]["cycle"] == 4


def test_planner_explicitly_reassigns_lost_phase_reviewer(tmp_path: Path) -> None:
    record = task("T1", "Implement", "developer", status="review")
    record.update({
        "lastImplementedByAgentId": "developer-1",
        "openReviewRequest": {
            "id": "RR1",
            "status": "awaiting_reapproval",
            "requestedByAgentId": "reviewer-1",
            "requestedByRole": "developer",
            "sourceTaskId": "T1",
            "implementationAgentId": "developer-1",
            "cycle": 1,
            "requestedAt": "2026-07-21T00:00:00Z",
            "reworkedAt": "2026-07-21T00:10:00Z",
            "feedbackCommentIds": [],
            "reviewerRuntime": {"cli": "claude-code", "model": "fable"},
        },
        "awaitingPhaseSession": {
            "phase": "review",
            "runtime": {"cli": "claude-code", "model": "fable"},
            "agentId": "reviewer-1",
            "role": "developer",
        },
    })
    fixture = create_team(tmp_path, "reassign-phase-reviewer", [record])

    payload = fixture.cli.run(
        "task", "reassign-review",
        "--task-id", "T1",
        "--id", "architect",
        "--reviewer-id", "reviewer-2",
        "--reviewer-role", "developer",
        "--reason", "Original reviewer runtime cannot be restored.",
    )
    assert payload["ok"] is True
    state = read_state(fixture.state_path)
    updated = get_task(state, "T1")
    assert updated["openReviewRequest"]["requestedByAgentId"] == "reviewer-2"
    assert updated["awaitingPhaseSession"]["agentId"] == "reviewer-2"
    assert state["events"][-1]["type"] == "task_review_reassigned"

    mutate(fixture, lambda current: {"claim": claim_phase_session(current, get_task(current, "T1"), "reviewer-2")})
    mutate(fixture, lambda current: {
        "advance": advance_task(current, get_task(current, "T1"), "reviewer-2", "review", "pass", "Approved")
    })
    assert get_task(read_state(fixture.state_path), "T1")["status"] == "done"


def test_shared_completion_writers_reject_open_outbound_request(tmp_path: Path) -> None:
    target = task("T1", "Implement", "developer", status="todo")
    target["openReviewRequest"] = {
        "id": "RR1",
        "status": "rework",
        "requestedByAgentId": "architect-1",
        "requestedByRole": "architect",
        "sourceTaskId": "T2",
        "implementationAgentId": "developer-1",
        "cycle": 1,
        "requestedAt": "2026-07-21T00:00:00Z",
        "feedbackCommentIds": [],
    }
    source = task("T2", "Final review", "architect", status="needs_input", owner="architect-1", depends_on=["T1"])
    source["needsInput"] = {
        "kind": "architect",
        "reason": "artifact_review",
        "question": "Approve the review artifact.",
        "reportedBy": "architect-1",
        "reportedAt": "2026-07-21T00:00:00Z",
    }
    fixture = create_team(tmp_path, "completion-bypasses", [target, source])
    state = read_state(fixture.state_path)
    state["artifacts"] = [{
        "id": "A1",
        "kind": "report",
        "title": "Review report",
        "path": ".multi-code/sprintengine/completion-bypasses/evidence.md",
        "status": "approved",
        "createdBy": "architect-1",
        "taskId": "T2",
    }]

    with pytest.raises(SystemExit, match="open_outbound_review_request"):
        resolve_task_input(state, get_task(state, "T2"), "planner-1", "Close it.", complete=True)
    with pytest.raises(SystemExit, match="open_outbound_review_request"):
        mark_task_done_if_artifacts_approved(state, get_task(state, "T2"))

    assert get_task(state, "T2")["status"] == "needs_input"
