"""Shared run-worktree mode: creation, per-task locked commits, and PR helper."""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from helpers import SwarmCli, SwarmTeamFixture, base_state, get_task, read_state, write_state
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


def test_init_base_start_point_branches_from_it_but_keeps_plain_base_ref(tmp_path) -> None:
    """Chained sprints (MC-1438): the worktree branches FROM the start point, while
    the stored baseRef — the future `gh pr create --base` value — stays the plain
    local branch name. A stale local checkout must not leak into the new run."""
    workspace = tmp_path / "ws"
    _init_git_repo(workspace)
    # Simulate a refreshed remote-tracking ref that is ahead of the local branch:
    # an extra commit on a side ref, while `main` stays at the seed commit.
    _git(workspace, "checkout", "-qb", "refreshed")
    (workspace / "merged-work.md").write_text("landed upstream\n", encoding="utf-8")
    _git(workspace, "add", "-A")
    _git(workspace, "commit", "-qm", "merged upstream work")
    refreshed_sha = _git(workspace, "rev-parse", "HEAD").stdout.strip()
    _git(workspace, "checkout", "-q", "main")

    fixture = _worktree_team(workspace, "chained")
    payload = fixture.cli.run(
        "init", "--goal", "Chained sprint", "--use-worktrees", "true", "--base-start-point", "refreshed"
    )

    vcs = payload["vcs"]
    assert vcs["baseRef"] == "main", "the stored PR base stays the plain branch name"
    worktree = _worktree_dir(fixture)
    head = _git(worktree, "rev-parse", "HEAD").stdout.strip()
    assert head == refreshed_sha, "the worktree branches from the start point, not the stale local base"
    assert (worktree / "merged-work.md").exists()


def test_repo_has_run_commits_ignores_upstream_commits_ahead_of_stale_base(tmp_path) -> None:
    """The publish no-commits guard must not count the upstream commits a chained
    run branched from (init --base-start-point) as run commits: the stored baseRef
    stays the stale local branch, and counting base..HEAD alone would push an
    empty branch whose `gh pr create` then fails instead of the clean skip."""
    from sprintengine_core.tool.shell import _repo_has_run_commits

    workspace = tmp_path / "ws"
    _init_git_repo(workspace)
    remote = tmp_path / "remote.git"
    _git(tmp_path, "init", "-q", "--bare", str(remote))
    _git(workspace, "remote", "add", "origin", str(remote))
    _git(workspace, "push", "-qu", "origin", "main")

    # Advance origin/main past the local main (the merged previous sprint).
    _git(workspace, "checkout", "-qb", "ahead")
    (workspace / "merged-work.md").write_text("landed upstream\n", encoding="utf-8")
    _git(workspace, "add", "-A")
    _git(workspace, "commit", "-qm", "merged upstream work")
    _git(workspace, "push", "-q", "origin", "ahead:main")
    _git(workspace, "checkout", "-q", "main")
    _git(workspace, "fetch", "-q", "origin")

    fixture = _worktree_team(workspace, "chained-guard")
    fixture.cli.run(
        "init", "--goal", "Chained sprint", "--use-worktrees", "true", "--base-start-point", "origin/main"
    )
    worktree = _worktree_dir(fixture)

    assert _repo_has_run_commits(worktree, "main") is False, (
        "upstream commits the stale local base is missing are not run commits"
    )

    (worktree / "run-work.md").write_text("made by the run\n", encoding="utf-8")
    _git(worktree, "add", "-A")
    _git(worktree, "commit", "-qm", "run work")
    assert _repo_has_run_commits(worktree, "main") is True, "a real run commit still counts"


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


