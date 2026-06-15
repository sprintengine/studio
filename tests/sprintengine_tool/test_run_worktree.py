"""Shared run-worktree mode: creation, per-task locked commits, and PR helper."""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from helpers import SwarmCli, SwarmTeamFixture, base_state, read_state, write_state
from sprintengine_mcp import SprintEngineMcpServer


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(
        ["git", *args],
        cwd=str(repo),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if completed.returncode != 0:
        raise AssertionError(f"git {' '.join(args)} failed: {completed.stderr or completed.stdout}")
    return completed


def _init_git_repo(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    _git(root, "init", "-q")
    _git(root, "config", "user.email", "test@example.com")
    _git(root, "config", "user.name", "Sprint Engine Test")
    _git(root, "config", "commit.gpgsign", "false")
    _git(root, "checkout", "-q", "-b", "main")
    (root / "README.md").write_text("seed\n", encoding="utf-8")
    _git(root, "add", "-A")
    _git(root, "commit", "-qm", "seed")


def _worktree_team(workspace: Path, name: str) -> SwarmTeamFixture:
    team_dir = workspace / ".multi-code" / "sprintengine" / name
    state_path = team_dir / "run.yaml"
    write_state(state_path, base_state(name, []))
    return SwarmTeamFixture(team_dir=team_dir, state_path=state_path, cli=SwarmCli(state_path, cwd=workspace))


def _worktree_dir(fixture: SwarmTeamFixture) -> Path:
    return fixture.team_dir / "worktree"


def _actor(agent_id: str, role: str = "user") -> dict[str, object]:
    return {"id": agent_id, "role": role, "mcpAuthorized": True}


def test_init_creates_shared_run_worktree(tmp_path) -> None:
    workspace = tmp_path / "ws"
    _init_git_repo(workspace)
    fixture = _worktree_team(workspace, "alpha")

    payload = fixture.cli.run("init", "--goal", "Build alpha", "--use-worktrees", "true")

    vcs = payload["vcs"]
    assert vcs is not None
    assert vcs["mode"] == "run_worktree"
    assert vcs["worktreePath"] == ".multi-code/sprintengine/alpha/worktree"
    assert vcs["branchName"] == "sprintengine/alpha"
    assert vcs["status"] == "ready"

    worktree = _worktree_dir(fixture)
    assert worktree.exists()
    branch = _git(worktree, "branch", "--show-current").stdout.strip()
    assert branch == "sprintengine/alpha"


def test_two_runs_get_independent_worktrees_and_branches(tmp_path) -> None:
    workspace = tmp_path / "ws"
    _init_git_repo(workspace)
    one = _worktree_team(workspace, "team-one")
    two = _worktree_team(workspace, "team-two")

    one.cli.run("init", "--goal", "one", "--use-worktrees", "true")
    two.cli.run("init", "--goal", "two", "--use-worktrees", "true")

    assert _worktree_dir(one).exists()
    assert _worktree_dir(two).exists()
    listing = _git(workspace, "worktree", "list").stdout
    assert "sprintengine/team-one" in listing
    assert "sprintengine/team-two" in listing


def test_vcs_commit_stages_only_task_owned_paths(tmp_path) -> None:
    workspace = tmp_path / "ws"
    _init_git_repo(workspace)
    fixture = _worktree_team(workspace, "alpha")
    fixture.cli.run("init", "--goal", "Build alpha", "--use-worktrees", "true", "--agent", "developer:developer-1")
    fixture.cli.run("plan", "add-task", "--title", "Feature", "--role", "developer", "--task-id", "T1", "--path", "src/feature.ts", "--no-quality-gates")
    status = fixture.cli.run("task", "status", "--task-id", "T1", "--status", "in_progress", "--id", "developer-1")
    assert status["task"]["status"] == "in_progress"

    worktree = _worktree_dir(fixture)
    (worktree / "src").mkdir(parents=True, exist_ok=True)
    (worktree / "src" / "feature.ts").write_text("export const f = 1\n", encoding="utf-8")
    # An unrelated dirty file that does NOT belong to T1 must not be committed.
    (worktree / "unrelated.txt").write_text("noise\n", encoding="utf-8")

    result = fixture.cli.run("vcs", "commit", "--task-id", "T1", "--id", "developer-1")
    assert result["committed"] is True
    assert result["commitSha"]

    committed = _git(worktree, "show", "--name-only", "--format=", "HEAD").stdout.split()
    assert committed == ["src/feature.ts"]
    # Unrelated file is still untracked in the shared worktree.
    status = _git(worktree, "status", "--porcelain").stdout
    assert "unrelated.txt" in status


def test_vcs_commit_includes_extra_path(tmp_path) -> None:
    workspace = tmp_path / "ws"
    _init_git_repo(workspace)
    fixture = _worktree_team(workspace, "alpha")
    fixture.cli.run("init", "--goal", "Build alpha", "--use-worktrees", "true", "--agent", "developer:developer-1")
    fixture.cli.run("plan", "add-task", "--title", "Feature", "--role", "developer", "--task-id", "T1", "--path", "src/feature.ts", "--no-quality-gates")
    status = fixture.cli.run("task", "status", "--task-id", "T1", "--status", "in_progress", "--id", "developer-1")
    assert status["task"]["status"] == "in_progress"

    worktree = _worktree_dir(fixture)
    (worktree / "src").mkdir(parents=True, exist_ok=True)
    (worktree / "src" / "feature.ts").write_text("export const f = 1\n", encoding="utf-8")
    (worktree / "src" / "feature.test.ts").write_text("test\n", encoding="utf-8")

    result = fixture.cli.run(
        "vcs", "commit", "--task-id", "T1", "--id", "developer-1", "--path", "src/feature.test.ts"
    )
    assert result["committed"] is True
    committed = sorted(_git(worktree, "show", "--name-only", "--format=", "HEAD").stdout.split())
    assert committed == sorted(["src/feature.ts", "src/feature.test.ts"])


def test_vcs_commit_noop_when_no_in_scope_changes(tmp_path) -> None:
    workspace = tmp_path / "ws"
    _init_git_repo(workspace)
    fixture = _worktree_team(workspace, "alpha")
    fixture.cli.run("init", "--goal", "Build alpha", "--use-worktrees", "true", "--agent", "developer:developer-1")
    fixture.cli.run("plan", "add-task", "--title", "Feature", "--role", "developer", "--task-id", "T1", "--path", "src/feature.ts", "--no-quality-gates")
    status = fixture.cli.run("task", "status", "--task-id", "T1", "--status", "in_progress", "--id", "developer-1")
    assert status["task"]["status"] == "in_progress"

    # Only an unrelated file is dirty; T1 owns nothing dirty.
    worktree = _worktree_dir(fixture)
    (worktree / "unrelated.txt").write_text("noise\n", encoding="utf-8")

    result = fixture.cli.run("vcs", "commit", "--task-id", "T1", "--id", "developer-1")
    assert result["committed"] is False
    assert result["commitSha"] is None


def test_task_publish_commits_task_paths_before_routing(tmp_path) -> None:
    workspace = tmp_path / "ws"
    _init_git_repo(workspace)
    fixture = _worktree_team(workspace, "alpha")
    fixture.cli.run("init", "--goal", "Build alpha", "--use-worktrees", "true", "--agent", "developer:developer-1")
    fixture.cli.run("plan", "add-task", "--title", "Feature", "--role", "developer", "--task-id", "T1", "--path", "src/feature.ts", "--no-quality-gates")
    status = fixture.cli.run("task", "status", "--task-id", "T1", "--status", "in_progress", "--id", "developer-1")
    assert status["task"]["status"] == "in_progress"

    worktree = _worktree_dir(fixture)
    (worktree / "src").mkdir(parents=True, exist_ok=True)
    (worktree / "src" / "feature.ts").write_text("export const f = 1\n", encoding="utf-8")
    (worktree / "unrelated.txt").write_text("noise\n", encoding="utf-8")

    result = fixture.cli.run(
        "task",
        "publish",
        "--task-id",
        "T1",
        "--id",
        "developer-1",
        "--summary",
        "Ready.",
        "--path",
        "src/feature.ts",
    )

    assert result["nextStatus"] == "done"
    assert result["committed"] is True
    assert result["commitSha"]
    committed = _git(worktree, "show", "--name-only", "--format=", "HEAD").stdout.split()
    assert committed == ["src/feature.ts"]
    status = _git(worktree, "status", "--porcelain").stdout
    assert "unrelated.txt" in status
    persisted = read_state(fixture.state_path)["tasks"][0]
    assert result["commitSha"] in persisted["evidence"]["commits"]


def test_mcp_task_publish_commits_task_paths_before_routing(tmp_path) -> None:
    workspace = tmp_path / "ws"
    _init_git_repo(workspace)
    fixture = _worktree_team(workspace, "alpha")
    fixture.cli.run("init", "--goal", "Build alpha", "--use-worktrees", "true", "--agent", "developer:developer-1")
    fixture.cli.run("plan", "add-task", "--title", "Feature", "--role", "developer", "--task-id", "T1", "--path", "src/feature.ts", "--no-quality-gates")
    fixture.cli.run("task", "claim", "--task-id", "T1", "--id", "developer-1")

    worktree = _worktree_dir(fixture)
    (worktree / "src").mkdir(parents=True, exist_ok=True)
    (worktree / "src" / "feature.ts").write_text("export const f = 1\n", encoding="utf-8")
    (worktree / "unrelated.txt").write_text("noise\n", encoding="utf-8")

    server = SprintEngineMcpServer(allowed_roots=[workspace])
    published = server.call_tool(
        "sprintengine.task.publish",
        {
            "statePath": str(fixture.state_path),
            "taskId": "T1",
            "id": "developer-1",
            "summary": "Ready.",
            "path": ["src/feature.ts"],
        },
        _actor("developer-1", "developer"),
    )

    assert published["ok"] is True
    assert published["result"]["taskId"] == "T1"
    assert published["result"]["taskStatus"] == "done"
    assert published["result"]["committed"] is True
    assert published["result"]["commitSha"]
    committed = _git(worktree, "show", "--name-only", "--format=", "HEAD").stdout.split()
    assert committed == ["src/feature.ts"]
    status = _git(worktree, "status", "--porcelain").stdout
    assert "unrelated.txt" in status
    persisted = read_state(fixture.state_path)["tasks"][0]
    assert published["result"]["commitSha"] in persisted["evidence"]["commits"]


def test_vcs_status_reports_branch_and_dirty(tmp_path) -> None:
    workspace = tmp_path / "ws"
    _init_git_repo(workspace)
    fixture = _worktree_team(workspace, "alpha")
    fixture.cli.run("init", "--goal", "Build alpha", "--use-worktrees", "true")

    status = fixture.cli.run("vcs", "status")
    assert status["enabled"] is True
    assert status["branchName"] == "sprintengine/alpha"
    assert status["clean"] is True

    (_worktree_dir(fixture) / "scratch.txt").write_text("x\n", encoding="utf-8")
    status = fixture.cli.run("vcs", "status")
    assert status["clean"] is False


def test_vcs_status_disabled_without_worktrees(tmp_path) -> None:
    workspace = tmp_path / "ws"
    _init_git_repo(workspace)
    fixture = _worktree_team(workspace, "alpha")
    fixture.cli.run("init", "--goal", "Build alpha")

    status = fixture.cli.run("vcs", "status")
    assert status["enabled"] is False
    assert status["vcs"] is None
