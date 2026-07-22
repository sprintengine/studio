"""Run-level cancel op (MC-1604a): status, task transitions, lease release, event."""
from __future__ import annotations

from typing import Any

from helpers import base_state, create_team, get_task, read_state, task


def _with_lease(record: dict[str, Any], worker_id: str, role: str) -> dict[str, Any]:
    record["lease"] = {
        "workerId": worker_id,
        "role": role,
        "heartbeatAt": "2026-07-15T00:00:00Z",
        "since": "2026-07-15T00:00:00Z",
    }
    return record


def _cancel_ready_team(tmp_path):
    done = task("T1", "Already done", "developer", status="done")
    done["evidence"] = {
        "summary": "Landed the seam.",
        "touchedFiles": ["src/a.ts"],
        "commandsRan": ["npm test"],
        "results": ["pass"],
        "scopeExpansions": [],
    }
    done["completedAt"] = "2026-07-15T00:00:00Z"
    active = _with_lease(
        task("T2", "In flight", "developer", status="in_progress", owner="developer-1"),
        "developer-1",
        "developer",
    )
    reviewing = _with_lease(
        task("T3", "Reviewing", "developer", status="review", owner="developer-2"),
        "developer-2",
        "developer",
    )
    todo = task("T4", "Not started", "developer", status="todo")
    blocked = task("T5", "Blocked", "developer", status="needs_input")
    return create_team(tmp_path, "cancelable", [done, active, reviewing, todo, blocked])


def test_cancel_sets_run_status_and_flag(tmp_path) -> None:
    fixture = _cancel_ready_team(tmp_path)

    result = fixture.cli.run("cancel", "--id", "user")

    assert result["ok"] is True
    assert result["status"] == "canceled"
    assert sorted(result["canceledTaskIds"]) == ["T2", "T3", "T4", "T5"]

    state = read_state(fixture.state_path)
    assert state["sprintengine"]["status"] == "canceled"
    assert state["sprintengine"]["canceled"] is True
    assert state["sprintengine"].get("canceledBy") == "user"
    assert state["sprintengine"].get("canceledAt")


def test_cancel_moves_only_non_done_tasks(tmp_path) -> None:
    fixture = _cancel_ready_team(tmp_path)
    fixture.cli.run("cancel", "--id", "user")
    state = read_state(fixture.state_path)

    # Done task and its evidence are untouched.
    done = get_task(state, "T1")
    assert done["status"] == "done"
    assert done["evidence"]["summary"] == "Landed the seam."
    assert done["evidence"]["touchedFiles"] == ["src/a.ts"]
    assert done["completedAt"] == "2026-07-15T00:00:00Z"

    for task_id in ("T2", "T3", "T4", "T5"):
        moved = get_task(state, task_id)
        assert moved["status"] == "canceled", task_id


def test_cancel_releases_owners_and_leases(tmp_path) -> None:
    fixture = _cancel_ready_team(tmp_path)
    fixture.cli.run("cancel", "--id", "user")
    state = read_state(fixture.state_path)

    for task_id in ("T2", "T3"):
        moved = get_task(state, task_id)
        assert moved.get("ownerAgentId") is None, task_id
        assert moved.get("lease") is None, task_id


def test_cancel_appends_single_run_canceled_event(tmp_path) -> None:
    fixture = _cancel_ready_team(tmp_path)
    fixture.cli.run("cancel", "--id", "user")
    state = read_state(fixture.state_path)

    run_canceled = [event for event in state["events"] if event.get("type") == "run_canceled"]
    assert len(run_canceled) == 1
    assert run_canceled[0]["actor"] == "user"
    assert run_canceled[0]["canceledTaskCount"] == 4


def test_cancel_is_idempotent(tmp_path) -> None:
    fixture = _cancel_ready_team(tmp_path)
    fixture.cli.run("cancel", "--id", "user")

    again = fixture.cli.run("cancel", "--id", "user")
    assert again["ok"] is True
    assert again["alreadyCanceled"] is True
    assert again["status"] == "canceled"
    assert again["canceledTaskIds"] == []

    state = read_state(fixture.state_path)
    run_canceled = [event for event in state["events"] if event.get("type") == "run_canceled"]
    assert len(run_canceled) == 1


