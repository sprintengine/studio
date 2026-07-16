"""`task.next` serves a session only the work that lives in its own tree (MC-1613).

The pool supervisor spawns a session BEFORE any task is claimed, with cwd = one
declared repo's worktree. So the session's repo is decided at spawn, not at
claim, and the claim has to agree with it: a session sitting in the mobile
worktree that claimed a desktop task would commit through the wrong index, hold
the wrong repo's commit lock, and resolve its repo-relative paths against the
wrong tree.

The repo therefore filters the queue the same way the role does. It is bound to
the session by the MCP server (from the cwd the session launched in) and stamped
onto the payload, never taken from what the agent asks for — an agent that omits
it still sees only its own tree's work. Sessions with no bound repo (single-repo
runs, the CLI, the operator surface) are unfiltered, exactly as before repos
existed.
"""
from __future__ import annotations

from pathlib import Path

from helpers import create_team, get_task, read_state, task, write_state
from sprintengine_core.tool.commands.task import cmd_task_next
from sprintengine_core.tool.state import task_lease


def _declare_repos(state_path: Path, *repo_ids: str) -> None:
    """Give the fixture run a worktree vcs block declaring `repo_ids` (primary first)."""
    state = read_state(state_path)
    state.setdefault("sprintengine", {})["vcs"] = {
        "mode": "run_worktree",
        "worktreePath": ".multi-code/sprintengine/alpha/worktree",
        "branchName": "sprintengine/alpha",
        "baseRef": "main",
        "status": "ready",
        "repos": [
            {
                "id": repo_id,
                "root": "." if index == 0 else f"../{repo_id}",
                "worktreePath": (
                    ".multi-code/sprintengine/alpha/worktree"
                    if index == 0
                    else f".multi-code/sprintengine/alpha/worktree-{repo_id}"
                ),
                "branchName": "sprintengine/alpha",
                "baseRef": "main",
                "status": "ready",
            }
            for index, repo_id in enumerate(repo_ids)
        ],
    }
    write_state(state_path, state)


def _seed_tasks(state_path: Path, *specs: tuple[str, str]) -> None:
    """Seed ready developer tasks as (task id, repo id) pairs, in queue order."""
    state = read_state(state_path)
    tasks = []
    for task_id, repo in specs:
        record = task(task_id, f"Work in {repo}", "developer")
        record["repo"] = repo
        tasks.append(record)
    state["tasks"] = tasks
    write_state(state_path, state)


def _args(state_path: Path, agent_id: str, repo: str | None):
    class Args:
        state = state_path
        role = "developer"
        id = agent_id
        model = None
        cli = None

    Args.repo = repo
    return Args()


def _two_repo_run(tmp_path: Path, name: str):
    fixture = create_team(tmp_path, name, [])
    _declare_repos(fixture.state_path, "primary", "mobile")
    return fixture


def test_a_repo_bound_session_claims_only_its_own_repos_work(tmp_path: Path) -> None:
    """The core routing invariant: an agent never claims a task in another repo."""
    fixture = _two_repo_run(tmp_path, "next-repo-filter")
    # The desktop task is FIRST in the queue, so an unfiltered claim would take
    # it — the mobile session must skip past it to its own tree's work.
    _seed_tasks(fixture.state_path, ("T-desktop", "primary"), ("T-mobile", "mobile"))

    claimed = cmd_task_next(_args(fixture.state_path, "developer-1", "mobile"))

    assert claimed["claimed"] is True
    assert claimed["task"]["id"] == "T-mobile"
    # And the lease agrees with the tree the session is actually sitting in.
    assert task_lease(get_task(read_state(fixture.state_path), "T-mobile"))["repo"] == "mobile"


def test_a_repo_bound_session_stops_rather_than_claiming_another_repos_work(tmp_path: Path) -> None:
    """With only other-repo work ready, the session takes nothing and stops. A
    session must never be handed a task it cannot correctly commit."""
    fixture = _two_repo_run(tmp_path, "next-repo-no-work")
    _seed_tasks(fixture.state_path, ("T-desktop", "primary"))

    result = cmd_task_next(_args(fixture.state_path, "developer-1", "mobile"))

    assert result["claimed"] is False
    assert result["reason"] == "no_ready_task"
    # The message names the tree it looked in, so an operator reading a stopped
    # session can tell "nothing for me here" from "nothing at all".
    assert "mobile" in result["message"]
    assert get_task(read_state(fixture.state_path), "T-desktop")["status"] == "todo"


def test_each_repos_session_claims_its_own_tree(tmp_path: Path) -> None:
    """Two concurrent sessions, one per repo: each lands on its own tree's task,
    and neither can take the other's."""
    fixture = _two_repo_run(tmp_path, "next-repo-concurrent")
    _seed_tasks(fixture.state_path, ("T-desktop", "primary"), ("T-mobile", "mobile"))

    mobile = cmd_task_next(_args(fixture.state_path, "developer-1", "mobile"))
    desktop = cmd_task_next(_args(fixture.state_path, "developer-2", "primary"))

    assert mobile["task"]["id"] == "T-mobile"
    assert desktop["task"]["id"] == "T-desktop"


def test_an_unbound_session_is_unfiltered(tmp_path: Path) -> None:
    """No bound repo (the CLI, an older app build) means no filter: every ready
    task for the role is a candidate, exactly as before repos existed."""
    fixture = _two_repo_run(tmp_path, "next-repo-unbound")
    _seed_tasks(fixture.state_path, ("T-mobile", "mobile"))

    claimed = cmd_task_next(_args(fixture.state_path, "developer-1", None))

    assert claimed["claimed"] is True
    assert claimed["task"]["id"] == "T-mobile"


def test_single_repo_runs_claim_exactly_as_before(tmp_path: Path) -> None:
    """The control: a run declaring one repo binds its sessions to `primary`,
    which every task defaults to — so the filter passes everything through."""
    fixture = create_team(tmp_path, "next-repo-single", [])
    _declare_repos(fixture.state_path, "primary")
    state = read_state(fixture.state_path)
    # A task predating the repo field at all: it defaults to primary and must
    # still be claimable by a primary-bound session.
    legacy = task("T1", "Legacy work", "developer")
    legacy.pop("repo", None)
    state["tasks"] = [legacy]
    write_state(fixture.state_path, state)

    claimed = cmd_task_next(_args(fixture.state_path, "developer-1", "primary"))

    assert claimed["claimed"] is True
    assert claimed["task"]["id"] == "T1"
    # The record itself never gained a `repo` key — the default lives in
    # `task_repo`, and the lease is where the resolved value lands.
    assert "repo" not in claimed["task"]
    assert task_lease(get_task(read_state(fixture.state_path), "T1"))["repo"] == "primary"


def test_a_session_bound_to_an_undeclared_repo_fails_loudly(tmp_path: Path) -> None:
    """A bound repo the run does not declare is a wiring bug, not a queue that
    happens to be empty: it fails with the declared set rather than silently
    serving nothing (or, worse, everything)."""
    import pytest

    fixture = _two_repo_run(tmp_path, "next-repo-undeclared")
    _seed_tasks(fixture.state_path, ("T-desktop", "primary"))

    with pytest.raises(SystemExit) as failure:
        cmd_task_next(_args(fixture.state_path, "developer-1", "gone"))

    message = str(failure.value)
    assert "gone" in message and "primary, mobile" in message
