"""On-demand project provisioning via `sprintengine.vcs.request_repo` (MC-1671).

The wizard no longer freezes a run's project set at creation: any joined agent
can bring a new sibling project into a running worktree-mode sprint by naming its
path. Provisioning reuses init's own atomic path — the T5 blast-radius gate
(`_declared_sibling_root`) validates the root, the worktree is created (or an
existing one adopted) under the run dir, and the entry is appended to `vcs.repos`
in one locked section, so a task targeting the new repo is safe the moment the
tool returns.
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from helpers import SwarmCli, SwarmTeamFixture, base_state, read_state, write_state


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


def _two_project_workspace(tmp_path: Path) -> tuple[Path, Path]:
    """The primary project plus a real sibling project beside it."""
    workspace = tmp_path / "ws"
    sibling = tmp_path / "multicode-mobile"
    _init_git_repo(workspace)
    _init_git_repo(sibling)
    return workspace, sibling


def _worktree_team(workspace: Path, name: str) -> SwarmTeamFixture:
    team_dir = workspace / ".multi-code" / "sprintengine" / name
    state_path = team_dir / "run.yaml"
    write_state(state_path, base_state(name, []))
    return SwarmTeamFixture(team_dir=team_dir, state_path=state_path, cli=SwarmCli(state_path, cwd=workspace))


def _worktree_run(tmp_path: Path) -> tuple[SwarmTeamFixture, Path]:
    """A worktree-mode run over just the primary project, ready to expand."""
    workspace, sibling = _two_project_workspace(tmp_path)
    fixture = _worktree_team(workspace, "alpha")
    fixture.cli.run("init", "--goal", "Start with one project", "--use-worktrees", "true")
    return fixture, sibling


# --- provisioning on demand ------------------------------------------------


def test_request_repo_provisions_a_sibling_on_demand(tmp_path) -> None:
    # AC: a mid-run request appends the repo and creates its worktree on the run
    # branch, under the primary run dir — the same shape init would have produced.
    fixture, _ = _worktree_run(tmp_path)

    payload = fixture.cli.run(
        "vcs", "request-repo", "--root", "../multicode-mobile", "--id", "developer-1", "--repo", "mobile",
    )

    assert payload["action"] == "vcs_request_repo"
    assert payload["adopted"] is False
    assert payload["repo"]["id"] == "mobile"
    assert payload["repo"]["root"] == "../multicode-mobile"
    assert payload["repo"]["branchName"] == "sprintengine/alpha"

    vcs = read_state(fixture.state_path)["sprintengine"]["vcs"]
    assert [repo["id"] for repo in vcs["repos"]] == ["primary", "mobile"]
    worktree = fixture.team_dir / "worktree-mobile"
    assert worktree.exists()
    assert _git(worktree, "branch", "--show-current").stdout.strip() == "sprintengine/alpha"


def test_request_repo_derives_the_id_from_the_folder_name(tmp_path) -> None:
    # `--repo` is optional; without it the folder name is the id.
    fixture, _ = _worktree_run(tmp_path)

    payload = fixture.cli.run("vcs", "request-repo", "--root", "../multicode-mobile", "--id", "developer-1")

    assert payload["repo"]["id"] == "multicode-mobile"
    assert (fixture.team_dir / "worktree-multicode-mobile").exists()


# --- idempotency -----------------------------------------------------------


def test_reissuing_request_repo_adopts_the_existing_tree(tmp_path) -> None:
    # AC (D5): a re-issue for an already-declared project adopts its tree and
    # returns success — no duplicate entry, no duplicate-id error.
    fixture, _ = _worktree_run(tmp_path)
    fixture.cli.run("vcs", "request-repo", "--root", "../multicode-mobile", "--id", "developer-1", "--repo", "mobile")

    payload = fixture.cli.run(
        "vcs", "request-repo", "--root", "../multicode-mobile", "--id", "developer-1", "--repo", "mobile",
    )

    assert payload["adopted"] is True
    vcs = read_state(fixture.state_path)["sprintengine"]["vcs"]
    assert [repo["id"] for repo in vcs["repos"]] == ["primary", "mobile"]


def test_reissue_by_path_alone_adopts_regardless_of_name(tmp_path) -> None:
    # The same project path already declared is adopted even when the second call
    # omits the name (folder-derived id would differ from the stored one).
    fixture, _ = _worktree_run(tmp_path)
    fixture.cli.run("vcs", "request-repo", "--root", "../multicode-mobile", "--id", "developer-1", "--repo", "mobile")

    payload = fixture.cli.run("vcs", "request-repo", "--root", "../multicode-mobile", "--id", "developer-1")

    assert payload["adopted"] is True
    assert payload["repo"]["id"] == "mobile"
    vcs = read_state(fixture.state_path)["sprintengine"]["vcs"]
    assert [repo["id"] for repo in vcs["repos"]] == ["primary", "mobile"]


def test_retry_after_a_lost_worktree_recreates_it(tmp_path) -> None:
    # A retry after a partial failure (the entry recorded but the tree gone) must
    # rebuild the tree rather than erroring on the already-declared id.
    fixture, sibling = _worktree_run(tmp_path)
    fixture.cli.run("vcs", "request-repo", "--root", "../multicode-mobile", "--id", "developer-1", "--repo", "mobile")
    worktree = fixture.team_dir / "worktree-mobile"
    shutil.rmtree(worktree)
    _git(sibling, "worktree", "prune")
    assert not worktree.exists()

    payload = fixture.cli.run(
        "vcs", "request-repo", "--root", "../multicode-mobile", "--id", "developer-1", "--repo", "mobile",
    )

    assert payload["adopted"] is True
    assert worktree.exists()
    assert _git(worktree, "branch", "--show-current").stdout.strip() == "sprintengine/alpha"


def test_reusing_a_name_for_a_different_project_is_refused(tmp_path) -> None:
    # Idempotency is by project, not by name: a name already bound to one project
    # cannot be re-pointed at another. That is a contradiction, not a retry.
    fixture, _ = _worktree_run(tmp_path)
    other = tmp_path / "multiauth"
    _init_git_repo(other)
    fixture.cli.run("vcs", "request-repo", "--root", "../multicode-mobile", "--id", "developer-1", "--repo", "mobile")

    failure = fixture.cli.run_failure(
        "vcs", "request-repo", "--root", "../multiauth", "--id", "developer-1", "--repo", "mobile",
    )

    assert "already works in a project named 'mobile'" in failure.stdout + failure.stderr


# --- ordering: a task may target the repo only after it is provisioned ------


def test_a_task_can_target_the_repo_only_after_it_is_provisioned(tmp_path) -> None:
    # AC (D4 ordering): before request_repo the repo is undeclared, so planning a
    # task for it is refused; after request_repo the same plan succeeds. This is
    # what makes provision-then-append the safe order.
    fixture, _ = _worktree_run(tmp_path)

    before = fixture.cli.run_failure(
        "plan", "add-task", "--title", "Touch mobile", "--role", "developer",
        "--description", "Work in the mobile project.", "--repo", "mobile",
    )
    assert "does not work in" in before.stdout + before.stderr

    fixture.cli.run("vcs", "request-repo", "--root", "../multicode-mobile", "--id", "developer-1", "--repo", "mobile")

    fixture.cli.run(
        "plan", "add-task", "--title", "Touch mobile", "--role", "developer",
        "--description", "Work in the mobile project.", "--repo", "mobile",
    )
    tasks = read_state(fixture.state_path)["tasks"]
    assert any(task.get("repo") == "mobile" for task in tasks)


# --- worktree mode required ------------------------------------------------


def test_request_repo_requires_worktree_mode(tmp_path) -> None:
    # A single-repo, non-worktree run has no second tree to add; expansion is
    # refused with a clear reason rather than silently provisioning.
    workspace, _ = _two_project_workspace(tmp_path)
    fixture = _worktree_team(workspace, "alpha")
    fixture.cli.run("init", "--goal", "No worktrees")

    failure = fixture.cli.run_failure(
        "vcs", "request-repo", "--root", "../multicode-mobile", "--id", "developer-1", "--repo", "mobile",
    )

    assert "not in worktree mode" in failure.stdout + failure.stderr
    assert read_state(fixture.state_path)["sprintengine"].get("vcs") is None


# --- the T5 blast-radius gate, enforced on demand --------------------------


def test_request_repo_rejects_the_workspace_itself(tmp_path) -> None:
    fixture, _ = _worktree_run(tmp_path)
    failure = fixture.cli.run_failure("vcs", "request-repo", "--root", ".", "--id", "developer-1", "--repo", "again")
    assert "this project itself" in failure.stdout + failure.stderr


def test_request_repo_rejects_a_path_inside_the_workspace(tmp_path) -> None:
    fixture, _ = _worktree_run(tmp_path)
    nested = fixture.cli.cwd / "vendor" / "inner"
    _init_git_repo(nested)
    failure = fixture.cli.run_failure(
        "vcs", "request-repo", "--root", "vendor/inner", "--id", "developer-1", "--repo", "inner",
    )
    assert "inside this project" in failure.stdout + failure.stderr


def test_request_repo_rejects_a_path_containing_the_workspace(tmp_path) -> None:
    # A parent-of-workspace root pulls the workspace and every neighbour into the
    # run's surface by inclusion — the blast-radius case.
    fixture, _ = _worktree_run(tmp_path)
    _init_git_repo(tmp_path)
    failure = fixture.cli.run_failure(
        "vcs", "request-repo", "--root", "..", "--id", "developer-1", "--repo", "parent",
    )
    assert "contains this project" in failure.stdout + failure.stderr


def test_request_repo_rejects_a_non_git_directory(tmp_path) -> None:
    fixture, _ = _worktree_run(tmp_path)
    (tmp_path / "plain-dir").mkdir()
    failure = fixture.cli.run_failure(
        "vcs", "request-repo", "--root", "../plain-dir", "--id", "developer-1", "--repo", "plain",
    )
    assert "not a git repository" in failure.stdout + failure.stderr


def test_request_repo_rejects_a_plain_file(tmp_path) -> None:
    fixture, _ = _worktree_run(tmp_path)
    (tmp_path / "afile.txt").write_text("x\n", encoding="utf-8")
    failure = fixture.cli.run_failure(
        "vcs", "request-repo", "--root", "../afile.txt", "--id", "developer-1", "--repo", "afile",
    )
    assert "no directory" in failure.stdout + failure.stderr


def test_request_repo_leaves_the_run_unchanged_when_the_gate_rejects(tmp_path) -> None:
    # A rejected request must not half-append: provisioning and the entry write are
    # one locked section, so a gate failure leaves vcs.repos exactly as it was.
    fixture, _ = _worktree_run(tmp_path)
    (tmp_path / "plain-dir").mkdir()

    fixture.cli.run_failure("vcs", "request-repo", "--root", "../plain-dir", "--id", "developer-1", "--repo", "plain")

    vcs = read_state(fixture.state_path)["sprintengine"]["vcs"]
    assert [repo["id"] for repo in vcs["repos"]] == ["primary"]
    assert not list(fixture.team_dir.glob("worktree-*"))


# --- reserved-name guard ---------------------------------------------------


def test_request_repo_refuses_the_reserved_primary_name(tmp_path) -> None:
    fixture, _ = _worktree_run(tmp_path)
    failure = fixture.cli.run_failure(
        "vcs", "request-repo", "--root", "../multicode-mobile", "--id", "developer-1", "--repo", "primary",
    )
    assert "reserved" in failure.stdout + failure.stderr