def test_run_completes_at_the_last_publish_with_no_backstop_commit(tmp_path, monkeypatch) -> None:
    # MC-1827: the run-level finalize path is gone. Completion is whatever
    # `recompute_phase` rolls up when the last task lands, the branch is already
    # PR-ready because every task committed its own scope on the way through, and
    # nothing commits or opens a pull request on the run's behalf.
    import sprintengine_core.tool.shell as shell_mod

    workspace = tmp_path / "ws"

    def boom(*args, **kwargs):
        raise AssertionError("completion must not open a pull request automatically")

    monkeypatch.setattr(shell_mod, "create_run_pull_request", boom)

    fixture, _ = _completed_worktree_run(workspace)

    state = read_state(fixture.state_path)
    assert state["sprintengine"]["status"] == "completed"
    assert get_task(state, "T1")["status"] == "done"
    # The owner committed under its own actor; no `sprintengine` backstop commit
    # ever fired, and the feature file is on the branch regardless.
    commit_actors = {
        event.get("actor")
        for event in state.get("events", [])
        if event.get("type") == "task_changes_committed"
    }
    assert commit_actors == {"developer-1"}
    assert fixture.cli.run("vcs", "status")["clean"] is True


def test_run_summary_reports_orphaned_changes_no_task_owns(tmp_path) -> None:
    # The run-level orphan scan outlived the join path it used to hang off: the
    # summary is where the operator decides the run is deliverable, so that is
    # where work no task will ever commit has to surface.
    workspace = tmp_path / "ws"
    fixture, worktree = _completed_worktree_run(workspace)

    assert fixture.cli.run("summary")["orphanedUncommittedPaths"] == []

    (worktree / "src" / "orphan").mkdir(parents=True, exist_ok=True)
    (worktree / "src" / "orphan" / "extra.ts").write_text("export const x = 1\n", encoding="utf-8")

    summary = fixture.cli.run("summary")
    assert summary["orphanedUncommittedPaths"] == [{"repo": "primary", "path": "src/orphan/extra.ts"}]


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
    # No pull request was ever opened for this run, so there is no pull-request
    # state to report — reporting "open" here is what let a lane read a pull
    # request that did not exist (MC-1909).
    assert before["pullRequestState"] is None

    # Merge the run branch into main in the workspace checkout.
    _git(workspace, "merge", "--no-edit", "sprintengine/alpha")

    state = read_state(fixture.state_path)
    after = refresh_run_pull_request_state(state, fixture.state_path)
    assert after["pullRequestState"] == "merged"
    assert state["sprintengine"]["vcs"]["pullRequestState"] == "merged"


def test_vcs_pr_status_cli_reports_no_pull_request_before_one_is_opened(tmp_path) -> None:
    # `pr-status` is enabled (this is a worktree run) but the run has no pull
    # request yet, and says so. It used to answer "open", which is the null-url /
    # null-error / open-state contradiction MC-1909 was filed on — reachable with
    # no `gh` involvement at all, because `observeRun` fires this probe on every
    # completed worktree run.
    workspace = tmp_path / "ws"
    fixture, _ = _completed_worktree_run(workspace)

    result = fixture.cli.run("vcs", "pr-status")
    assert result["enabled"] is True
    assert result["pullRequestState"] is None


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
    from sprintengine_core.tool.shell import cleanup_merged_worktree, set_repo_pull_request

    workspace = tmp_path / "ws"
    fixture, worktree = _completed_worktree_run(workspace)
    assert worktree.exists()

    state = read_state(fixture.state_path)
    set_repo_pull_request(state["sprintengine"]["vcs"], "primary", url=None, state="merged", error=None)
    result = cleanup_merged_worktree(state, fixture.state_path)
    assert result["removed"] is True
    assert not worktree.exists()


def test_cleanup_merged_worktree_keeps_dirty_worktree(tmp_path) -> None:
    from sprintengine_core.tool.shell import cleanup_merged_worktree, set_repo_pull_request

    workspace = tmp_path / "ws"
    fixture, worktree = _completed_worktree_run(workspace)
    (worktree / "uncommitted.txt").write_text("wip\n", encoding="utf-8")

    state = read_state(fixture.state_path)
    set_repo_pull_request(state["sprintengine"]["vcs"], "primary", url=None, state="merged", error=None)
    result = cleanup_merged_worktree(state, fixture.state_path)
    assert result["removed"] is False
    assert result["reason"] == "dirty"
    assert worktree.exists()