def test_canceled_status_is_not_recomputed_to_completed(tmp_path) -> None:
    # After cancel, every task is done-or-canceled — the recompute_phase rollup
    # that turns an all-done/canceled run into `completed` must be suppressed by
    # the stored cancel flag. cmd_cancel itself calls recompute_phase, so a
    # `canceled` status surviving proves the guard.
    fixture = _cancel_ready_team(tmp_path)
    fixture.cli.run("cancel", "--id", "user")
    state = read_state(fixture.state_path)
    assert state["sprintengine"]["status"] == "canceled"


def test_cancel_empty_task_graph(tmp_path) -> None:
    fixture = create_team(tmp_path, "empty", [])
    result = fixture.cli.run("cancel", "--id", "user")
    assert result["status"] == "canceled"
    assert result["canceledTaskIds"] == []
    state = read_state(fixture.state_path)
    assert state["sprintengine"]["canceled"] is True
    assert state["sprintengine"]["status"] == "canceled"


# ── Honoring a canceled run: writers refuse, dispatch reports canceled (T6) ──


def _canceled_team(tmp_path):
    fixture = _cancel_ready_team(tmp_path)
    fixture.cli.run("cancel", "--id", "user")
    return fixture


def test_publish_refused_on_canceled_run(tmp_path) -> None:
    fixture = _canceled_team(tmp_path)
    rejected = fixture.cli.run_failure(
        "task", "publish", "--task-id", "T2", "--id", "developer-1", "--summary", "late work"
    )
    assert "canceled" in rejected.stderr


def test_advance_refused_on_canceled_run(tmp_path) -> None:
    fixture = _canceled_team(tmp_path)
    rejected = fixture.cli.run_failure(
        "task", "advance", "--task-id", "T2", "--id", "developer-1",
        "--phase", "review", "--outcome", "pass", "--summary", "reviewed",
    )
    assert "canceled" in rejected.stderr


def test_log_refused_on_canceled_run(tmp_path) -> None:
    fixture = _canceled_team(tmp_path)
    rejected = fixture.cli.run_failure(
        "task", "log", "--task-id", "T2", "--id", "developer-1", "--summary", "note"
    )
    assert "canceled" in rejected.stderr


def test_vcs_commit_refused_on_canceled_run(tmp_path) -> None:
    # The cancel guard runs before the worktree-mode check, so a non-worktree
    # canceled run refuses with the cancel message rather than "not in worktree
    # mode" — proving the guard is the first thing a commit hits.
    fixture = _canceled_team(tmp_path)
    rejected = fixture.cli.run_failure(
        "vcs", "commit", "--task-id", "T2", "--id", "developer-1"
    )
    assert "canceled" in rejected.stderr


def test_task_next_reports_canceled_run(tmp_path) -> None:
    fixture = _canceled_team(tmp_path)
    payload = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")
    assert payload["claimed"] is False
    assert payload["reason"] == "run_canceled"


def test_join_reports_canceled_run(tmp_path) -> None:
    fixture = _canceled_team(tmp_path)
    payload = fixture.cli.run("join", "--role", "developer", "--id", "developer-1")
    assert payload["action"] == "canceled"


def test_task_status_on_canceled_run_honors_the_terminal_guard(tmp_path) -> None:
    # Canceled tasks are terminal like done ones (MC-1749, fix-forward): even on
    # a canceled run the low-level task.status transition refuses to resurrect
    # them — the repair for canceled work is a new task, not a reopen. The one
    # sanctioned reopen stays the human done -> in_progress send-back.
    fixture = _canceled_team(tmp_path)
    rejected = fixture.cli.run_failure(
        "task", "status", "--task-id", "T2", "--status", "todo", "--id", "user"
    )
    assert "terminal" in rejected.stdout + rejected.stderr
