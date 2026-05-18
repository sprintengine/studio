from __future__ import annotations

import os

from fixtures import (
    SwarmCli,
    artifact_by_kind,
    assert_board_column,
    assert_event_type,
    assert_ready_tasks,
    assert_task_status,
    create_team,
    get_task,
    read_state,
    task,
    task_ids_by_status,
    write_state,
)
from sprintengine_core.tool import runner_watch_delay_seconds


FIXED_MTIME_NS = 1_700_000_000_000_000_000


def run_without_state_rewrite(fixture, *args: str) -> dict:
    os.utime(fixture.state_path, ns=(FIXED_MTIME_NS, FIXED_MTIME_NS))
    before_bytes = fixture.state_path.read_bytes()
    before_mtime_ns = fixture.state_path.stat().st_mtime_ns

    payload = fixture.cli.run(*args)

    assert fixture.state_path.read_bytes() == before_bytes
    assert fixture.state_path.stat().st_mtime_ns == before_mtime_ns
    return payload


def test_ready_column_is_derived_from_todo_tasks_with_satisfied_dependencies(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "derived-ready-state",
        [
            task("T1", "Approved gate", "architect", "done"),
            task("T2", "Implementation ready by dependency", "developer", "todo", ["T1"]),
            task("T3", "Validation blocked by implementation", "tester", "todo", ["T2"]),
        ],
    )

    assert_ready_tasks(fixture.cli, "developer", ["T2"])
    state = read_state(fixture.state_path)
    assert get_task(state, "T2")["status"] == "todo"
    assert task_ids_by_status(state, "ready") == []
    assert_board_column(state, "T2", "ready")
    assert_board_column(state, "T3", "todo")


def test_manual_dispatch_task_is_not_ready_until_marked_ready(tmp_path) -> None:
    manual_task = task("T1", "Imported issue awaiting triage", "developer")
    manual_task["dispatch"] = {"mode": "manual", "status": "todo", "triagedBy": "none"}
    fixture = create_team(tmp_path, "manual-dispatch-todo", [manual_task])

    next_payload = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-fixture")

    assert next_payload["claimed"] is False
    assert next_payload["reason"] == "no_ready_task"
    state = read_state(fixture.state_path)
    assert_task_status(state, "T1", "todo")
    assert_board_column(state, "T1", "todo")
    assert_ready_tasks(fixture.cli, "developer", [])


def test_task_ready_moves_manual_dispatch_task_to_ready(tmp_path) -> None:
    manual_task = task("T1", "Imported issue approved by user", "developer")
    manual_task["dispatch"] = {"mode": "manual", "status": "todo", "triagedBy": "none"}
    manual_task["source"] = {
        "type": "github",
        "externalId": "123",
        "externalUrl": "https://github.com/example/repo/issues/123",
        "repo": "example/repo",
        "title": "Remote issue title",
        "externalUpdatedAt": "2026-05-07T12:00:00Z",
        "syncedAt": "2026-05-07T12:01:00Z",
        "syncStatus": "clean",
    }
    fixture = create_team(tmp_path, "manual-dispatch-ready-command", [manual_task])

    payload = fixture.cli.run("task", "ready", "--task-id", "T1", "--id", "user")

    assert payload["ok"] is True
    assert payload["task"]["dispatch"]["status"] == "ready"
    assert payload["task"]["dispatch"]["triagedBy"] == "user"
    assert isinstance(payload["task"]["dispatch"]["readyAt"], str)
    assert payload["task"]["source"]["externalId"] == "123"
    assert payload["event"]["type"] == "task_dispatch_ready"
    state = read_state(fixture.state_path)
    assert_board_column(state, "T1", "ready")
    assert_ready_tasks(fixture.cli, "developer", ["T1"])


def test_task_ready_rejects_dependency_dispatched_task(tmp_path) -> None:
    fixture = create_team(tmp_path, "dependency-dispatch-ready-rejected", [
        task("T1", "Dependency-ready task", "developer"),
    ])

    rejected = fixture.cli.run("task", "ready", "--task-id", "T1", "--id", "user")

    assert rejected["ok"] is False
    assert rejected["error"] == "Task does not use manual dispatch."
    state = read_state(fixture.state_path)
    assert "dispatch" not in get_task(state, "T1")


def test_task_status_needs_input_records_routing_metadata_and_triage_prompt(tmp_path) -> None:
    fixture = create_team(tmp_path, "needs-input-routing", [
        task("T1", "Fix stale task card", "frontend", "in_progress", owner="frontend-1"),
    ])

    payload = fixture.cli.run(
        "task",
        "status",
        "--task-id",
        "T1",
        "--status",
        "needs_input",
        "--id",
        "frontend-1",
        "--needs-input-kind",
        "architect",
        "--needs-input-question",
        "Task card points at a file that no longer exists.",
        "--needs-input-suggested-resolution",
        "Architect should update ownedPaths and acceptance criteria.",
    )

    assert payload["ok"] is True
    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert task_record["needsInput"]["kind"] == "architect"
    assert task_record["needsInput"]["question"] == "Task card points at a file that no longer exists."
    assert task_record["needsInput"]["suggestedResolution"] == "Architect should update ownedPaths and acceptance criteria."
    assert task_record["needsInput"]["reportedBy"] == "frontend-1"

    triage = fixture.cli.run("triage", "needs-input", "--id", "architect")
    assert triage["ok"] is True
    assert [entry["id"] for entry in triage["tasks"]] == ["T1"]
    assert "Task card points at a file that no longer exists." in triage["prompt"]
    assert "sprintengine plan update-task --force" in triage["prompt"]


