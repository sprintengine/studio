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


def _claim(fixture: SwarmTeamFixture, task_id: str, agent_id: str, role: str = "developer") -> None:
    """Close the architect plan gate, then let `agent_id` claim `task_id` for real.

    Post-MC-1542 `task status --status in_progress` no longer force-starts a
    never-claimed task (an unowned `in_progress` task is unclaimable, so it is
    returned to `todo`). A real claim is the only way into `in_progress`.
    """
    fixture.cli.run("task", "status", "--task-id", "T0", "--status", "done", "--id", "architect-1")
    claimed = fixture.cli.run("task", "next", "--role", role, "--id", agent_id)
    assert claimed["claimed"] is True
    assert claimed["task"]["id"] == task_id
    assert claimed["task"]["status"] == "in_progress"
    assert claimed["task"]["ownerAgentId"] == agent_id


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
    fixture.cli.run("plan", "add-task", "--title", "Feature", "--role", "developer", "--task-id", "T1", "--path", "src/feature.ts")
    _claim(fixture, "T1", "developer-1")

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
    fixture.cli.run("plan", "add-task", "--title", "Feature", "--role", "developer", "--task-id", "T1", "--path", "src/feature.ts")
    _claim(fixture, "T1", "developer-1")

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
    fixture.cli.run("plan", "add-task", "--title", "Panel", "--role", "developer", "--task-id", "T1", "--path", "src/Panel.tsx")
    _claim(fixture, "T1", "developer-1")

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
    fixture.cli.run("plan", "add-task", "--title", "Feature", "--role", "developer", "--task-id", "T1", "--path", "src/feature.ts")
    fixture.cli.run("plan", "add-task", "--title", "Other", "--role", "developer", "--task-id", "T2", "--path", "src/other.ts")
    _claim(fixture, "T1", "developer-1")

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
    fixture.cli.run("plan", "add-task", "--title", "Panel", "--role", "developer", "--task-id", "T1", "--path", "src/Panel.tsx")
    _claim(fixture, "T1", "developer-1")

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
    fixture.cli.run("plan", "add-task", "--title", "Feature", "--role", "developer", "--task-id", "T1", "--path", "src/feature.ts")
    _claim(fixture, "T1", "developer-1")

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
    fixture.cli.run("plan", "add-task", "--title", "Feature", "--role", "developer", "--task-id", "T1", "--path", "src/feature.ts")
    _claim(fixture, "T1", "developer-1")

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

    # The commit lands BEFORE routing, so worktree-mode change detection reads it
    # off `evidence.commits` and routes the task into its review phase, owner intact.
    assert result["committed"] is True
    assert result["commitSha"]
    assert result["producedChanges"] is True
    assert result["nextStatus"] == "review"
    assert result["nextDirective"]
    committed = _git(worktree, "show", "--name-only", "--format=", "HEAD").stdout.split()
    assert committed == ["src/feature.ts"]
    status = _git(worktree, "status", "--porcelain").stdout
    assert "unrelated.txt" in status
    persisted = next(task for task in read_state(fixture.state_path)["tasks"] if task.get("id") == "T1")
    assert result["commitSha"] in persisted["evidence"]["commits"]
    assert persisted["ownerAgentId"] == "developer-1"


def test_mcp_task_publish_commits_task_paths_before_routing(tmp_path) -> None:
    workspace = tmp_path / "ws"
    _init_git_repo(workspace)
    fixture = _worktree_team(workspace, "alpha")
    fixture.cli.run("init", "--goal", "Build alpha", "--use-worktrees", "true", "--agent", "developer:developer-1")
    fixture.cli.run("plan", "add-task", "--title", "Feature", "--role", "developer", "--task-id", "T1", "--path", "src/feature.ts")
    _claim(fixture, "T1", "developer-1")

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
    assert published["result"]["taskStatus"] == "review"
    assert published["result"]["producedChanges"] is True
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
    fixture.cli.run("plan", "add-task", "--title", "Feature", "--role", "developer", "--task-id", "T1", "--path", "src/feature.ts")
    _claim(fixture, "T1", "developer-1")
    worktree = _worktree_dir(fixture)
    (worktree / "src").mkdir(parents=True, exist_ok=True)
    (worktree / "src" / "feature.ts").write_text("export const f = 1\n", encoding="utf-8")
    fixture.cli.run("task", "publish", "--task-id", "T1", "--id", "developer-1", "--summary", "Done.")
    # The diff routes T1 into review; its owner closes the phase to reach `done`.
    fixture.cli.run(
        "task", "advance",
        "--task-id", "T1", "--id", "developer-1",
        "--phase", "review", "--outcome", "pass", "--summary", "Self-reviewed.",
    )
    return fixture, worktree


