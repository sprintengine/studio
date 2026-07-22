"""Repo declaration at init and the per-repo run worktrees it creates (MC-1611).

A run declares the projects it spans once, at creation. Each declared project gets
its own worktree on the run branch, all under the primary run directory so run
discovery and teardown keep one anchor. A declaration that does not name a real,
separate git project aborts init loudly rather than creating a partial run.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from helpers import SwarmCli, SwarmTeamFixture, base_state, read_state, write_state
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


def _worktree_team(workspace: Path, name: str) -> SwarmTeamFixture:
    team_dir = workspace / ".multi-code" / "sprintengine" / name
    state_path = team_dir / "run.yaml"
    write_state(state_path, base_state(name, []))
    return SwarmTeamFixture(team_dir=team_dir, state_path=state_path, cli=SwarmCli(state_path, cwd=workspace))


def _two_project_workspace(tmp_path: Path) -> tuple[Path, Path]:
    """The primary project plus a real sibling project beside it."""
    workspace = tmp_path / "ws"
    sibling = tmp_path / "multicode-mobile"
    _init_git_repo(workspace)
    _init_git_repo(sibling)
    return workspace, sibling


# --- declaration syntax ----------------------------------------------------


def test_repo_declaration_parses_name_and_path() -> None:
    assert shell.parse_repo_declaration("mobile=../multicode-mobile") == {
        "id": "mobile",
        "root": "../multicode-mobile",
    }


@pytest.mark.parametrize("value", ["mobile", "=../x", "mobile=", "", "MOBILE=../x", "-mobile=../x"])
def test_unusable_repo_declarations_are_refused(value: str) -> None:
    with pytest.raises(SystemExit):
        shell.parse_repo_declaration(value)


def test_primary_repo_name_is_reserved() -> None:
    # Entry zero is always this project; a second `primary` would shadow it.
    with pytest.raises(SystemExit) as excinfo:
        shell.parse_repo_declaration("primary=../elsewhere")
    assert "reserved" in str(excinfo.value)


def test_the_same_repo_name_cannot_be_declared_twice() -> None:
    with pytest.raises(SystemExit) as excinfo:
        shell.parse_repo_declarations(["mobile=../a", "mobile=../b"])
    assert "declared twice" in str(excinfo.value)


# --- worktrees per declared repo -------------------------------------------


def test_declared_repo_gets_its_own_worktree_on_the_run_branch(tmp_path) -> None:
    # AC1: a run declaring `mobile` creates <team>/worktree-mobile on the run branch
    # in the sibling project.
    workspace, sibling = _two_project_workspace(tmp_path)
    fixture = _worktree_team(workspace, "alpha")

    payload = fixture.cli.run(
        "init", "--goal", "Span two projects",
        "--use-worktrees", "true",
        "--repo", "mobile=../multicode-mobile",
    )

    repos = payload["vcs"]["repos"]
    assert [repo["id"] for repo in repos] == ["primary", "mobile"]
    assert repos[1]["root"] == "../multicode-mobile"
    assert repos[1]["worktreePath"] == ".multi-code/sprintengine/alpha/worktree-mobile"
    assert repos[1]["branchName"] == "sprintengine/alpha"

    # The sibling's worktree lives under the PRIMARY run dir (one anchor) but is a
    # checkout of the sibling project.
    sibling_worktree = fixture.team_dir / "worktree-mobile"
    assert sibling_worktree.exists()
    assert _git(sibling_worktree, "branch", "--show-current").stdout.strip() == "sprintengine/alpha"
    assert str(sibling_worktree.resolve()) in _git(sibling, "worktree", "list").stdout
    assert str(sibling_worktree.resolve()) not in _git(workspace, "worktree", "list").stdout


def test_each_declared_repo_tracks_its_own_status(tmp_path) -> None:
    # AC3: per-repo status, independent of the flat block's primary status.
    workspace, _ = _two_project_workspace(tmp_path)
    fixture = _worktree_team(workspace, "alpha")

    fixture.cli.run(
        "init", "--goal", "Span two projects",
        "--use-worktrees", "true",
        "--repo", "mobile=../multicode-mobile",
    )

    vcs = read_state(fixture.state_path)["sprintengine"]["vcs"]
    assert [repo["status"] for repo in vcs["repos"]] == ["ready", "ready"]
    assert vcs["status"] == "ready"


def test_more_than_one_sibling_repo_can_be_declared(tmp_path) -> None:
    workspace, _ = _two_project_workspace(tmp_path)
    relay = tmp_path / "multiauth"
    _init_git_repo(relay)
    fixture = _worktree_team(workspace, "alpha")

    payload = fixture.cli.run(
        "init", "--goal", "Span three projects",
        "--use-worktrees", "true",
        "--repo", "mobile=../multicode-mobile",
        "--repo", "relay=../multiauth",
    )

    assert [repo["id"] for repo in payload["vcs"]["repos"]] == ["primary", "mobile", "relay"]
    assert (fixture.team_dir / "worktree-mobile").exists()
    assert (fixture.team_dir / "worktree-relay").exists()


def test_single_repo_run_is_unchanged_by_the_repo_list(tmp_path) -> None:
    # AC6: declaring nothing must produce exactly today's worktree path and branch.
    workspace, _ = _two_project_workspace(tmp_path)
    fixture = _worktree_team(workspace, "alpha")

    payload = fixture.cli.run("init", "--goal", "One project", "--use-worktrees", "true")

    vcs = payload["vcs"]
    assert vcs["worktreePath"] == ".multi-code/sprintengine/alpha/worktree"
    assert vcs["branchName"] == "sprintengine/alpha"
    assert vcs["status"] == "ready"
    assert [repo["id"] for repo in vcs["repos"]] == ["primary"]
    assert (fixture.team_dir / "worktree").exists()
    assert not list(fixture.team_dir.glob("worktree-*"))


def test_declared_repos_survive_a_second_init(tmp_path) -> None:
    # The repo set is fixed at creation: re-running init neither drops the siblings
    # nor re-creates their worktrees.
    workspace, _ = _two_project_workspace(tmp_path)
    fixture = _worktree_team(workspace, "alpha")
    fixture.cli.run(
        "init", "--goal", "Span two projects",
        "--use-worktrees", "true",
        "--repo", "mobile=../multicode-mobile",
    )

    fixture.cli.run("init", "--goal", "Span two projects", "--use-worktrees", "true")

    vcs = read_state(fixture.state_path)["sprintengine"]["vcs"]
    assert [repo["id"] for repo in vcs["repos"]] == ["primary", "mobile"]


def test_a_second_init_re_declaring_the_same_repos_is_a_no_op(tmp_path) -> None:
    # Idempotent: re-passing the projects the run already declares neither refuses
    # nor changes the set.
    workspace, _ = _two_project_workspace(tmp_path)
    fixture = _worktree_team(workspace, "alpha")
    fixture.cli.run(
        "init", "--goal", "Span two projects",
        "--use-worktrees", "true",
        "--repo", "mobile=../multicode-mobile",
    )

    fixture.cli.run(
        "init", "--goal", "Span two projects",
        "--use-worktrees", "true",
        "--repo", "mobile=../multicode-mobile",
    )

    vcs = read_state(fixture.state_path)["sprintengine"]["vcs"]
    assert [repo["id"] for repo in vcs["repos"]] == ["primary", "mobile"]


def test_a_second_init_declaring_a_new_repo_is_refused(tmp_path) -> None:
    # The repo set is fixed at creation. Silently dropping a newly declared project
    # (the old behavior) hid that it never took effect; refuse instead.
    workspace, _ = _two_project_workspace(tmp_path)
    fixture = _worktree_team(workspace, "alpha")
    fixture.cli.run(
        "init", "--goal", "Span two projects",
        "--use-worktrees", "true",
        "--repo", "mobile=../multicode-mobile",
    )

    failure = fixture.cli.run_failure(
        "init", "--goal", "Span three projects",
        "--use-worktrees", "true",
        "--repo", "mobile=../multicode-mobile",
        "--repo", "relay=../multiauth",
    )

    assert "relay" in failure.stdout + failure.stderr
    assert "fixed at creation" in failure.stdout + failure.stderr
    # The declared set is unchanged — the new project did not sneak in.
    vcs = read_state(fixture.state_path)["sprintengine"]["vcs"]
    assert [repo["id"] for repo in vcs["repos"]] == ["primary", "mobile"]


def test_base_start_point_without_worktrees_is_refused(tmp_path) -> None:
    # The start point only names where the run branch begins, so it is meaningless
    # without worktrees. Its help text says it requires worktrees; refuse rather
    # than silently ignore it, exactly as a bare --repo does.
    workspace, _ = _two_project_workspace(tmp_path)
    fixture = _worktree_team(workspace, "alpha")

    failure = fixture.cli.run_failure(
        "init", "--goal", "One project",
        "--base-start-point", "origin/main",
    )

    assert "--base-start-point" in failure.stdout + failure.stderr
    assert "use-worktrees" in failure.stdout + failure.stderr
    assert read_state(fixture.state_path)["sprintengine"].get("vcs") is None


# --- declarations that must abort init -------------------------------------


def test_missing_sibling_project_aborts_init(tmp_path) -> None:
    # AC2: a missing sibling root aborts loudly rather than creating a partial run.
    workspace, _ = _two_project_workspace(tmp_path)
    fixture = _worktree_team(workspace, "alpha")

    failure = fixture.cli.run_failure(
        "init", "--goal", "Span two projects",
        "--use-worktrees", "true",
        "--repo", "mobile=../not-here",
    )

    assert "no directory" in failure.stdout + failure.stderr
    assert read_state(fixture.state_path)["sprintengine"].get("vcs") is None


def test_non_git_sibling_project_aborts_init(tmp_path) -> None:
    # AC2: a real directory that is not a git project cannot host a worktree.
    workspace, _ = _two_project_workspace(tmp_path)
    (tmp_path / "plain-dir").mkdir()
    fixture = _worktree_team(workspace, "alpha")

    failure = fixture.cli.run_failure(
        "init", "--goal", "Span two projects",
        "--use-worktrees", "true",
        "--repo", "mobile=../plain-dir",
    )

    assert "not a git repository" in failure.stdout + failure.stderr
    assert not (fixture.team_dir / "worktree-mobile").exists()


def test_one_bad_repo_aborts_the_whole_init(tmp_path) -> None:
    # AC3: any repo's failure aborts init — no half-declared run, no orphan worktree
    # for the repo that would have succeeded.
    workspace, _ = _two_project_workspace(tmp_path)
    fixture = _worktree_team(workspace, "alpha")

    fixture.cli.run_failure(
        "init", "--goal", "Span two projects",
        "--use-worktrees", "true",
        "--repo", "mobile=../multicode-mobile",
        "--repo", "relay=../not-here",
    )

    assert read_state(fixture.state_path)["sprintengine"].get("vcs") is None
    assert not (fixture.team_dir / "worktree-mobile").exists()
    assert not (fixture.team_dir / "worktree-relay").exists()


def test_sibling_inside_the_primary_project_aborts_init(tmp_path) -> None:
    # A nested repo shares the primary's tree: its worktree and orphan scans would
    # collide with the primary's. Declared projects are separate projects.
    workspace, _ = _two_project_workspace(tmp_path)
    nested = workspace / "vendor" / "inner"
    _init_git_repo(nested)
    fixture = _worktree_team(workspace, "alpha")

    failure = fixture.cli.run_failure(
        "init", "--goal", "Span two projects",
        "--use-worktrees", "true",
        "--repo", "inner=vendor/inner",
    )

    assert "inside this project" in failure.stdout + failure.stderr


def test_sibling_pointing_at_the_primary_project_aborts_init(tmp_path) -> None:
    workspace, _ = _two_project_workspace(tmp_path)
    fixture = _worktree_team(workspace, "alpha")

    failure = fixture.cli.run_failure(
        "init", "--goal", "Span two projects",
        "--use-worktrees", "true",
        "--repo", "again=.",
    )

    assert "this project itself" in failure.stdout + failure.stderr


def test_sibling_containing_the_primary_project_aborts_init(tmp_path) -> None:
    # The mirror of the nested case, and the one that actually widens the blast
    # radius: a repo that CONTAINS the workspace pulls the workspace and every
    # neighbour beside it into the run's declared surface by inclusion. The MCP
    # boundary already refuses to authorize such a root (sprintEngineDeclaredSiblingRepoRoots),
    # but the engine's own git operations never consult allowedRoots — they use the
    # store's roots directly — so init is the only place this can be refused.
    workspace, _ = _two_project_workspace(tmp_path)
    _init_git_repo(tmp_path)
    fixture = _worktree_team(workspace, "alpha")

    failure = fixture.cli.run_failure(
        "init", "--goal", "Span two projects",
        "--use-worktrees", "true",
        "--repo", "parent=..",
    )

    assert "contains this project" in failure.stdout + failure.stderr
    assert read_state(fixture.state_path)["sprintengine"].get("vcs") is None
    assert not (fixture.team_dir / "worktree-parent").exists()


def test_one_project_declared_under_two_names_aborts_init(tmp_path) -> None:
    workspace, _ = _two_project_workspace(tmp_path)
    fixture = _worktree_team(workspace, "alpha")

    failure = fixture.cli.run_failure(
        "init", "--goal", "Span two projects",
        "--use-worktrees", "true",
        "--repo", "mobile=../multicode-mobile",
        "--repo", "phone=../multicode-mobile",
    )

    assert "declare each project once" in failure.stdout + failure.stderr


def test_declaring_a_repo_without_worktrees_aborts_init(tmp_path) -> None:
    # Without a worktree per project there is no second tree to target, so the
    # declaration would be silently meaningless.
    workspace, _ = _two_project_workspace(tmp_path)
    fixture = _worktree_team(workspace, "alpha")

    failure = fixture.cli.run_failure(
        "init", "--goal", "Span two projects",
        "--repo", "mobile=../multicode-mobile",
    )

    assert "--use-worktrees" in failure.stdout + failure.stderr
    assert read_state(fixture.state_path)["sprintengine"].get("vcs") is None