def test_task_status_needs_input_records_reason_and_artifact_id(tmp_path) -> None:
    fixture = create_team(tmp_path, "needs-input-artifact-review-routing", [
        task("T1", "Review phase output", "code_reviewer", "in_progress", owner="code_reviewer"),
    ])

    payload = fixture.cli.run(
        "task",
        "status",
        "--task-id",
        "T1",
        "--status",
        "needs_input",
        "--id",
        "code_reviewer",
        "--needs-input-kind",
        "architect",
        "--needs-input-reason",
        "artifact_review",
        "--needs-input-artifact-id",
        "A6",
        "--needs-input-question",
        "Code review artifact A6 has recommended follow-up tasks.",
    )

    assert payload["ok"] is True
    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert task_record["needsInput"]["kind"] == "architect"
    assert task_record["needsInput"]["reason"] == "artifact_review"
    assert task_record["needsInput"]["artifactId"] == "A6"

    triage = fixture.cli.run("triage", "needs-input", "--id", "architect")
    assert [entry["id"] for entry in triage["tasks"]] == ["T1"]
    assert "artifact_review" in triage["prompt"]
    assert "A6" in triage["prompt"]


def test_artifact_review_needs_input_routes_to_architect_triage(tmp_path) -> None:
    blocked_task = task("T1", "Review artifact", "code_reviewer", "needs_input", owner="code_reviewer")
    blocked_task["needsInput"] = {
        "kind": "architect",
        "reason": "artifact_review",
        "question": "Artifact A6 is ready for review.",
        "reportedBy": "code_reviewer",
        "reportedAt": "2026-05-14T00:00:00Z",
    }
    fixture = create_team(tmp_path, "artifact-review-routes-to-architect", [blocked_task])

    triage = fixture.cli.run("triage", "needs-input", "--id", "architect")

    assert [entry["id"] for entry in triage["tasks"]] == ["T1"]
    assert triage["tasks"][0]["needsInput"]["kind"] == "architect"
    assert triage["tasks"][0]["needsInput"]["reason"] == "artifact_review"
    assert "artifact_review" in triage["prompt"]


def test_task_status_rejects_needs_input_fields_for_other_statuses(tmp_path) -> None:
    fixture = create_team(tmp_path, "needs-input-field-rejection", [
        task("T1", "Normal task", "developer", "in_progress", owner="developer-1"),
    ])

    rejected = fixture.cli.run_failure(
        "task",
        "status",
        "--task-id",
        "T1",
        "--status",
        "done",
        "--id",
        "developer-1",
        "--needs-input-kind",
        "architect",
    )

    assert "Needs-input fields are only supported with --status needs_input" in rejected.stderr


def gated_task(status: str = "in_progress", owner: str | None = "developer-fixture") -> dict:
    record = task("T1", "Gated implementation", "developer", status, owner=owner)
    record["qualityGates"] = [
        {
            "id": "code-review",
            "phase": "review",
            "role": "code_reviewer",
            "status": "pending",
            "required": True,
            "allowSelfReview": False,
            "focus": "Review implementation.",
            "attempts": [],
        },
        {
            "id": "test",
            "phase": "testing",
            "role": "tester",
            "status": "pending",
            "required": True,
            "allowSelfReview": False,
            "focus": "Validate behavior.",
            "attempts": [],
        },
    ]
    return record


def test_task_publish_requires_summary_before_leaving_in_progress(tmp_path) -> None:
    fixture = create_team(tmp_path, "publish-summary-required", [gated_task()])

    rejected = fixture.cli.run_failure(
        "task",
        "publish",
        "--task-id",
        "T1",
        "--id",
        "developer-fixture",
        "--summary",
        " ",
    )

    assert "Task comment body cannot be empty" in rejected.stderr
    state = read_state(fixture.state_path)
    assert_task_status(state, "T1", "in_progress")


def test_task_publish_records_implementation_summary_and_routes_to_next_phase(tmp_path) -> None:
    fixture = create_team(tmp_path, "publish-routes-review", [gated_task()])

    payload = fixture.cli.run(
        "task",
        "publish",
        "--task-id",
        "T1",
        "--id",
        "developer-fixture",
        "--summary",
        "Implemented the backend path.",
        "--path",
        "sprintengine_core/tool.py",
    )

    assert payload["nextStatus"] == "review"
    assert payload["comment"]["type"] == "implementation_summary"
    assert payload["comment"]["id"] == "C1"
    assert payload["comment"]["authorAgentId"] == "developer-fixture"
    assert payload["comment"]["authorRole"] == "developer"
    assert payload["comment"]["paths"] == ["sprintengine_core/tool.py"]
    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert task_record["status"] == "review"
    assert task_record["completedAt"] is None
    assert task_record["comments"][0]["body"] == "Implemented the backend path."


def test_task_publish_persists_structured_summary_data(tmp_path) -> None:
    fixture = create_team(tmp_path, "publish-summary-data", [gated_task()])

    payload = fixture.cli.run(
        "task",
        "publish",
        "--task-id",
        "T1",
        "--id",
        "developer-fixture",
        "--summary",
        "Implemented the backend path.",
        "--summary-data-json",
        '{"changedContracts":[{"name":"task lifecycle"}],"verification":[{"command":"pytest","result":"passed"}],"reviewerFocus":["routing"]}',
    )

    assert payload["comment"]["type"] == "implementation_summary"
    assert payload["comment"]["data"]["changedContracts"][0]["name"] == "task lifecycle"
    assert payload["comment"]["data"]["verification"][0]["result"] == "passed"
    assert payload["comment"]["data"]["reviewerFocus"] == ["routing"]


def test_task_publish_skips_missing_phase_gates_and_can_complete(tmp_path) -> None:
    record = gated_task()
    record["qualityGates"] = [
        {
            "id": "test",
            "phase": "testing",
            "role": "tester",
            "status": "pending",
            "required": True,
            "allowSelfReview": False,
            "focus": "Validate behavior.",
            "attempts": [],
        }
    ]
    fixture = create_team(tmp_path, "publish-skips-review", [record])

    first = fixture.cli.run("task", "publish", "--task-id", "T1", "--id", "developer-fixture", "--summary", "Ready for testing.")
    state = read_state(fixture.state_path)
    get_task(state, "T1")["qualityGates"][0]["status"] = "approved"
    get_task(state, "T1")["status"] = "in_progress"
    write_state(fixture.state_path, state)
    second = fixture.cli.run("task", "publish", "--task-id", "T1", "--id", "developer-fixture", "--summary", "Testing passed.")

    assert first["nextStatus"] == "testing"
    assert second["nextStatus"] == "done"
    final_state = read_state(fixture.state_path)
    assert_task_status(final_state, "T1", "done")
    assert get_task(final_state, "T1")["completedAt"]