def test_finalize_completed_run_does_not_open_pull_request(tmp_path, monkeypatch) -> None:
    # PR creation is user-initiated (the run-summary button), never automatic on
    # completion. Finalize only backstop-commits and reports.
    import sprintengine_core.tool.shell as shell_mod
    from sprintengine_core.store import normalize_runner_policy
    from sprintengine_core.tool.commands.run import finalize_completed_run

    workspace = tmp_path / "ws"
    fixture, _ = _completed_worktree_run(workspace)

    def boom(*args, **kwargs):
        raise AssertionError("finalize must not open a pull request automatically")

    monkeypatch.setattr(shell_mod, "create_run_pull_request", boom)

    state = read_state(fixture.state_path)
    result = finalize_completed_run(state, fixture.state_path, normalize_runner_policy({}))

    assert result["blocked"] is False
    assert "pullRequestUrl" not in result
    assert "run summary" in result["message"].lower()


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


def test_create_run_pull_request_records_failure_on_push_error(tmp_path) -> None:
    # No 'origin' remote → push fails. The failure must be recorded honestly on the
    # vcs record (status=failed + pullRequestError) so the summary can show it and
    # offer Retry, instead of a silent "pending" forever.
    from sprintengine_core.tool.shell import create_run_pull_request

    workspace = tmp_path / "ws"
    fixture, _ = _completed_worktree_run(workspace)

    state = read_state(fixture.state_path)
    result = create_run_pull_request(state, fixture.state_path)

    assert result["ok"] is False
    assert result["error"]
    vcs = state["sprintengine"]["vcs"]
    assert vcs["status"] == "failed"
    assert vcs["pullRequestError"]


def test_refresh_run_pull_request_state_detects_manual_merge(tmp_path) -> None:
    # A branch merged into its base manually (no PR merge button) must read as
    # merged via the branch-ancestry signal.
    from sprintengine_core.tool.shell import refresh_run_pull_request_state

    workspace = tmp_path / "ws"
    fixture, _ = _completed_worktree_run(workspace)

    state = read_state(fixture.state_path)
    before = refresh_run_pull_request_state(state, fixture.state_path)
    assert before["pullRequestState"] == "open"

    # Merge the run branch into main in the workspace checkout.
    _git(workspace, "merge", "--no-edit", "sprintengine/alpha")

    state = read_state(fixture.state_path)
    after = refresh_run_pull_request_state(state, fixture.state_path)
    assert after["pullRequestState"] == "merged"
    assert state["sprintengine"]["vcs"]["pullRequestState"] == "merged"


def test_vcs_pr_status_cli_reports_open_before_merge(tmp_path) -> None:
    workspace = tmp_path / "ws"
    fixture, _ = _completed_worktree_run(workspace)

    result = fixture.cli.run("vcs", "pr-status")
    assert result["enabled"] is True
    assert result["pullRequestState"] == "open"


def test_build_run_pull_request_body_lists_delivered_tasks(tmp_path) -> None:
    from sprintengine_core.tool.shell import build_run_pull_request_body

    workspace = tmp_path / "ws"
    fixture, _ = _completed_worktree_run(workspace)

    state = read_state(fixture.state_path)
    body = build_run_pull_request_body(state, "sprintengine/alpha")
    assert "**Goal:**" in body
    # T0 (the architect plan gate, closed by `_claim`) and T1 both reached `done`.
    assert "Tasks delivered (2)" in body
    assert "Feature" in body  # the task title
    assert "_(developer)_" in body  # the task role


def test_cleanup_merged_worktree_removes_clean_worktree(tmp_path) -> None:
    from sprintengine_core.tool.shell import cleanup_merged_worktree

    workspace = tmp_path / "ws"
    fixture, worktree = _completed_worktree_run(workspace)
    assert worktree.exists()

    state = read_state(fixture.state_path)
    result = cleanup_merged_worktree(state, fixture.state_path)
    assert result["removed"] is True
    assert not worktree.exists()


def test_cleanup_merged_worktree_keeps_dirty_worktree(tmp_path) -> None:
    from sprintengine_core.tool.shell import cleanup_merged_worktree

    workspace = tmp_path / "ws"
    fixture, worktree = _completed_worktree_run(workspace)
    (worktree / "uncommitted.txt").write_text("wip\n", encoding="utf-8")

    state = read_state(fixture.state_path)
    result = cleanup_merged_worktree(state, fixture.state_path)
    assert result["removed"] is False
    assert result["reason"] == "dirty"
    assert worktree.exists()
