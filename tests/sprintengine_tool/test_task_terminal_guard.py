"""Done/canceled are terminal for agents (MC-1749).

The 2026-07-22 owner ruling (task-immutability restoration, MC-1744) made
`done` terminal: agents never reopen completed work; blocking findings become
NEW tasks (fix-forward). b4f5a0fc enforced this by deleting the rework
machinery, but `task status` could still move a done task anywhere (observed
live: done -> needs_input on the post-merge-hardening run). These tests pin the
imperative guard in `cmd_task_status`, including its single sanctioned
exception: the human Inbox send-back (done -> in_progress under the
implementer), which only the supervisor requests via `--actor-kind human`.
"""

from __future__ import annotations

from fixtures import create_team, get_task, read_state, task


def done_task(owner_history: str = "developer-fixture") -> dict:
    record = task("T1", "Completed implementation", "developer", "done")
    record["startedAt"] = "2026-07-08T00:00:00Z"
    record["completedAt"] = "2026-07-08T01:00:00Z"
    record["lastImplementedByAgentId"] = owner_history
    return record


def canceled_task() -> dict:
    record = task("T1", "Canceled implementation", "developer", "canceled")
    return record


def test_agent_cannot_move_a_done_task_to_needs_input(tmp_path) -> None:
    fixture = create_team(tmp_path, "terminal-needs-input", [done_task()])

    rejected = fixture.cli.run_failure(
        "task", "status", "--task-id", "T1", "--status", "needs_input", "--id", "developer-fixture",
    )

    assert "terminal" in rejected.stderr
    assert "plan.add_task" in rejected.stderr
    assert get_task(read_state(fixture.state_path), "T1")["status"] == "done"


def test_agent_cannot_move_a_done_task_to_todo_or_in_progress(tmp_path) -> None:
    for target in ("todo", "in_progress"):
        fixture = create_team(tmp_path, f"terminal-{target}", [done_task()])

        rejected = fixture.cli.run_failure(
            "task", "status", "--task-id", "T1", "--status", target, "--id", "developer-fixture",
        )

        assert "terminal" in rejected.stderr
        assert get_task(read_state(fixture.state_path), "T1")["status"] == "done"


def test_canceled_is_terminal_even_for_human_actors(tmp_path) -> None:
    fixture = create_team(tmp_path, "terminal-canceled", [canceled_task()])

    rejected = fixture.cli.run_failure(
        "task", "status", "--task-id", "T1", "--status", "in_progress",
        "--id", "user-1", "--actor-kind", "human",
    )

    assert "terminal" in rejected.stderr
    assert get_task(read_state(fixture.state_path), "T1")["status"] == "canceled"


def test_human_send_back_reopens_a_done_task_under_its_implementer(tmp_path) -> None:
    fixture = create_team(tmp_path, "terminal-human-send-back", [done_task()])

    payload = fixture.cli.run(
        "task", "status", "--task-id", "T1", "--status", "in_progress",
        "--id", "user-1", "--actor-kind", "human",
    )

    assert payload["ok"] is True
    record = get_task(read_state(fixture.state_path), "T1")
    assert record["status"] == "in_progress"
    # Flow 5: the reopen re-binds the task to the agent that implemented it.
    assert record["ownerAgentId"] == "developer-fixture"
    assert record["completedAt"] is None


def test_human_send_back_only_covers_in_progress(tmp_path) -> None:
    fixture = create_team(tmp_path, "terminal-human-limited", [done_task()])

    rejected = fixture.cli.run_failure(
        "task", "status", "--task-id", "T1", "--status", "needs_input",
        "--id", "user-1", "--actor-kind", "human",
        "--needs-input-question", "Should this be reopened?",
    )

    assert "terminal" in rejected.stderr
    assert get_task(read_state(fixture.state_path), "T1")["status"] == "done"


def test_publish_commit_failure_leaves_the_task_unpublished(tmp_path, monkeypatch) -> None:
    """Ordering proof (MC-1749): publish commits BEFORE the status flip, inside
    one locked mutation whose state write is discarded on raise — so a commit
    failure can never leave a done task with uncommitted changes."""
    from sprintengine_core.tool.commands import task as task_commands

    record = task("T1", "Implementation", "developer", "in_progress", owner="developer-fixture")
    record["startedAt"] = "2026-07-08T00:00:00Z"
    fixture = create_team(tmp_path, "publish-commit-order", [record])

    def failing_commit(*_args, **_kwargs):
        raise SystemExit("simulated commit failure")

    monkeypatch.setattr(task_commands, "commit_task_changes_if_needed", failing_commit)

    class Args:
        state = fixture.state_path
        task_id = "T1"
        id = "developer-fixture"
        summary = "Implemented it."
        path = []
        summary_data_json = None
        actual_difficulty_pct = None
        actual_difficulty_reason = ""

    try:
        task_commands.cmd_task_publish(Args())
        raise AssertionError("publish unexpectedly succeeded")
    except SystemExit:
        pass

    record_after = get_task(read_state(fixture.state_path), "T1")
    assert record_after["status"] == "in_progress"
    assert record_after.get("completedAt") in (None, "")


def test_setting_the_same_terminal_status_is_not_a_transition(tmp_path) -> None:
    # Idempotent re-set (done -> done) is allowed: it is not a reopen, and the
    # completion stamping path re-runs harmlessly.
    fixture = create_team(tmp_path, "terminal-idempotent", [done_task()])

    payload = fixture.cli.run(
        "task", "status", "--task-id", "T1", "--status", "done", "--id", "developer-fixture",
    )

    assert payload["ok"] is True
    assert get_task(read_state(fixture.state_path), "T1")["status"] == "done"