def test_rework_publish_records_response_and_resets_required_gates(tmp_path) -> None:
    record = gated_task("changes_requested", owner="developer-fixture")
    record["qualityGates"][0]["status"] = "changes_requested"
    record["qualityGates"][1]["status"] = "approved"
    record["comments"] = [
        {
            "id": "C1",
            "type": "review_feedback",
            "actor": "code-reviewer",
            "authorAgentId": "code-reviewer",
            "authorRole": "code_reviewer",
            "source": "agent",
            "body": "Fix validation.",
            "createdAt": "2026-05-17T00:00:00Z",
            "data": {"status": "open"},
        }
    ]
    fixture = create_team(tmp_path, "publish-rework-response", [record])

    payload = fixture.cli.run(
        "task",
        "publish",
        "--task-id",
        "T1",
        "--id",
        "developer-fixture",
        "--summary",
        "Addressed the validation feedback.",
    )

    assert payload["nextStatus"] == "review"
    assert payload["comment"]["type"] == "implementation_response"
    assert payload["comment"]["data"]["feedbackCommentIds"] == ["C1"]
    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert [gate["status"] for gate in task_record["qualityGates"]] == ["pending", "pending"]


def test_republish_after_blocked_needs_input_resets_prior_gate_verdicts(tmp_path) -> None:
    record = gated_task("in_progress", owner="developer-fixture")
    record["qualityGates"][0]["status"] = "approved"
    record["qualityGates"][0]["attempts"] = [
        {
            "id": "GA-001",
            "status": "approved",
            "role": "code_reviewer",
            "claimedBy": "code-reviewer",
            "startedAt": "2026-05-17T00:00:00Z",
            "completedAt": "2026-05-17T00:01:00Z",
            "summary": "Approved before later rework.",
        }
    ]
    record["qualityGates"][1]["id"] = "spec-review"
    record["qualityGates"][1]["phase"] = "review"
    record["qualityGates"][1]["role"] = "spec_reviewer"
    record["qualityGates"][1]["status"] = "blocked"
    record["qualityGates"][1]["attempts"] = [
        {
            "id": "GA-001",
            "status": "blocked",
            "role": "spec_reviewer",
            "claimedBy": "spec-reviewer",
            "startedAt": "2026-05-17T00:02:00Z",
            "completedAt": "2026-05-17T00:03:00Z",
            "summary": "Blocked on architect scope.",
        }
    ]
    record["comments"] = [
        {
            "id": "C1",
            "type": "needs_input",
            "actor": "spec-reviewer",
            "authorAgentId": "spec-reviewer",
            "authorRole": "spec_reviewer",
            "source": "agent",
            "body": "Blocked on architect scope.",
            "createdAt": "2026-05-17T00:03:00Z",
            "data": {"gateId": "spec-review", "verdict": "blocked"},
        }
    ]
    fixture = create_team(tmp_path, "publish-after-blocked-needs-input", [record])

    payload = fixture.cli.run(
        "task",
        "publish",
        "--task-id",
        "T1",
        "--id",
        "developer-fixture",
        "--summary",
        "Addressed architect scope resolution.",
    )

    assert payload["nextStatus"] == "review"
    assert payload["comment"]["type"] == "implementation_response"
    assert payload["comment"]["data"]["feedbackCommentIds"] == ["C1"]
    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert [gate["status"] for gate in task_record["qualityGates"]] == ["pending", "pending"]
    assert_task_status(state, "T1", "review")


def test_runner_set_persists_policy_and_projection(tmp_path) -> None:
    fixture = create_team(tmp_path, "runner-policy", [task("T1", "Implement", "developer")])

    payload = fixture.cli.run("runner", "set", "--mode", "auto", "--poll-interval-seconds", "2", "--idle-backoff-seconds", "3")

    assert payload["runner"]["mode"] == "auto"
    assert payload["runner"]["pollIntervalSeconds"] == 2
    state = read_state(fixture.state_path)
    assert state["runner"]["mode"] == "auto"
    projection = fixture.cli.run("projection")
    assert projection["run"]["runner"]["mode"] == "auto"

    off_payload = fixture.cli.run("runner", "set", "--mode", "off")
    assert off_payload["runner"]["mode"] == "off"
    assert read_state(fixture.state_path)["runner"]["mode"] == "off"


def test_runner_watch_delay_progressively_caps() -> None:
    policy = {"pollIntervalSeconds": 2, "idleBackoffSeconds": 3, "maxBackoffSeconds": 10}

    assert [runner_watch_delay_seconds(policy, attempts) for attempts in range(1, 6)] == [2, 3, 6, 10, 10]


def test_join_watch_returns_idle_when_auto_mode_is_off_without_work(tmp_path) -> None:
    fixture = create_team(tmp_path, "join-watch-auto-off-idle", [task("T1", "Frontend work", "frontend", "todo")])

    payload = fixture.cli.run("join", "--role", "developer", "--id", "developer-1", "--watch", "--max-wait-seconds", "0")

    assert payload["action"] == "idle"
    assert payload["runner"]["mode"] == "off"
    assert "Auto Mode is off" in payload["message"]


def test_join_watch_returns_ready_gate_before_normal_task(tmp_path) -> None:
    review_task = gated_task("review", owner="developer-fixture")
    review_task["qualityGates"][0]["id"] = "spec-review"
    review_task["qualityGates"][0]["role"] = "spec_reviewer"
    normal_task = task("T2", "Spec reviewer normal task", "spec_reviewer")
    fixture = create_team(tmp_path, "join-watch-gate-first", [review_task, normal_task])
    fixture.cli.run("runner", "set", "--mode", "auto")

    payload = fixture.cli.run("join", "--role", "spec_reviewer", "--id", "spec_reviewer", "--watch", "--max-wait-seconds", "0")

    assert payload["action"] == "gate_work"
    assert payload["gate"]["role"] == "spec_reviewer"
    assert payload["task"]["id"] == "T1"


