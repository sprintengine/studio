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
)


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


def test_legacy_artifact_needs_input_routes_to_architect_triage(tmp_path) -> None:
    blocked_task = task("T1", "Review legacy artifact", "code_reviewer", "needs_input", owner="code_reviewer")
    blocked_task["needsInput"] = {
        "kind": "artifact",
        "question": "Artifact A6 is ready for review.",
        "reportedBy": "code_reviewer",
        "reportedAt": "2026-05-14T00:00:00Z",
    }
    fixture = create_team(tmp_path, "legacy-artifact-routes-to-architect", [blocked_task])

    triage = fixture.cli.run("triage", "needs-input", "--id", "architect")

    assert [entry["id"] for entry in triage["tasks"]] == ["T1"]
    assert triage["tasks"][0]["needsInput"]["kind"] == "artifact"
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
    state_path = tmp_path / ".multi-code" / "sprintengine" / "approval-gates" / "state.yaml"
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
    state_path = tmp_path / ".multi-code" / "sprintengine" / "rostered-team" / "state.yaml"
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
    state_path = tmp_path / ".multi-code" / "sprintengine" / "rostered-plan" / "state.yaml"
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
    state_path = tmp_path / ".multi-code" / "sprintengine" / "roster-expand" / "state.yaml"
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


def test_completed_agent_ids_can_claim_a_second_ready_task(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "completed-agent-reuse",
        [
            task("T1", "First implementation", "developer"),
            task("T2", "Second implementation", "developer"),
        ],
    )

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
