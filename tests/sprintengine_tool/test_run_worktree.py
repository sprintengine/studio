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


def test_vcs_commit_warns_on_orphaned_new_directory(tmp_path) -> None:
    # Reproduces the T5 round-3 failure: an author splits an owned file into a new
    # sibling directory, but the directory is in no task's ownedPaths, so the
    # per-task commit silently leaves it out and a clean checkout cannot build.
    workspace = tmp_path / "ws"
    _init_git_repo(workspace)
    fixture = _worktree_team(workspace, "alpha")
    fixture.cli.run("init", "--goal", "Build alpha", "--use-worktrees", "true", "--agent", "developer:developer-1")
    fixture.cli.run("plan", "add-task", "--title", "Panel", "--role", "developer", "--task-id", "T1", "--path", "src/Panel.tsx", "--no-quality-gates")
    fixture.cli.run("task", "status", "--task-id", "T1", "--status", "in_progress", "--id", "developer-1")

    worktree = _worktree_dir(fixture)
    (worktree / "src").mkdir(parents=True, exist_ok=True)
    # The owned shell imports a new, unowned sibling directory.
    (worktree / "src" / "Panel.tsx").write_text("export { f } from './Panel/helper'\n", encoding="utf-8")
    (worktree / "src" / "Panel").mkdir(parents=True, exist_ok=True)
    (worktree / "src" / "Panel" / "helper.ts").write_text("export const f = 1\n", encoding="utf-8")

    result = fixture.cli.run("vcs", "commit", "--task-id", "T1", "--id", "developer-1")
    assert result["committed"] is True
    assert result["orphanedUncommittedPaths"] == ["src/Panel/helper.ts"]
    assert "WARNING" in result["message"]
    assert "src/Panel/helper.ts" in result["message"]
    # The owned shell was committed; the unowned new file was left behind in HEAD.
    committed = _git(worktree, "show", "--name-only", "--format=", "HEAD").stdout.split()
    assert committed == ["src/Panel.tsx"]


def test_vcs_commit_does_not_flag_another_tasks_paths_as_orphaned(tmp_path) -> None:
    # A dirty file owned by another task is expected concurrent work, not an
    # orphan, so it must not warn or block this task.
    workspace = tmp_path / "ws"
    _init_git_repo(workspace)
    fixture = _worktree_team(workspace, "alpha")
    fixture.cli.run("init", "--goal", "Build alpha", "--use-worktrees", "true", "--agent", "developer:developer-1")
    fixture.cli.run("plan", "add-task", "--title", "Feature", "--role", "developer", "--task-id", "T1", "--path", "src/feature.ts", "--no-quality-gates")
    fixture.cli.run("plan", "add-task", "--title", "Other", "--role", "developer", "--task-id", "T2", "--path", "src/other.ts", "--no-quality-gates")
    fixture.cli.run("task", "status", "--task-id", "T1", "--status", "in_progress", "--id", "developer-1")

    worktree = _worktree_dir(fixture)
    (worktree / "src").mkdir(parents=True, exist_ok=True)
    (worktree / "src" / "feature.ts").write_text("export const f = 1\n", encoding="utf-8")
    # Dirty file belongs to T2 (another task), not an orphan.
    (worktree / "src" / "other.ts").write_text("export const o = 2\n", encoding="utf-8")

    result = fixture.cli.run("vcs", "commit", "--task-id", "T1", "--id", "developer-1")
    assert result["committed"] is True
    assert result["orphanedUncommittedPaths"] == []
    assert "WARNING" not in result["message"]