def test_join_watch_routes_architect_needs_input_before_ready_task(tmp_path) -> None:
    blocked = task("T1", "Needs architect decision", "developer", "needs_input", owner="developer-1")
    blocked["needsInput"] = {
        "kind": "architect",
        "reason": "task_scope",
        "question": "Should this task own the shared contract?",
    }
    ready_architect = task("T2", "Architect normal task", "architect")
    fixture = create_team(tmp_path, "join-watch-architect-triage", [blocked, ready_architect])
    fixture.cli.run("runner", "set", "--mode", "auto")

    payload = fixture.cli.run("join", "--role", "architect", "--id", "architect", "--watch", "--max-wait-seconds", "0")

    assert payload["action"] == "needs_input_triage"
    assert "triage needs-input" in payload["prompt"]


def test_task_status_done_rejects_open_required_quality_gates(tmp_path) -> None:
    for gate_status in ["pending", "in_progress", "changes_requested", "blocked"]:
        record = gated_task()
        record["qualityGates"][0]["status"] = gate_status
        if gate_status == "in_progress":
            record["qualityGates"][0]["attempts"] = [
                {"id": "GA-001", "status": "in_progress", "role": "code_reviewer", "claimedBy": "code-reviewer"}
            ]
        fixture = create_team(tmp_path, f"done-rejects-{gate_status.replace('_', '-')}", [record])
        state = read_state(fixture.state_path)
        state["sprintengine"]["rosterConfigured"] = True
        write_state(fixture.state_path, state)

        rejected = fixture.cli.run_failure(
            "task",
            "status",
            "--task-id",
            "T1",
            "--status",
            "done",
            "--id",
            "developer-fixture",
        )

        assert "Cannot mark task done while required quality gates remain open" in rejected.stderr
        assert f"code-review:{gate_status}" in rejected.stderr
        state = read_state(fixture.state_path)
        task_record = get_task(state, "T1")
        assert task_record["status"] == "in_progress"
        assert task_record["completedAt"] is None
        assert task_record["ownerAgentId"] == "developer-fixture"
        assert task_record["qualityGates"][0]["status"] == gate_status


def test_task_status_done_rejects_explicit_gates_without_roster_configured(tmp_path) -> None:
    fixture = create_team(tmp_path, "done-rejects-explicit-gate-unrostered", [gated_task()])

    rejected = fixture.cli.run_failure(
        "task",
        "status",
        "--task-id",
        "T1",
        "--status",
        "done",
        "--id",
        "developer-fixture",
    )

    assert "Cannot mark task done while required quality gates remain open" in rejected.stderr
    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert task_record["status"] == "in_progress"
    assert task_record["completedAt"] is None


def test_task_status_done_allows_legacy_and_closed_gate_tasks(tmp_path) -> None:
    legacy = task("T1", "Legacy task", "developer", "in_progress", owner="developer-fixture")
    fixture = create_team(tmp_path, "done-allows-legacy", [legacy])

    payload = fixture.cli.run("task", "status", "--task-id", "T1", "--status", "done", "--id", "developer-fixture")

    assert payload["ok"] is True
    state = read_state(fixture.state_path)
    assert_task_status(state, "T1", "done")

    closed = gated_task(owner="developer-fixture")
    closed["qualityGates"][0]["status"] = "approved"
    closed["qualityGates"][1]["status"] = "skipped"
    fixture = create_team(tmp_path, "done-allows-closed-gates", [closed])

    payload = fixture.cli.run("task", "status", "--task-id", "T1", "--status", "done", "--id", "developer-fixture")

    assert payload["ok"] is True
    state = read_state(fixture.state_path)
    assert_task_status(state, "T1", "done")


def test_artifact_approval_does_not_bypass_open_quality_gates(tmp_path) -> None:
    record = gated_task(owner="developer-fixture")
    fixture = create_team(tmp_path, "artifact-approval-open-gates", [record])
    artifact_path = fixture.team_dir / "reviews" / "handoff.md"
    artifact_path.parent.mkdir(parents=True, exist_ok=True)
    artifact_path.write_text("# Handoff\n", encoding="utf-8")

    fixture.cli.run(
        "artifact",
        "add",
        "--actor",
        "developer-fixture",
        "--artifact-id",
        "A1",
        "--task-id",
        "T1",
        "--kind",
        "code_review",
        "--title",
        "Handoff",
        "--path",
        "reviews/handoff.md",
        "--created-by",
        "developer-fixture",
        "--ready",
    )
    approved = fixture.cli.run("artifact", "approve", "--artifact-id", "A1", "--id", "user")

    assert approved["taskCompleted"] is False
    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert task_record["status"] == "needs_input"
    assert task_record["completedAt"] is None
    assert [gate["status"] for gate in task_record["qualityGates"]] == ["pending", "pending"]


def test_gated_phase_and_rework_statuses_keep_run_executing(tmp_path) -> None:
    for status in ["review", "testing", "product", "changes_requested"]:
        record = task("T1", f"{status} work", "developer", "in_progress", owner="developer-fixture")
        fixture = create_team(tmp_path, f"run-executing-{status.replace('_', '-')}", [record])
        state = read_state(fixture.state_path)
        state["sprintengine"]["status"] = "planned"
        write_state(fixture.state_path, state)

        fixture.cli.run("task", "status", "--task-id", "T1", "--status", status, "--id", "developer-fixture")

        state = read_state(fixture.state_path)
        assert state["sprintengine"]["status"] == "executing"
        assert_task_status(state, "T1", status)


