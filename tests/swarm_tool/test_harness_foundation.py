from __future__ import annotations

import pytest

from helpers import (
    REPO_ROOT,
    assert_artifact_status,
    assert_board_column,
    assert_disposable_state_path,
    assert_event_type,
    assert_feedback_record,
    assert_ready_tasks,
    assert_task_status,
    create_team,
    get_artifact,
    get_task,
    read_state,
    task,
)


def test_fixture_guard_rejects_real_repo_swarm_state() -> None:
    with pytest.raises(AssertionError, match="real repo swarm state"):
        assert_disposable_state_path(REPO_ROOT / "swarm" / "real-team" / "state.yaml")


def test_cli_runner_parses_json_and_asserts_ready_state(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "ready-state",
        [
            task("T1", "Approved prerequisite", "architect", "done"),
            task("T2", "Ready implementation", "developer", "todo", ["T1"]),
            task("T3", "Blocked validation", "tester", "todo", ["T2"]),
        ],
    )

    assert_ready_tasks(fixture.cli, "developer", ["T2"])
    before = read_state(fixture.state_path)
    assert_board_column(before, "T2", "ready")
    assert_board_column(before, "T3", "todo")

    payload = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-fixture")
    assert payload["ok"] is True
    assert payload["claimed"] is True
    assert payload["task"]["id"] == "T2"

    after = read_state(fixture.state_path)
    assert_task_status(after, "T2", "in_progress")
    assert_board_column(after, "T2", "in_progress")
    assert_event_type(after, "task_claimed")


def test_artifact_assertions_cover_ready_approval_history_and_events(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "artifact-flow",
        [task("T1", "Produce requirements", "product", "in_progress", owner="product-fixture")],
    )
    documents_dir = fixture.team_dir / "documents"
    documents_dir.mkdir()
    (documents_dir / "requirements.md").write_text("# Requirements\n", encoding="utf-8")

    add_payload = fixture.cli.run(
        "artifact",
        "add",
        "--actor",
        "product-fixture",
        "--artifact-id",
        "A1",
        "--task-id",
        "T1",
        "--kind",
        "requirements",
        "--title",
        "Requirements",
        "--path",
        "documents/requirements.md",
        "--created-by",
        "product-fixture",
        "--ready",
    )
    assert add_payload["ok"] is True

    ready_state = read_state(fixture.state_path)
    assert_task_status(ready_state, "T1", "needs_input")
    assert_artifact_status(ready_state, "A1", "ready_for_review")
    ready_artifact = get_artifact(ready_state, "A1")
    assert ready_artifact["fingerprint"]
    assert [entry["action"] for entry in ready_artifact["reviewHistory"]] == [
        "created",
        "ready_for_review",
    ]
    assert_event_type(ready_state, "artifact_added")
    assert get_task(ready_state, "T1")["ownerAgentId"] == "product-fixture"

    approve_payload = fixture.cli.run("artifact", "approve", "--artifact-id", "A1", "--id", "user")
    assert approve_payload["ok"] is True

    approved_state = read_state(fixture.state_path)
    assert_task_status(approved_state, "T1", "done")
    assert_artifact_status(approved_state, "A1", "approved")
    approved_artifact = get_artifact(approved_state, "A1")
    assert approved_artifact["reviewHistory"][-1]["action"] == "approved"
    assert_event_type(approved_state, "artifact_approved")


def test_feedback_assertions_cover_state_and_metrics_jsonl(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "feedback-flow",
        [task("T1", "Implement behavior", "developer", "in_progress", owner="developer-fixture")],
    )

    fixture.cli.run(
        "task",
        "log",
        "--task-id",
        "T1",
        "--id",
        "developer-fixture",
        "--summary",
        "Exercised feedback recording.",
        "--command",
        "pytest tests/swarm_tool",
        "--result",
        "Fixture passed",
    )
    done_payload = fixture.cli.run(
        "task",
        "status",
        "--task-id",
        "T1",
        "--status",
        "done",
        "--id",
        "developer-fixture",
        "--confidence-pct",
        "91",
        "--hallucination-risk-pct",
        "4",
        "--top-friction",
        "Fixture-only feedback path.",
    )
    assert done_payload["ok"] is True
    assert done_payload["feedbackRecorded"] is True

    state = read_state(fixture.state_path)
    assert_task_status(state, "T1", "done")
    assert state["tasks"][0]["feedback"]["scores"]["confidencePct"] == 91

    record = assert_feedback_record(fixture.team_dir, "T1", "developer-fixture")
    assert record["scores"]["confidence_pct"] == 91
    assert record["observed"]["commands_run_count"] == 1