def test_task_publish_blocks_on_orphaned_uncommitted_paths(tmp_path) -> None:
    workspace = tmp_path / "ws"
    _init_git_repo(workspace)
    fixture = _worktree_team(workspace, "alpha")
    fixture.cli.run("init", "--goal", "Build alpha", "--use-worktrees", "true", "--agent", "developer:developer-1")
    fixture.cli.run("plan", "add-task", "--title", "Panel", "--role", "developer", "--task-id", "T1", "--path", "src/Panel.tsx", "--no-quality-gates")
    fixture.cli.run("task", "status", "--task-id", "T1", "--status", "in_progress", "--id", "developer-1")

    worktree = _worktree_dir(fixture)
    (worktree / "src").mkdir(parents=True, exist_ok=True)
    (worktree / "src" / "Panel.tsx").write_text("export { f } from './Panel/helper'\n", encoding="utf-8")
    (worktree / "src" / "Panel").mkdir(parents=True, exist_ok=True)
    (worktree / "src" / "Panel" / "helper.ts").write_text("export const f = 1\n", encoding="utf-8")

    failure = fixture.cli.run_failure(
        "task", "publish", "--task-id", "T1", "--id", "developer-1", "--summary", "Split the panel."
    )
    assert "Cannot publish" in failure.stderr
    assert "src/Panel/helper.ts" in failure.stderr

    # After the author owns the new directory, publish succeeds and the tree is clean.
    fixture.cli.run(
        "plan", "update-task", "--task-id", "T1", "--path", "src/Panel.tsx", "--path", "src/Panel", "--force"
    )
    published = fixture.cli.run(
        "task", "publish", "--task-id", "T1", "--id", "developer-1", "--summary", "Split the panel."
    )
    assert published["ok"] is True
    # Both files are now tracked and nothing is left dirty in the shared worktree.
    tracked = _git(worktree, "ls-files").stdout.split()
    assert "src/Panel.tsx" in tracked
    assert "src/Panel/helper.ts" in tracked
    assert _git(worktree, "status", "--porcelain").stdout.strip() == ""


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
    persisted = next(task for task in read_state(fixture.state_path)["tasks"] if task.get("id") == "T1")
    assert result["commitSha"] in persisted["evidence"]["commits"]


def test_mcp_task_publish_commits_task_paths_before_routing(tmp_path) -> None:
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
    persisted = next(task for task in read_state(fixture.state_path)["tasks"] if task.get("id") == "T1")
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


def _completed_worktree_run(workspace: Path):
    _init_git_repo(workspace)
    fixture = _worktree_team(workspace, "alpha")
    fixture.cli.run("init", "--goal", "Build alpha", "--use-worktrees", "true", "--agent", "developer:developer-1")
    fixture.cli.run("plan", "add-task", "--title", "Feature", "--role", "developer", "--task-id", "T1", "--path", "src/feature.ts", "--no-quality-gates")
    fixture.cli.run("task", "status", "--task-id", "T1", "--status", "in_progress", "--id", "developer-1")
    worktree = _worktree_dir(fixture)
    (worktree / "src").mkdir(parents=True, exist_ok=True)
    (worktree / "src" / "feature.ts").write_text("export const f = 1\n", encoding="utf-8")
    fixture.cli.run("task", "publish", "--task-id", "T1", "--id", "developer-1", "--summary", "Done.")
    return fixture, worktree


def test_finalize_completed_run_opens_pull_request(tmp_path, monkeypatch) -> None:
    import sprintengine_core.tool.shell as shell_mod
    from sprintengine_core.store import normalize_runner_policy
    from sprintengine_core.tool.commands.run import finalize_completed_run

    workspace = tmp_path / "ws"
    fixture, _ = _completed_worktree_run(workspace)

    calls = {"count": 0}

    def fake_pr(state, state_path, **kwargs):
        calls["count"] += 1
        vcs = state["sprintengine"]["vcs"]
        vcs["pullRequestUrl"] = "https://github.com/acme/multicode/pull/7"
        vcs["status"] = "pr_opened"
        return {"ok": True, "pullRequestUrl": "https://github.com/acme/multicode/pull/7", "branch": "sprintengine/alpha"}

    monkeypatch.setattr(shell_mod, "create_run_pull_request", fake_pr)

    state = read_state(fixture.state_path)
    result = finalize_completed_run(state, fixture.state_path, normalize_runner_policy({}))

    assert result["blocked"] is False
    assert result["pullRequestUrl"] == "https://github.com/acme/multicode/pull/7"
    assert "pull request" in result["message"].lower()
    assert calls["count"] == 1