def test_task_publish_to_review_keeps_run_executing(tmp_path) -> None:
    fixture = create_team(tmp_path, "publish-review-run-executing", [gated_task()])
    state = read_state(fixture.state_path)
    state["sprintengine"]["status"] = "planned"
    write_state(fixture.state_path, state)

    payload = fixture.cli.run("task", "publish", "--task-id", "T1", "--id", "developer-fixture", "--summary", "Ready.")

    assert payload["nextStatus"] == "review"
    state = read_state(fixture.state_path)
    assert state["sprintengine"]["status"] == "executing"


def test_done_and_canceled_tasks_complete_run(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "done-canceled-run-completed",
        [
            task("T1", "Completed task", "developer", "done"),
            task("T2", "Canceled task", "tester", "in_progress", owner="tester-fixture"),
        ],
    )
    state = read_state(fixture.state_path)
    state["sprintengine"]["status"] = "planned"
    write_state(fixture.state_path, state)

    fixture.cli.run("task", "status", "--task-id", "T2", "--status", "canceled", "--id", "tester-fixture")

    state = read_state(fixture.state_path)
    assert state["sprintengine"]["status"] == "completed"


def test_all_canceled_tasks_complete_run_as_terminal_state(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "all-canceled-run-completed",
        [
            task("T1", "Canceled task", "developer", "in_progress", owner="developer-fixture"),
            task("T2", "Already canceled task", "tester", "canceled"),
        ],
    )
    state = read_state(fixture.state_path)
    state["sprintengine"]["status"] = "planned"
    write_state(fixture.state_path, state)

    fixture.cli.run("task", "status", "--task-id", "T1", "--status", "canceled", "--id", "developer-fixture")

    state = read_state(fixture.state_path)
    assert state["sprintengine"]["status"] == "completed"


def test_task_comment_add_and_list_use_structured_comment_shape(tmp_path) -> None:
    fixture = create_team(tmp_path, "structured-task-comments", [task("T1", "Implementation", "developer")])

    added = fixture.cli.run(
        "task",
        "comment",
        "add",
        "--task-id",
        "T1",
        "--id",
        "developer-fixture",
        "--source",
        "agent",
        "--type",
        "implementation_summary",
        "--body",
        "Implementation note.",
        "--path",
        "sprintengine_core/tool.py",
        "--data-json",
        '{"reviewerFocus":["path validation"]}',
    )
    listed = fixture.cli.run("task", "comment", "list", "--task-id", "T1")

    assert added["comment"]["id"] == "C1"
    assert added["comment"]["type"] == "implementation_summary"
    assert added["comment"]["authorAgentId"] == "developer-fixture"
    assert added["comment"]["authorRole"] == "developer"
    assert added["comment"]["data"]["reviewerFocus"] == ["path validation"]
    assert listed["comments"] == [added["comment"]]


def test_task_status_todo_releases_owner_and_makes_task_claimable(tmp_path) -> None:
    releasable_task = task("T1", "Too large for current context", "frontend", "in_progress", owner="frontend-1")
    releasable_task["startedAt"] = "2026-05-14T09:00:00Z"
    fixture = create_team(tmp_path, "todo-release-clears-owner", [
        releasable_task,
    ])

    payload = fixture.cli.run("task", "status", "--task-id", "T1", "--status", "todo", "--id", "frontend-1")

    assert payload["ok"] is True
    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert task_record["status"] == "todo"
    assert task_record["ownerAgentId"] is None
    assert task_record["startedAt"] is None
    assert task_record["completedAt"] is None
    assert state["agents"]["frontend-1"]["status"] == "idle"
    assert state["agents"]["frontend-1"]["currentTaskId"] is None
    assert_ready_tasks(fixture.cli, "frontend", ["T1"])

    claimed = fixture.cli.run("task", "next", "--role", "frontend", "--id", "frontend-2")
    assert claimed["claimed"] is True
    assert claimed["task"]["id"] == "T1"
    assert claimed["task"]["ownerAgentId"] == "frontend-2"


def test_task_resolve_input_resumes_original_owner_with_notification(tmp_path) -> None:
    blocked_task = task("T1", "Blocked implementation", "frontend", "needs_input", owner="frontend-1")
    blocked_task["needsInput"] = {
        "kind": "architect",
        "reason": "task_scope",
        "question": "Scope mismatch.",
        "reportedBy": "frontend-1",
        "reportedAt": "2026-05-14T00:00:00Z",
    }
    fixture = create_team(tmp_path, "resolve-input-resumes-owner", [blocked_task])

    payload = fixture.cli.run(
        "task",
        "resolve-input",
        "--task-id",
        "T1",
        "--id",
        "architect",
        "--resolution",
        "Scope narrowed; continue.",
    )

    assert payload["ok"] is True
    assert payload["transition"] == {"status": "in_progress", "ownerAgentId": "frontend-1"}
    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert task_record["status"] == "in_progress"
    assert task_record["ownerAgentId"] == "frontend-1"
    assert task_record["needsInput"]["resolvedBy"] == "architect"
    assert task_record["needsInput"]["resolution"] == "Scope narrowed; continue."
    assert task_record["needsInput"]["resumeRequestedAt"]
    assert state["agents"]["frontend-1"]["status"] == "running"
    assert state["agents"]["frontend-1"]["currentTaskId"] == "T1"
    notification = state["events"][-1]
    assert notification["type"] == "agent_notification_requested"
    assert notification["targetAgentId"] == "frontend-1"
    assert notification["taskId"] == "T1"
    assert notification["notificationKind"] == "task_resume_requested"


def test_task_resolve_input_complete_marks_done_and_notifies_owner(tmp_path) -> None:
    blocked_task = task("T1", "Review gate", "code_reviewer", "needs_input", owner="code_reviewer")
    blocked_task["needsInput"] = {
        "kind": "architect",
        "reason": "artifact_review",
        "question": "Artifact needs adjudication.",
        "reportedBy": "code_reviewer",
        "reportedAt": "2026-05-14T00:00:00Z",
    }
    fixture = create_team(tmp_path, "resolve-input-completes-task", [blocked_task])

    payload = fixture.cli.run(
        "task",
        "resolve-input",
        "--task-id",
        "T1",
        "--id",
        "architect",
        "--resolution",
        "Artifact adjudicated; review gate complete.",
        "--complete",
    )

    assert payload["ok"] is True
    assert payload["transition"] == {"status": "done", "ownerAgentId": "code_reviewer"}
    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert task_record["status"] == "done"
    assert task_record["completedAt"]
    assert state["agents"]["code_reviewer"]["status"] == "idle"
    notification = state["events"][-1]
    assert notification["type"] == "agent_notification_requested"
    assert notification["notificationKind"] == "task_completed_after_input_resolution"


