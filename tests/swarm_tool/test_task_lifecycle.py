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


def test_product_and_architect_approval_gates_control_downstream_readiness(tmp_path) -> None:
    state_path = tmp_path / "swarm" / "approval-gates" / "state.yaml"
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
        "tests/swarm_tool/test_task_lifecycle.py",
        "--command",
        "pytest tests/swarm_tool/test_task_lifecycle.py",
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
        "tests/swarm_tool/test_task_lifecycle.py",
        "--command",
        "pytest tests/swarm_tool/test_task_lifecycle.py",
        "--result",
        "Passed",
    )

    assert payload["ok"] is True
    state = read_state(fixture.state_path)
    task_record = get_task(state, "T1")
    assert_task_status(state, "T1", "in_progress")
    assert task_record["evidence"] == {
        "summary": "Encoded task lifecycle regressions.",
        "touchedFiles": ["tests/swarm_tool/test_task_lifecycle.py"],
        "commandsRan": ["pytest tests/swarm_tool/test_task_lifecycle.py"],
        "results": ["Passed"],
    }
    assert_event_type(state, "task_evidence_appended")