def test_finalize_completed_run_blocks_on_orphaned_changes(tmp_path, monkeypatch) -> None:
    import sprintengine_core.tool.shell as shell_mod
    from sprintengine_core.store import normalize_runner_policy
    from sprintengine_core.tool.commands.run import finalize_completed_run

    workspace = tmp_path / "ws"
    fixture, worktree = _completed_worktree_run(workspace)
    # A change owned by no task is left uncommitted in the worktree.
    (worktree / "src" / "orphan").mkdir(parents=True, exist_ok=True)
    (worktree / "src" / "orphan" / "extra.ts").write_text("export const x = 1\n", encoding="utf-8")

    def boom(*args, **kwargs):
        raise AssertionError("create_run_pull_request must not run when changes are orphaned")

    monkeypatch.setattr(shell_mod, "create_run_pull_request", boom)

    state = read_state(fixture.state_path)
    result = finalize_completed_run(state, fixture.state_path, normalize_runner_policy({}))

    assert result["blocked"] is True
    assert result["orphanedUncommittedPaths"] == ["src/orphan/extra.ts"]
    assert "src/orphan/extra.ts" in result["message"]


def test_finalize_completed_run_noop_when_flag_disabled(tmp_path, monkeypatch) -> None:
    import sprintengine_core.tool.shell as shell_mod
    from sprintengine_core.store import normalize_runner_policy
    from sprintengine_core.tool.commands.run import finalize_completed_run

    workspace = tmp_path / "ws"
    fixture, _ = _completed_worktree_run(workspace)

    def boom(*args, **kwargs):
        raise AssertionError("create_run_pull_request must not run when the flag is off")

    monkeypatch.setattr(shell_mod, "create_run_pull_request", boom)

    state = read_state(fixture.state_path)
    policy = normalize_runner_policy({"openPullRequestOnComplete": False})
    result = finalize_completed_run(state, fixture.state_path, policy)

    assert result["blocked"] is False
    assert "pullRequestUrl" not in result
    assert result["message"] == "All Sprint Engine tasks are done. Stop now."


def test_finalize_completed_run_is_idempotent_when_pr_exists(tmp_path, monkeypatch) -> None:
    import sprintengine_core.tool.shell as shell_mod
    from sprintengine_core.store import normalize_runner_policy
    from sprintengine_core.tool.commands.run import finalize_completed_run

    workspace = tmp_path / "ws"
    fixture, _ = _completed_worktree_run(workspace)

    def boom(*args, **kwargs):
        raise AssertionError("create_run_pull_request must not run when a PR already exists")

    monkeypatch.setattr(shell_mod, "create_run_pull_request", boom)

    state = read_state(fixture.state_path)
    state["sprintengine"]["vcs"]["pullRequestUrl"] = "https://github.com/acme/multicode/pull/3"
    result = finalize_completed_run(state, fixture.state_path, normalize_runner_policy({}))

    assert result["blocked"] is False
    assert result["alreadyExists"] is True
    assert result["pullRequestUrl"] == "https://github.com/acme/multicode/pull/3"


def test_finalize_completed_run_survives_pr_failure(tmp_path, monkeypatch) -> None:
    # gh missing / push failure must not block a completed run from completing.
    import sprintengine_core.tool.shell as shell_mod
    from sprintengine_core.store import normalize_runner_policy
    from sprintengine_core.tool.commands.run import finalize_completed_run

    workspace = tmp_path / "ws"
    fixture, _ = _completed_worktree_run(workspace)

    def raising_pr(*args, **kwargs):
        raise SystemExit("GitHub CLI executable 'gh' was not found; cannot create a pull request.")

    monkeypatch.setattr(shell_mod, "create_run_pull_request", raising_pr)

    state = read_state(fixture.state_path)
    result = finalize_completed_run(state, fixture.state_path, normalize_runner_policy({}))

    assert result["blocked"] is False
    assert "gh" in result["pullRequestError"]
    assert "Stop now." in result["message"]