def test_task_resolve_input_rejects_unowned_resume_without_complete(tmp_path) -> None:
    blocked_task = task("T1", "Unowned blocker", "frontend", "needs_input")
    blocked_task["needsInput"] = {
        "kind": "architect",
        "reason": "task_scope",
        "question": "Needs a decision.",
        "reportedBy": "frontend-1",
        "reportedAt": "2026-05-14T00:00:00Z",
    }
    fixture = create_team(tmp_path, "resolve-input-unowned-rejected", [blocked_task])

    rejected = fixture.cli.run_failure(
        "task",
        "resolve-input",
        "--task-id",
        "T1",
        "--id",
        "architect",
        "--resolution",
        "Continue.",
    )

    assert "without an owner" in rejected.stderr


def test_task_release_clears_active_owner_and_notifies_previous_owner(tmp_path) -> None:
    active_task = task("T1", "Abandoned task", "frontend", "in_progress", owner="frontend-1")
    active_task["startedAt"] = "2026-05-14T09:00:00Z"
    fixture = create_team(tmp_path, "task-release", [active_task])

    payload = fixture.cli.run(
        "task",
        "release",
        "--task-id",
        "T1",
        "--id",
        "architect",
        "--reason",
        "Original worker inactive.",
    )

    assert payload["ok"] is True
    assert payload["transition"] == {"previousOwnerAgentId": "frontend-1", "status": "todo"}
    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert task_record["status"] == "todo"
    assert task_record["ownerAgentId"] is None
    assert state["agents"]["frontend-1"]["status"] == "idle"
    assert_ready_tasks(fixture.cli, "frontend", ["T1"])
    notification = state["events"][-1]
    assert notification["type"] == "agent_notification_requested"
    assert notification["notificationKind"] == "task_released_from_owner"


def test_task_status_requires_question_for_routed_needs_input(tmp_path) -> None:
    fixture = create_team(tmp_path, "needs-input-question-required", [
        task("T1", "Ambiguous blocker", "frontend", "in_progress", owner="frontend-1"),
    ])

    rejected = fixture.cli.run_failure(
        "task",
        "status",
        "--task-id",
        "T1",
        "--status",
        "needs_input",
        "--id",
        "frontend-1",
        "--needs-input-kind",
        "architect",
    )

    assert "--needs-input-question is required" in rejected.stderr


def test_bare_needs_input_keeps_legacy_status_without_routing_metadata(tmp_path) -> None:
    blocked_task = task("T1", "Legacy blocker", "developer", "in_progress", owner="developer-1")
    blocked_task["needsInput"] = {
        "kind": "architect",
        "question": "Old routed blocker.",
        "reportedBy": "developer-1",
        "reportedAt": "2026-05-14T00:00:00Z",
    }
    fixture = create_team(tmp_path, "bare-needs-input", [blocked_task])

    payload = fixture.cli.run(
        "task",
        "status",
        "--task-id",
        "T1",
        "--status",
        "needs_input",
        "--id",
        "developer-1",
    )

    assert payload["ok"] is True
    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert task_record["status"] == "needs_input"
    assert "needsInput" not in task_record


def test_manual_dispatch_ready_task_is_claimable_after_dependencies_complete(tmp_path) -> None:
    gate = task("T1", "Approval gate", "architect", "done")
    manual_task = task("T2", "Imported issue ready for work", "developer", depends_on=["T1"])
    manual_task["dispatch"] = {
        "mode": "manual",
        "status": "ready",
        "triagedBy": "user",
        "readyAt": "2026-05-07T12:05:00Z",
    }
    fixture = create_team(tmp_path, "manual-dispatch-ready", [gate, manual_task])

    assert_ready_tasks(fixture.cli, "developer", ["T2"])
    state = read_state(fixture.state_path)
    assert_board_column(state, "T2", "ready")

    claimed = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-fixture")
    assert claimed["claimed"] is True
    assert claimed["task"]["id"] == "T2"
    assert claimed["task"]["dispatch"]["status"] == "ready"


def test_product_and_architect_approval_gates_control_downstream_readiness(tmp_path) -> None:
    state_path = tmp_path / ".multi-code" / "sprintengine" / "approval-gates" / "run.yaml"
    cli = SwarmCli(state_path)

    init_payload = cli.run("init", "--goal", "Exercise approval gates")
    assert init_payload["ok"] is True
    assert init_payload["action"] == "initialized"
    assert "role" not in init_payload
    assert "prompt" not in init_payload

    state = read_state(state_path)
    product_task = init_payload["productTask"]
    plan_task = init_payload["planTask"]
    assert_task_status(state, product_task["id"], "todo")
    assert get_task(state, product_task["id"])["ownerAgentId"] is None
    assert_task_status(state, plan_task["id"], "todo")
    assert_board_column(state, product_task["id"], "ready")
    assert_board_column(state, plan_task["id"], "todo")
    assert_ready_tasks(cli, "product", [product_task["id"]])
    assert_ready_tasks(cli, "architect", [])

    claimed = cli.run("task", "next", "--role", "product", "--id", "product-fixture")
    assert claimed["claimed"] is True
    claimed_state = read_state(state_path)
    assert_task_status(claimed_state, product_task["id"], "in_progress")
    assert get_task(claimed_state, product_task["id"])["ownerAgentId"] == "product-fixture"

    product_artifact = init_payload["productArtifact"]
    (state_path.parent / "product-requirements.md").write_text("# Product Requirements\n", encoding="utf-8")
    cli.run("artifact", "ready", "--artifact-id", product_artifact["id"], "--id", "product-fixture")
    cli.run("artifact", "approve", "--artifact-id", product_artifact["id"], "--id", "user")

    product_approved = read_state(state_path)
    assert_task_status(product_approved, product_task["id"], "done")
    assert_board_column(product_approved, plan_task["id"], "ready")
    assert_ready_tasks(cli, "architect", [plan_task["id"]])

    cli.run(
        "task",
        "next",
        "--role",
        "architect",
        "--id",
        "architect-fixture",
    )
    plan_artifact = artifact_by_kind(read_state(state_path), "architect_plan")
    (state_path.parent / "plan.md").write_text("# Architect Plan\n", encoding="utf-8")
    cli.run("artifact", "ready", "--artifact-id", plan_artifact["id"], "--id", "architect-fixture")
    plan_ready = read_state(state_path)
    assert artifact_by_kind(plan_ready, "architect_plan")["createdBy"] == "architect-fixture"
    cli.run("artifact", "approve", "--artifact-id", plan_artifact["id"], "--id", "user")

    plan_approved = read_state(state_path)
    assert_task_status(plan_approved, plan_task["id"], "done")
    assert_event_type(plan_approved, "artifact_approved")


