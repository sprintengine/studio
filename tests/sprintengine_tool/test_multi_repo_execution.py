"""Execution seams resolving through the task's repo (MC-1611).

A run spans projects; a task targets exactly one of them. Every seam that reads or
writes a task's changes — the commit, the publish guard, diff evidence, the orphan
scans, `vcs status` — must resolve the tree from the TASK, not from the run. The
failures these tests pin are all the same shape: a sibling task's work silently
resolving against the primary checkout, where its paths do not exist.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from helpers import SwarmCli, SwarmTeamFixture, base_state, read_state, write_state
from sprintengine_core import store as folder_store
from sprintengine_core.tool import shell


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


def _two_project_run(tmp_path: Path) -> tuple[SwarmTeamFixture, Path, Path]:
    """A real run over two real projects: the workspace plus a sibling `mobile`."""
    workspace = tmp_path / "ws"
    sibling = tmp_path / "multicode-mobile"
    _init_git_repo(workspace)
    _init_git_repo(sibling)
    team_dir = workspace / ".multi-code" / "sprintengine" / "alpha"
    state_path = team_dir / "run.yaml"
    write_state(state_path, base_state("alpha", []))
    fixture = SwarmTeamFixture(team_dir=team_dir, state_path=state_path, cli=SwarmCli(state_path, cwd=workspace))
    fixture.cli.run(
        "init", "--goal", "Span two projects",
        "--use-worktrees", "true",
        "--agent", "developer:developer-1",
        "--repo", "mobile=../multicode-mobile",
    )
    return fixture, workspace, sibling


def _close_plan_gate(fixture: SwarmTeamFixture) -> None:
    fixture.cli.run("task", "status", "--task-id", "T0", "--status", "done", "--id", "architect-1")


def _claim(fixture: SwarmTeamFixture, task_id: str, agent_id: str) -> None:
    claimed = fixture.cli.run("task", "next", "--role", "developer", "--id", agent_id)
    assert claimed["claimed"] is True
    assert claimed["task"]["id"] == task_id


def _write(worktree: Path, relative: str, body: str) -> None:
    path = worktree / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")


# --- the sibling task commits to the sibling project ------------------------


def test_sibling_task_commits_only_its_paths_to_the_sibling_project(tmp_path) -> None:
    # AC1: claim + edit + publish in the mobile worktree lands the task's paths on
    # sprintengine/alpha in multicode-mobile — and nothing else, in no other tree.
    fixture, workspace, sibling = _two_project_run(tmp_path)
    fixture.cli.run(
        "plan", "add-task", "--title", "Mobile screen", "--role", "developer",
        "--task-id", "T1", "--repo", "mobile", "--path", "app/screen.ts",
    )
    _close_plan_gate(fixture)
    _claim(fixture, "T1", "developer-1")

    mobile_worktree = fixture.team_dir / "worktree-mobile"
    _write(mobile_worktree, "app/screen.ts", "export const screen = 1\n")
    # Dirty noise this task does not own, elsewhere in the same tree.
    _write(mobile_worktree, "notes/unrelated.md", "scratch\n")

    published = fixture.cli.run(
        "task", "publish", "--task-id", "T1", "--id", "developer-1",
        "--summary", "Add the screen.", "--path", "app/screen.ts",
    )
    assert published["ok"] is True

    # The commit is on the run branch in the SIBLING project, carrying only the
    # task's own path.
    head = _git(mobile_worktree, "show", "--name-only", "--format=", "HEAD").stdout.split()
    assert head == ["app/screen.ts"]
    assert _git(mobile_worktree, "branch", "--show-current").stdout.strip() == "sprintengine/alpha"
    assert "sprintengine/alpha" in _git(sibling, "branch", "--list").stdout
    # The primary project's branch never saw this task at all.
    primary_log = _git(fixture.team_dir / "worktree", "log", "--oneline").stdout
    assert "T1" not in primary_log

    # Diff evidence was read from the sibling tree, not from the primary one (where
    # app/screen.ts does not exist and the diff would have come back empty).
    task = next(t for t in read_state(fixture.state_path)["tasks"] if t["id"] == "T1")
    assert [diff["path"] for diff in task["evidence"]["diffs"]] == ["app/screen.ts"]
    assert task["evidence"]["commits"]


def test_sibling_commit_records_its_own_repo_status_not_the_primarys(tmp_path) -> None:
    # The flat vcs block is the primary project's — what the app, the PR paths, and
    # the mobile snapshot read. A sibling's commit must not report itself there.
    fixture, _, _ = _two_project_run(tmp_path)
    fixture.cli.run(
        "plan", "add-task", "--title", "Mobile screen", "--role", "developer",
        "--task-id", "T1", "--repo", "mobile", "--path", "app/screen.ts",
    )
    _close_plan_gate(fixture)
    _claim(fixture, "T1", "developer-1")
    _write(fixture.team_dir / "worktree-mobile", "app/screen.ts", "export const screen = 1\n")

    result = fixture.cli.run("vcs", "commit", "--task-id", "T1", "--id", "developer-1")
    assert result["committed"] is True
    assert result["repo"] == "mobile"
    assert result["worktreePath"] == ".multi-code/sprintengine/alpha/worktree-mobile"

    vcs = read_state(fixture.state_path)["sprintengine"]["vcs"]
    mobile = next(repo for repo in vcs["repos"] if repo["id"] == "mobile")
    assert mobile["status"] == "committed"
    assert mobile["lastCommitSha"] == result["commitSha"]
    # The primary tree committed nothing, so its status and last commit are untouched.
    assert vcs["status"] == "ready"
    assert vcs["lastCommitSha"] is None
    assert vcs["repos"][0]["lastCommitSha"] is None


# --- orphan protection, per tree -------------------------------------------


def test_publish_guard_blocks_on_an_orphan_in_the_sibling_tree(tmp_path) -> None:
    # AC2: orphan protection is live in the sibling tree — an unowned new file beside
    # the task's own work blocks its publish there exactly as it does in the primary.
    fixture, _, _ = _two_project_run(tmp_path)
    fixture.cli.run(
        "plan", "add-task", "--title", "Mobile panel", "--role", "developer",
        "--task-id", "T1", "--repo", "mobile", "--path", "app/Panel.tsx",
    )
    _close_plan_gate(fixture)
    _claim(fixture, "T1", "developer-1")

    mobile_worktree = fixture.team_dir / "worktree-mobile"
    _write(mobile_worktree, "app/Panel.tsx", "export { f } from './Panel/helper'\n")
    _write(mobile_worktree, "app/Panel/helper.ts", "export const f = 1\n")

    failure = fixture.cli.run_failure(
        "task", "publish", "--task-id", "T1", "--id", "developer-1", "--summary", "Split the panel."
    )
    assert "Cannot publish" in failure.stderr
    assert "app/Panel/helper.ts" in failure.stderr


def test_publish_guard_ignores_an_orphan_in_a_project_the_task_does_not_touch(tmp_path) -> None:
    # AC2: the guard scans ONLY the task's tree. A task cannot answer for a project
    # it does not work in, so another tree's orphan must not block its publish.
    fixture, _, _ = _two_project_run(tmp_path)
    fixture.cli.run(
        "plan", "add-task", "--title", "Mobile screen", "--role", "developer",
        "--task-id", "T1", "--repo", "mobile", "--path", "app/screen.ts",
    )
    _close_plan_gate(fixture)
    _claim(fixture, "T1", "developer-1")

    _write(fixture.team_dir / "worktree-mobile", "app/screen.ts", "export const screen = 1\n")
    # An orphan in the PRIMARY tree, in a directory no task owns.
    _write(fixture.team_dir / "worktree", "app/stray.ts", "export const stray = 3\n")

    published = fixture.cli.run(
        "task", "publish", "--task-id", "T1", "--id", "developer-1", "--summary", "Add the screen."
    )
    assert published["ok"] is True


def test_owned_paths_do_not_excuse_the_same_path_in_another_project(tmp_path) -> None:
    # ownedPaths are repo-relative: a primary task owning app/screen.ts says nothing
    # about the mobile tree's app/screen.ts, which is owned by nobody and would be
    # dropped from the run.
    fixture, _, _ = _two_project_run(tmp_path)
    fixture.cli.run(
        "plan", "add-task", "--title", "Primary screen", "--role", "developer",
        "--task-id", "T1", "--path", "app/screen.ts",
    )
    state = read_state(fixture.state_path)
    _write(fixture.team_dir / "worktree-mobile", "app/screen.ts", "export const screen = 1\n")

    mobile = next(repo for repo in state["sprintengine"]["vcs"]["repos"] if repo["id"] == "mobile")
    assert shell.worktree_orphaned_dirty_paths(state, fixture.state_path, mobile) == ["app/screen.ts"]


def test_run_completion_blocks_on_an_orphan_in_any_declared_project(tmp_path) -> None:
    # AC3: the completion scan covers every declared tree and names the project the
    # operator has to go look in.
    from sprintengine_core.tool.commands.run import finalize_completed_run
    from sprintengine_core.store import normalize_runner_policy

    fixture, _, _ = _two_project_run(tmp_path)
    fixture.cli.run(
        "plan", "add-task", "--title", "Mobile screen", "--role", "developer",
        "--task-id", "T1", "--repo", "mobile", "--path", "app/screen.ts",
    )
    _close_plan_gate(fixture)
    _claim(fixture, "T1", "developer-1")
    _write(fixture.team_dir / "worktree-mobile", "app/screen.ts", "export const screen = 1\n")
    fixture.cli.run("task", "publish", "--task-id", "T1", "--id", "developer-1", "--summary", "Add the screen.")
    fixture.cli.run("task", "status", "--task-id", "T1", "--status", "done", "--id", "developer-1")

    # A change owned by no task, left behind in the SIBLING tree.
    _write(fixture.team_dir / "worktree-mobile", "app/orphan/extra.ts", "export const x = 1\n")

    state = read_state(fixture.state_path)
    result = finalize_completed_run(state, fixture.state_path, normalize_runner_policy({}))

    assert result["blocked"] is True
    assert result["orphanedByRepo"] == [{"repo": "mobile", "path": "app/orphan/extra.ts"}]
    assert "mobile: app/orphan/extra.ts" in result["message"]


# --- lock isolation ---------------------------------------------------------


def _impatient_recording_locks(monkeypatch) -> list[Path]:
    """Record every commit lock taken, and never wait 30s on a held one."""
    taken: list[Path] = []
    real = folder_store.FolderLock

    class Recording(real):  # type: ignore[misc, valid-type]
        def __init__(self, path: Path, **kwargs) -> None:
            taken.append(path)
            super().__init__(path, **{**kwargs, "timeout": 1.0})

    monkeypatch.setattr(folder_store, "FolderLock", Recording)
    return taken


def _two_repo_tasks(fixture: SwarmTeamFixture) -> None:
    fixture.cli.run(
        "plan", "add-task", "--title", "Mobile screen", "--role", "developer",
        "--task-id", "T1", "--repo", "mobile", "--path", "app/screen.ts",
    )
    fixture.cli.run(
        "plan", "add-task", "--title", "Primary screen", "--role", "developer",
        "--task-id", "T2", "--path", "src/screen.ts",
    )
    _write(fixture.team_dir / "worktree-mobile", "app/screen.ts", "export const screen = 1\n")
    _write(fixture.team_dir / "worktree", "src/screen.ts", "export const screen = 2\n")


def test_each_repo_commits_under_its_own_lock(tmp_path, monkeypatch) -> None:
    # AC4: the lock is per repo. One run-wide lock would serialize two unrelated
    # git indexes, so which lock a commit takes IS the isolation contract.
    fixture, _, _ = _two_project_run(tmp_path)
    _two_repo_tasks(fixture)
    taken = _impatient_recording_locks(monkeypatch)

    state = read_state(fixture.state_path)
    for task_id in ("T1", "T2"):
        task = next(t for t in state["tasks"] if t["id"] == task_id)
        assert shell.commit_run_worktree_paths(state, fixture.state_path, task, "developer-1")

    assert [path.name for path in taken] == ["git.commit.mobile.lock", "git.commit.primary.lock"]
    assert all(path.parent == fixture.team_dir / "runner" for path in taken)


def test_a_commit_does_not_wait_on_another_repos_lock(tmp_path, monkeypatch) -> None:
    # AC4 behaviourally: with the primary project's commit lock genuinely held, a
    # mobile commit still goes through instead of queueing behind it.
    fixture, _, _ = _two_project_run(tmp_path)
    _two_repo_tasks(fixture)
    primary_lock = folder_store.FolderLock(fixture.team_dir / folder_store.git_commit_lock_file("primary"))
    primary_lock.acquire()
    _impatient_recording_locks(monkeypatch)
    try:
        state = read_state(fixture.state_path)
        mobile_task = next(t for t in state["tasks"] if t["id"] == "T1")
        sha = shell.commit_run_worktree_paths(state, fixture.state_path, mobile_task, "developer-1")
    finally:
        primary_lock.release()

    assert sha


def test_a_commit_waits_on_its_own_repos_lock(tmp_path, monkeypatch) -> None:
    # The other half of AC4: isolation is per repo, not per commit. Two agents in
    # the SAME project share one index and must still take turns.
    fixture, _, _ = _two_project_run(tmp_path)
    _two_repo_tasks(fixture)
    mobile_lock = folder_store.FolderLock(fixture.team_dir / folder_store.git_commit_lock_file("mobile"))
    mobile_lock.acquire()
    _impatient_recording_locks(monkeypatch)
    try:
        state = read_state(fixture.state_path)
        mobile_task = next(t for t in state["tasks"] if t["id"] == "T1")
        with pytest.raises(TimeoutError):
            shell.commit_run_worktree_paths(state, fixture.state_path, mobile_task, "developer-1")
    finally:
        mobile_lock.release()


# --- pathspec normalization and path containment, per declared root ---------


def test_commit_pathspec_is_normalized_against_each_declared_root(tmp_path) -> None:
    # AC5/AC7: the pathspec is built against the tree the task commits in, and a
    # path that escapes THAT root is dropped — the containment check is per root,
    # never against whichever root happens to be the primary.
    fixture, _, _ = _two_project_run(tmp_path)
    state = read_state(fixture.state_path)
    repos = {repo["id"]: repo for repo in state["sprintengine"]["vcs"]["repos"]}
    primary_worktree = fixture.team_dir / "worktree"
    mobile_worktree = fixture.team_dir / "worktree-mobile"

    for worktree in (primary_worktree, mobile_worktree):
        assert shell._normalize_commit_pathspec(worktree, ["app/screen.ts", "app/screen.ts"]) == ["app/screen.ts"]
        assert shell._normalize_commit_pathspec(worktree, ["app/"]) == ["app"]
        # Absolute, parent-traversal, and blank entries never reach git.
        assert shell._normalize_commit_pathspec(worktree, [str(worktree / "app/screen.ts")]) == []
        assert shell._normalize_commit_pathspec(worktree, ["../worktree/app/screen.ts"]) == []
        assert shell._normalize_commit_pathspec(worktree, ["  "]) == []

    # A path that resolves outside a declared root is refused for that root even
    # though it names a real file inside the OTHER declared root.
    escape = f"../{mobile_worktree.name}/app/screen.ts"
    assert shell._normalize_commit_pathspec(primary_worktree, [escape]) == []
    assert repos["mobile"]["worktreePath"].endswith("worktree-mobile")


def test_task_trees_resolve_from_the_task_repo(tmp_path) -> None:
    # AC7: containment per declared root — each task's tree is its own repo's, and a
    # task naming a repo the run does not declare fails loudly rather than resolving
    # to the primary tree.
    fixture, _, _ = _two_project_run(tmp_path)
    state = read_state(fixture.state_path)

    primary_task = {"id": "T1", "repo": "primary"}
    mobile_task = {"id": "T2", "repo": "mobile"}
    defaulted_task = {"id": "T3"}

    assert shell.worktree_for_task(state, fixture.state_path, primary_task) == fixture.team_dir / "worktree"
    assert shell.worktree_for_task(state, fixture.state_path, mobile_task) == fixture.team_dir / "worktree-mobile"
    assert shell.worktree_for_task(state, fixture.state_path, defaulted_task) == fixture.team_dir / "worktree"

    try:
        shell.worktree_for_task(state, fixture.state_path, {"id": "T4", "repo": "relay"})
    except SystemExit as exc:
        assert "relay" in str(exc)
        assert "primary, mobile" in str(exc)
    else:
        raise AssertionError("a task targeting an undeclared project must not resolve to a tree")


# --- vcs status -------------------------------------------------------------


def test_vcs_status_returns_a_block_per_declared_project(tmp_path) -> None:
    # AC6: per-repo blocks.
    fixture, _, _ = _two_project_run(tmp_path)
    _write(fixture.team_dir / "worktree-mobile", "app/dirty.ts", "export const d = 1\n")

    status = fixture.cli.run("vcs", "status")

    assert [repo["id"] for repo in status["repos"]] == ["primary", "mobile"]
    primary, mobile = status["repos"]
    assert primary["clean"] is True
    assert primary["dirtyFiles"] == []
    assert mobile["clean"] is False
    # git collapses an untracked directory to the directory itself.
    assert mobile["dirtyFiles"] == ["?? app/"]
    assert mobile["branchName"] == "sprintengine/alpha"
    # The top-level fields keep describing the primary project.
    assert status["clean"] is True
    assert status["worktreePath"] == ".multi-code/sprintengine/alpha/worktree"


def test_vcs_status_for_a_single_project_run_is_unchanged(tmp_path) -> None:
    # AC6: a run that declares nothing reports exactly what it always did, plus the
    # one block that says the same thing.
    workspace = tmp_path / "ws"
    _init_git_repo(workspace)
    team_dir = workspace / ".multi-code" / "sprintengine" / "solo"
    state_path = team_dir / "run.yaml"
    write_state(state_path, base_state("solo", []))
    fixture = SwarmTeamFixture(team_dir=team_dir, state_path=state_path, cli=SwarmCli(state_path, cwd=workspace))
    fixture.cli.run("init", "--goal", "One project", "--use-worktrees", "true")
    _write(team_dir / "worktree", "src/dirty.ts", "export const d = 1\n")

    status = fixture.cli.run("vcs", "status")

    assert status["enabled"] is True
    assert status["worktreePath"] == ".multi-code/sprintengine/solo/worktree"
    assert status["branchName"] == "sprintengine/solo"
    assert status["clean"] is False
    assert status["dirtyFiles"] == ["?? src/"]
    assert [repo["id"] for repo in status["repos"]] == ["primary"]
    assert status["repos"][0]["dirtyFiles"] == status["dirtyFiles"]