def test_init_respects_selected_roster_without_product_gate(tmp_path) -> None:
    state_path = tmp_path / ".multi-code" / "sprintengine" / "rostered-team" / "run.yaml"
    cli = SwarmCli(state_path)

    payload = cli.run(
        "init",
        "--goal",
        "Plan with a selected roster",
        "--agent",
        "architect:architect",
        "--agent",
        "developer:developer-1",
    )

    assert payload["ok"] is True
    assert payload["productTask"] is None
    assert payload["planTask"]["role"] == "architect"
    assert payload["planTask"]["dependsOn"] == []

    state = read_state(state_path)
    assert set(state["agents"]) == {"architect", "developer-1"}
    assert_ready_tasks(cli, "architect", [payload["planTask"]["id"]])


def test_architect_cannot_add_tasks_for_roles_absent_from_roster(tmp_path) -> None:
    state_path = tmp_path / ".multi-code" / "sprintengine" / "rostered-plan" / "run.yaml"
    cli = SwarmCli(state_path)
    cli.run(
        "init",
        "--goal",
        "Constrain role planning",
        "--agent",
        "architect:architect",
        "--agent",
        "developer:developer-1",
    )

    rejected = cli.run_failure(
        "plan",
        "add-task",
        "--title",
        "Review performance",
        "--role",
        "performance",
        "--description",
        "Review the implementation.",
    )

    assert "Role 'performance' is not in this Sprint Engine roster" in rejected.stderr

    accepted = cli.run(
        "plan",
        "add-task",
        "--title",
        "Implement scoped work",
        "--role",
        "developer",
        "--description",
        "Build the selected change.",
    )
    assert accepted["task"]["role"] == "developer"


def test_roster_add_allows_later_specialist_tasks(tmp_path) -> None:
    state_path = tmp_path / ".multi-code" / "sprintengine" / "roster-expand" / "run.yaml"
    cli = SwarmCli(state_path)
    cli.run(
        "init",
        "--goal",
        "Expand a selected roster",
        "--agent",
        "architect:architect",
        "--agent",
        "developer:developer-1",
    )

    before = cli.run_failure(
        "plan",
        "add-task",
        "--title",
        "Review security",
        "--role",
        "security",
        "--description",
        "Review the implementation for security risk.",
    )
    assert "Role 'security' is not in this Sprint Engine roster" in before.stderr

    added = cli.run("roster", "add", "--role", "security", "--id", "security", "--actor", "architect")
    assert added["ok"] is True
    assert added["role"] == "security"

    after = cli.run(
        "plan",
        "add-task",
        "--title",
        "Review security",
        "--role",
        "security",
        "--description",
        "Review the implementation for security risk.",
    )
    assert after["task"]["role"] == "security"

    state = read_state(state_path)
    assert state["sprintengine"]["rosterConfigured"] is True
    assert state["agents"]["security"]["role"] == "security"
    assert_event_type(state, "roster_member_added")


def test_task_next_returns_active_task_before_claiming_new_work(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "active-task-reuse",
        [
            task("T1", "First implementation", "developer"),
            task("T2", "Second implementation", "developer"),
        ],
    )

    first = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-fixture")
    assert first["claimed"] is True
    assert first["task"]["id"] == "T1"

    second = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-fixture")
    assert second["claimed"] is False
    assert second["reason"] == "agent_already_has_active_task"
    assert second["task"]["id"] == "T1"

    state = read_state(fixture.state_path)
    assert_task_status(state, "T1", "in_progress")
    assert_task_status(state, "T2", "todo")
    assert_board_column(state, "T2", "ready")


def test_active_task_reconnect_and_join_do_not_rewrite_state(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "active-task-reconnect-no-rewrite",
        [
            task("T1", "First implementation", "developer"),
            task("T2", "Second implementation", "developer"),
        ],
    )

    fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-fixture")

    next_payload = run_without_state_rewrite(
        fixture,
        "task",
        "next",
        "--role",
        "developer",
        "--id",
        "developer-fixture",
    )
    assert next_payload["claimed"] is False
    assert next_payload["reason"] == "agent_already_has_active_task"
    assert next_payload["task"]["id"] == "T1"

    join_payload = run_without_state_rewrite(
        fixture,
        "join",
        "--role",
        "developer",
        "--id",
        "developer-fixture",
    )
    assert join_payload["action"] == "resume"
    assert join_payload["task"]["id"] == "T1"


def test_join_and_task_next_resume_owned_changes_requested_rework(tmp_path) -> None:
    rework_task = task("T1", "Needs implementation rework", "frontend", "changes_requested")
    rework_task["ownerAgentId"] = "frontend-1"
    fixture = create_team(tmp_path, "owned-rework-resume", [rework_task])

    other_agent = fixture.cli.run(
        "join",
        "--role",
        "frontend",
        "--id",
        "frontend-2",
        "--watch",
        "--max-wait-seconds",
        "0",
    )
    assert other_agent["action"] == "idle"

    join_payload = fixture.cli.run(
        "join",
        "--role",
        "frontend",
        "--id",
        "frontend-1",
        "--watch",
        "--max-wait-seconds",
        "0",
    )
    assert join_payload["action"] == "resume"
    assert join_payload["task"]["id"] == "T1"

    next_payload = fixture.cli.run("task", "next", "--role", "frontend", "--id", "frontend-1")
    assert next_payload["claimed"] is False
    assert next_payload["reason"] == "agent_already_has_active_task"
    assert next_payload["task"]["id"] == "T1"


def test_completed_agent_ids_can_claim_a_second_ready_task(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "completed-agent-reuse",
        [
            task("T1", "First implementation", "developer"),
            task("T2", "Second implementation", "developer"),
        ],
    )
    state = read_state(fixture.state_path)
    state["sprintengine"]["qualityPolicy"] = {"enabled": False}
    write_state(fixture.state_path, state)

    fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-fixture")
    fixture.cli.run(
        "task",
        "log",
        "--task-id",
        "T1",
        "--id",
        "developer-fixture",
        "--summary",
        "Completed the first task.",
        "--file",
        "tests/sprintengine_tool/test_task_lifecycle.py",
        "--command",
        "pytest tests/sprintengine_tool/test_task_lifecycle.py",
        "--result",
        "Passed",
    )
    fixture.cli.run("task", "status", "--task-id", "T1", "--status", "done", "--id", "developer-fixture")

    next_payload = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-fixture")
    assert next_payload["claimed"] is True
    assert next_payload["task"]["id"] == "T2"
    assert next_payload["agent"]["status"] == "running"
    assert next_payload["agent"]["currentTaskId"] == "T2"

    state = read_state(fixture.state_path)
    assert_task_status(state, "T1", "done")
    assert_task_status(state, "T2", "in_progress")


def test_task_claiming_is_restricted_to_the_requested_role(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "role-restricted-next",
        [
            task("T1", "Developer implementation", "developer"),
            task("T2", "Tester validation", "tester", depends_on=["T1"]),
        ],
    )

    wrong_role = fixture.cli.run("task", "next", "--role", "tester", "--id", "tester-fixture")
    assert wrong_role["claimed"] is False
    assert wrong_role["reason"] == "no_ready_task"

    state = read_state(fixture.state_path)
    assert_task_status(state, "T1", "todo")
    assert_task_status(state, "T2", "todo")
    assert_ready_tasks(fixture.cli, "developer", ["T1"])


def test_task_log_records_evidence_without_changing_lifecycle_state(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "task-evidence",
        [task("T1", "Implementation with evidence", "developer", "in_progress", owner="developer-fixture")],
    )

    payload = fixture.cli.run(
        "task",
        "log",
        "--task-id",
        "T1",
        "--id",
        "developer-fixture",
        "--summary",
        "Encoded task lifecycle regressions.",
        "--file",
        "tests/sprintengine_tool/test_task_lifecycle.py",
        "--command",
        "pytest tests/sprintengine_tool/test_task_lifecycle.py",
        "--result",
        "Passed",
    )

    assert payload["ok"] is True
    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert_task_status(state, "T1", "in_progress")
    assert task_record["evidence"] == {
        "summary": "Encoded task lifecycle regressions.",
        "touchedFiles": ["tests/sprintengine_tool/test_task_lifecycle.py"],
        "commandsRan": ["pytest tests/sprintengine_tool/test_task_lifecycle.py"],
        "results": ["Passed"],
        "scopeExpansions": [],
    }
    assert_event_type(state, "task_evidence_appended")


def test_task_log_records_scope_expansions_and_summary_surfaces_them(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "task-scope-expansion",
        [
            task(
                "T1",
                "Implementation with companion test",
                "developer",
                "in_progress",
                owner="developer-fixture",
                owned_paths=["sprintengine_core/tool.py"],
            )
        ],
    )
    state = read_state(fixture.state_path)
    state["sprintengine"]["qualityPolicy"] = {"enabled": False}
    write_state(fixture.state_path, state)

    payload = fixture.cli.run(
        "task",
        "log",
        "--task-id",
        "T1",
        "--id",
        "developer-fixture",
        "--summary",
        "Added companion regression coverage.",
        "--file",
        "sprintengine_core/tool.py",
        "--file",
        "tests/sprintengine_tool/test_task_lifecycle.py",
        "--scope-expansion-json",
        '{"path":"tests/sprintengine_tool/test_task_lifecycle.py","reason":"colocated regression coverage for task log evidence","risk":"low; test-only"}',
    )
    assert payload["ok"] is True

    fixture.cli.run("task", "status", "--task-id", "T1", "--status", "done", "--id", "developer-fixture")

    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert task_record["evidence"]["scopeExpansions"] == [
        {
            "path": "tests/sprintengine_tool/test_task_lifecycle.py",
            "reason": "colocated regression coverage for task log evidence",
            "risk": "low; test-only",
        }
    ]
    summary = fixture.cli.run("summary")["summary"]
    assert summary["scopeExpansions"] == [
        {
            "taskId": "T1",
            "path": "tests/sprintengine_tool/test_task_lifecycle.py",
            "reason": "colocated regression coverage for task log evidence",
            "risk": "low; test-only",
        }
    ]


def test_task_log_rejects_absolute_scope_expansion_path(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "task-scope-expansion-absolute",
        [task("T1", "Invalid companion edit path", "developer", "in_progress", owner="developer-fixture")],
    )

    rejected = fixture.cli.run_failure(
        "task",
        "log",
        "--task-id",
        "T1",
        "--id",
        "developer-fixture",
        "--scope-expansion-json",
        '{"path":"/tmp/outside.py","reason":"bad absolute path"}',
    )

    assert "must use project-root-relative paths" in rejected.stderr
