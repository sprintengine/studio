"""One pull request per project, cross-linked and merged independently (MC-1612).

A run spanning projects delivers one branch per project to one remote per project,
so it opens one pull request per project. The failures these tests pin are the ones
a singular PR pipeline produces on a multi-repo run: a second project's work never
reaching a pull request at all, a body that never mentions the pull request it must
merge after, one project's `gh` failure taking another project's pull request with
it, and a merge in one project tearing down another project's live worktree.

`gh` is faked at the `run_gh_checked` seam: these tests own the PR pipeline's logic,
not the GitHub CLI's. Everything below it is real — real git repos, real remotes,
real pushes, real worktrees.
"""
from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

from helpers import SwarmCli, SwarmTeamFixture, base_state, read_state
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


def _init_git_repo(root: Path, *, origin: Path) -> None:
    """A real project with a real `origin` it can really push to."""
    _git(origin.parent, "init", "--bare", "-q", str(origin))
    root.mkdir(parents=True, exist_ok=True)
    _git(root, "init", "-q")
    _git(root, "config", "user.email", "test@example.com")
    _git(root, "config", "user.name", "Sprint Engine Test")
    _git(root, "config", "commit.gpgsign", "false")
    _git(root, "checkout", "-q", "-b", "main")
    (root / "README.md").write_text("seed\n", encoding="utf-8")
    _git(root, "add", "-A")
    _git(root, "commit", "-qm", "seed")
    _git(root, "remote", "add", "origin", str(origin))
    _git(root, "push", "-q", "-u", "origin", "main")


class FakeGh:
    """The GitHub CLI, reduced to what the PR pipeline asks of it.

    Keyed by the worktree `gh` is invoked in, which is exactly how the pipeline
    separates one project from another. Records every body it is handed so a test can
    assert on what a reviewer would actually read.
    """

    def __init__(self, *, urls: Dict[Path, str], create_fails: Optional[Dict[Path, str]] = None) -> None:
        self.urls = urls
        self.create_fails = create_fails or {}
        self.merged: set[str] = set()
        self.bodies: Dict[str, str] = {}
        self.calls: List[Dict[str, Any]] = []

    def __call__(self, cwd: Path, args: List[str], *, allow_failure: bool = False) -> subprocess.CompletedProcess[str]:
        self.calls.append({"cwd": Path(cwd), "args": list(args)})
        command = tuple(args[:2])
        if command == ("pr", "create"):
            failure = self.create_fails.get(Path(cwd))
            if failure:
                return self._completed(1, stderr=failure)
            url = self.urls[Path(cwd)]
            self.bodies[url] = args[args.index("--body") + 1]
            return self._completed(0, stdout=f"{url}\n")
        if command == ("pr", "edit"):
            url = args[2]
            self.bodies[url] = args[args.index("--body") + 1]
            return self._completed(0)
        if command == ("pr", "view"):
            state = "MERGED" if args[2] in self.merged else "OPEN"
            return self._completed(0, stdout=f'{{"state": "{state}"}}')
        if command == ("pr", "merge"):
            url = args[2]
            if url in self.merged:
                return self._completed(1, stderr="gh: pull request is already merged")
            self.merged.add(url)
            return self._completed(0)
        raise AssertionError(f"unexpected gh call: {args}")

    @staticmethod
    def _completed(returncode: int, *, stdout: str = "", stderr: str = "") -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(args=["gh"], returncode=returncode, stdout=stdout, stderr=stderr)


def _team(workspace: Path) -> SwarmTeamFixture:
    team_dir = workspace / ".multi-code" / "sprintengine" / "alpha"
    state_path = team_dir / "run.yaml"
    from helpers import write_state

    write_state(state_path, base_state("alpha", []))
    return SwarmTeamFixture(team_dir=team_dir, state_path=state_path, cli=SwarmCli(state_path, cwd=workspace))


def _deliver(fixture: SwarmTeamFixture, task_id: str, repo: str, path: str, *, depends_on: Optional[str] = None) -> None:
    """Plan, claim, write, and commit one task's work in the project it targets."""
    fixture.cli.run(
        "plan", "add-task", "--title", f"Work {task_id}", "--role", "developer",
        "--task-id", task_id, "--repo", repo, "--path", path,
        *(["--depends-on", depends_on] if depends_on else []),
    )
    fixture.cli.run("task", "status", "--task-id", "T0", "--status", "done", "--id", "architect-1")
    claimed = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")
    assert claimed["task"]["id"] == task_id
    worktree = fixture.team_dir / ("worktree" if repo == "primary" else f"worktree-{repo}")
    target = worktree / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(f"export const value = '{task_id}'\n", encoding="utf-8")
    published = fixture.cli.run(
        "task", "publish", "--task-id", task_id, "--id", "developer-1", "--summary", f"Deliver {task_id}.", "--path", path
    )
    assert published["ok"] is True
    fixture.cli.run("task", "advance", "--task-id", task_id, "--id", "developer-1", "--phase", "review", "--outcome", "pass", "--summary", "Reviewed.")


def _two_project_run(tmp_path: Path, *, commit_in_mobile: bool = True) -> SwarmTeamFixture:
    """A run over two real projects; the mobile task depends on the desktop one."""
    workspace = tmp_path / "ws"
    sibling = tmp_path / "multicode-mobile"
    _init_git_repo(workspace, origin=tmp_path / "origin-ws.git")
    _init_git_repo(sibling, origin=tmp_path / "origin-mobile.git")
    fixture = _team(workspace)
    fixture.cli.run(
        "init", "--goal", "Span two projects",
        "--use-worktrees", "true",
        "--agent", "developer:developer-1",
        "--repo", "mobile=../multicode-mobile",
    )
    _deliver(fixture, "T1", "primary", "src/protocol.ts")
    if commit_in_mobile:
        _deliver(fixture, "T2", "mobile", "app/screen.ts", depends_on="T1")
    return fixture


def _single_project_run(tmp_path: Path) -> SwarmTeamFixture:
    workspace = tmp_path / "ws"
    _init_git_repo(workspace, origin=tmp_path / "origin-ws.git")
    fixture = _team(workspace)
    fixture.cli.run("init", "--goal", "One project", "--use-worktrees", "true", "--agent", "developer:developer-1")
    _deliver(fixture, "T1", "primary", "src/protocol.ts")
    return fixture


def _fake_gh(monkeypatch, fixture: SwarmTeamFixture, *, create_fails: Optional[Dict[Path, str]] = None) -> FakeGh:
    fake = FakeGh(
        urls={
            fixture.team_dir / "worktree": "https://github.com/acme/multicode/pull/1",
            fixture.team_dir / "worktree-mobile": "https://github.com/acme/multicode-mobile/pull/9",
        },
        create_fails=create_fails,
    )
    monkeypatch.setattr(shell, "run_gh_checked", fake)
    return fake


# --- one pull request per project, cross-linked ------------------------------


def test_two_project_run_opens_one_pull_request_per_project(tmp_path, monkeypatch) -> None:
    # AC1: both projects committed, so both get a pull request, and each body names
    # the other with the order they have to merge in.
    fixture = _two_project_run(tmp_path)
    fake = _fake_gh(monkeypatch, fixture)

    state = read_state(fixture.state_path)
    result = shell.create_run_pull_request(state, fixture.state_path)

    assert result["ok"] is True
    assert [(entry["repo"], entry["pullRequestUrl"]) for entry in result["repos"]] == [
        ("primary", "https://github.com/acme/multicode/pull/1"),
        ("mobile", "https://github.com/acme/multicode-mobile/pull/9"),
    ]
    # The primary's fields stay at the top level, where every shipped surface reads them.
    assert result["pullRequestUrl"] == "https://github.com/acme/multicode/pull/1"
    vcs = state["sprintengine"]["vcs"]
    assert vcs["pullRequestUrl"] == "https://github.com/acme/multicode/pull/1"
    assert vcs["repos"][0]["pullRequestUrl"] == "https://github.com/acme/multicode/pull/1"
    mobile = next(repo for repo in vcs["repos"] if repo["id"] == "mobile")
    assert mobile["pullRequestUrl"] == "https://github.com/acme/multicode-mobile/pull/9"
    assert mobile["pullRequestState"] == "open"

    # Each body links its companion and states the merge order: the mobile work
    # depends on the desktop work, so the desktop pull request merges first.
    desktop_body = fake.bodies["https://github.com/acme/multicode/pull/1"]
    mobile_body = fake.bodies["https://github.com/acme/multicode-mobile/pull/9"]
    for body in (desktop_body, mobile_body):
        assert "## Companion pull requests" in body
        assert "https://github.com/acme/multicode/pull/1" in body
        assert "https://github.com/acme/multicode-mobile/pull/9" in body
        assert body.index("1. **ws**") < body.index("2. **multicode-mobile**")
        assert "has to merge first" in body
    # The task table is the project's own: a reviewer of one is not reviewing the other.
    assert "Work T1" in desktop_body and "Work T2" not in desktop_body
    assert "Work T2" in mobile_body and "Work T1" not in mobile_body


def test_project_with_no_commits_gets_no_pull_request(tmp_path, monkeypatch) -> None:
    # AC2: a declared project the run never changed delivers nothing. An empty pull
    # request is noise a reviewer has to close, and its absence is not an error.
    fixture = _two_project_run(tmp_path, commit_in_mobile=False)
    fake = _fake_gh(monkeypatch, fixture)

    state = read_state(fixture.state_path)
    result = shell.create_run_pull_request(state, fixture.state_path)

    assert result["ok"] is True
    # `project` is on every entry: the surfaces that show these pull requests label
    # them by the name a person says, and a skipped project still has one.
    assert result["repos"][1] == {
        "repo": "mobile",
        "ok": True,
        "skipped": "no_commits",
        "branch": "sprintengine/alpha",
        "project": "multicode-mobile",
    }
    assert not any(call["cwd"] == fixture.team_dir / "worktree-mobile" for call in fake.calls)
    mobile = next(repo for repo in state["sprintengine"]["vcs"]["repos"] if repo["id"] == "mobile")
    assert mobile["pullRequestUrl"] is None
    assert mobile["pullRequestError"] is None
    # One pull request means no companions, so nothing to cross-link and no second pass.
    assert "## Companion pull requests" not in fake.bodies["https://github.com/acme/multicode/pull/1"]


def test_one_projects_gh_failure_leaves_the_others_pull_request_intact(tmp_path, monkeypatch) -> None:
    # AC3: partial failure is per project. The desktop pull request is real and stays
    # real; only the failing project records the reason, and a re-run retries it.
    fixture = _two_project_run(tmp_path)
    _fake_gh(monkeypatch, fixture, create_fails={fixture.team_dir / "worktree-mobile": "gh: could not authenticate"})

    state = read_state(fixture.state_path)
    result = shell.create_run_pull_request(state, fixture.state_path)

    assert result["ok"] is False
    assert "could not authenticate" in result["error"]
    assert result["pullRequestUrl"] == "https://github.com/acme/multicode/pull/1"
    vcs = state["sprintengine"]["vcs"]
    assert vcs["pullRequestUrl"] == "https://github.com/acme/multicode/pull/1"
    assert vcs["status"] == "pr_opened"
    mobile = next(repo for repo in vcs["repos"] if repo["id"] == "mobile")
    assert mobile["pullRequestUrl"] is None
    assert mobile["status"] == "failed"
    assert "could not authenticate" in mobile["pullRequestError"]

    # Re-runnable: with `gh` working, the retry opens the missing pull request and
    # keeps the one that already existed.
    fake = _fake_gh(monkeypatch, fixture)
    retried = shell.create_run_pull_request(state, fixture.state_path)
    assert retried["ok"] is True
    assert retried["repos"][0]["alreadyExists"] is True
    mobile = next(repo for repo in state["sprintengine"]["vcs"]["repos"] if repo["id"] == "mobile")
    assert mobile["pullRequestUrl"] == "https://github.com/acme/multicode-mobile/pull/9"
    assert mobile["pullRequestError"] is None
    # And the body that was written before the companion existed now names it.
    assert "https://github.com/acme/multicode-mobile/pull/9" in fake.bodies["https://github.com/acme/multicode/pull/1"]


def test_rerunning_pr_resyncs_bodies_without_duplicating_the_companion_section(tmp_path, monkeypatch) -> None:
    # AC5: every body is rewritten whole from the run's state, so re-running syncs
    # them instead of stacking a second companion section onto each.
    fixture = _two_project_run(tmp_path)
    fake = _fake_gh(monkeypatch, fixture)
    state = read_state(fixture.state_path)

    shell.create_run_pull_request(state, fixture.state_path)
    first = dict(fake.bodies)
    shell.create_run_pull_request(state, fixture.state_path)

    assert fake.bodies == first
    for body in fake.bodies.values():
        assert body.count("## Companion pull requests") == 1


def test_a_merged_projects_pull_request_survives_a_resync(tmp_path, monkeypatch) -> None:
    # Once a branch merges, its commits ARE its base — so the "no commits, no pull
    # request" skip must not fire for a repo that already has one, or the companion
    # it merged first would vanish from the body of the one still waiting to merge.
    fixture = _two_project_run(tmp_path)
    fake = _fake_gh(monkeypatch, fixture)
    state = read_state(fixture.state_path)
    shell.create_run_pull_request(state, fixture.state_path)

    # The desktop branch really lands in its base, the way a merge leaves it.
    _git(tmp_path / "ws", "merge", "--no-edit", "sprintengine/alpha")

    resynced = shell.create_run_pull_request(state, fixture.state_path)

    assert [entry.get("skipped") for entry in resynced["repos"]] == [None, None]
    assert resynced["repos"][0]["alreadyExists"] is True
    assert "https://github.com/acme/multicode/pull/1" in fake.bodies["https://github.com/acme/multicode-mobile/pull/9"]


# --- merge state and cleanup, per project ------------------------------------


def test_merging_one_project_flips_and_cleans_up_only_that_project(tmp_path, monkeypatch) -> None:
    # AC4: projects merge on their own schedule. The desktop merge must not report the
    # mobile pull request merged, and must not remove the mobile worktree the mobile
    # branch is still live in.
    fixture = _two_project_run(tmp_path)
    fake = _fake_gh(monkeypatch, fixture)
    state = read_state(fixture.state_path)
    shell.create_run_pull_request(state, fixture.state_path)

    fake.merged.add("https://github.com/acme/multicode/pull/1")
    refreshed = shell.refresh_run_pull_request_state(state, fixture.state_path)

    assert refreshed["repos"] == [
        {"repo": "primary", "pullRequestState": "merged"},
        {"repo": "mobile", "pullRequestState": "open"},
    ]
    assert refreshed["pullRequestState"] == "merged"

    cleanup = shell.cleanup_merged_worktree(state, fixture.state_path)
    assert cleanup["repos"] == [
        {"repo": "primary", "removed": True},
        {"repo": "mobile", "removed": False, "reason": "not_merged"},
    ]
    assert not (fixture.team_dir / "worktree").exists()
    # The mobile tree — and the run directory that anchors both — survive.
    assert (fixture.team_dir / "worktree-mobile").exists()
    assert fixture.state_path.exists()


def test_run_completes_when_every_changed_project_has_a_pull_request(tmp_path, monkeypatch) -> None:
    # The completion gate counts projects the run CHANGED: a project with no commits
    # needs no pull request, and one with commits and no pull request is not delivered.
    from sprintengine_core.store import normalize_runner_policy
    from sprintengine_core.tool.commands.run import finalize_completed_run

    fixture = _two_project_run(tmp_path)
    fake = _fake_gh(monkeypatch, fixture)
    state = read_state(fixture.state_path)

    before = finalize_completed_run(state, fixture.state_path, normalize_runner_policy({}))
    assert before["blocked"] is False
    assert "alreadyExists" not in before

    shell.create_run_pull_request(state, fixture.state_path)
    after = finalize_completed_run(state, fixture.state_path, normalize_runner_policy({}))

    assert after["alreadyExists"] is True
    assert after["pullRequestUrls"] == [
        {"repo": "primary", "pullRequestUrl": "https://github.com/acme/multicode/pull/1"},
        {"repo": "mobile", "pullRequestUrl": "https://github.com/acme/multicode-mobile/pull/9"},
    ]
    assert "https://github.com/acme/multicode-mobile/pull/9" in after["message"]
    assert fake.bodies  # the pull requests are the ones this run opened


# --- the single-project control ----------------------------------------------


def test_single_project_run_opens_exactly_one_unchanged_pull_request(tmp_path, monkeypatch) -> None:
    # AC6: a run declaring one project is the one-entry list it always was. One `gh pr
    # create`, no second pass, and the body it has always had.
    fixture = _single_project_run(tmp_path)
    fake = _fake_gh(monkeypatch, fixture)

    state = read_state(fixture.state_path)
    result = shell.create_run_pull_request(state, fixture.state_path)

    assert result["ok"] is True
    assert result["pullRequestUrl"] == "https://github.com/acme/multicode/pull/1"
    assert [tuple(call["args"][:2]) for call in fake.calls] == [("pr", "create")]
    body = fake.bodies["https://github.com/acme/multicode/pull/1"]
    assert body == shell.build_run_pull_request_body(state, "sprintengine/alpha")
    assert "Companion" not in body


# --- merge order ---------------------------------------------------------------


@pytest.mark.parametrize(
    "tasks, expected",
    [
        # A consumer's dependency on a producer in another project orders the two.
        ([("T1", "primary", []), ("T2", "mobile", ["T1"])], ["primary", "mobile"]),
        ([("T1", "mobile", []), ("T2", "primary", ["T1"])], ["mobile", "primary"]),
        # Dependencies inside one project say nothing: one pull request carries both.
        ([("T1", "primary", []), ("T2", "primary", ["T1"]), ("T3", "mobile", [])], ["primary", "mobile"]),
        # A cycle cannot be honoured, so the repos it traps keep declaration order
        # rather than being dropped from the bodies entirely.
        ([("T1", "primary", ["T2"]), ("T2", "mobile", ["T1"])], ["primary", "mobile"]),
    ],
)
def test_merge_order_follows_cross_project_dependencies(tasks, expected) -> None:
    state = {"tasks": [{"id": task_id, "repo": repo, "dependsOn": deps} for task_id, repo, deps in tasks]}
    assert shell.repo_merge_order(state, ["primary", "mobile"]) == expected


# --- merging one project's pull request from the app ---------------------------


def _merge(fixture: SwarmTeamFixture, repo: str, state: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    return shell.merge_repo_pull_request(state if state is not None else read_state(fixture.state_path), fixture.state_path, repo_id=repo)


def test_pr_merge_refuses_until_the_project_it_builds_on_has_merged(tmp_path, monkeypatch) -> None:
    # AC2: the mobile work depends on the desktop work, so merging mobile first would
    # land it on a base without what it needs. Refused, naming the project by the name
    # a person calls it — and the refusal is not a merge that quietly happened anyway.
    fixture = _two_project_run(tmp_path)
    fake = _fake_gh(monkeypatch, fixture)
    state = read_state(fixture.state_path)
    shell.create_run_pull_request(state, fixture.state_path)

    refused = shell.merge_repo_pull_request(state, fixture.state_path, repo_id="mobile")

    assert refused["ok"] is False
    assert refused["blockedBy"] == ["primary"]
    assert "ws has to merge first" in refused["error"]
    assert "multicode-mobile cannot merge yet" in refused["error"]
    assert not any(tuple(call["args"][:2]) == ("pr", "merge") for call in fake.calls)
    assert "https://github.com/acme/multicode-mobile/pull/9" not in fake.merged

    # With the desktop pull request merged, the mobile one is free to go.
    assert shell.merge_repo_pull_request(state, fixture.state_path, repo_id="primary")["ok"] is True
    allowed = shell.merge_repo_pull_request(state, fixture.state_path, repo_id="mobile")
    assert allowed["ok"] is True
    assert fake.merged == {"https://github.com/acme/multicode/pull/1", "https://github.com/acme/multicode-mobile/pull/9"}


def test_pr_merge_refusal_survives_a_transitive_dependency(tmp_path, monkeypatch) -> None:
    # Waiting is transitive: no mobile task names the desktop task directly here, but
    # mobile still cannot merge before the project its dependency's project depends on.
    fixture = _two_project_run(tmp_path)
    _fake_gh(monkeypatch, fixture)
    state = read_state(fixture.state_path)
    state["tasks"].append({"id": "T3", "repo": "mobile", "dependsOn": ["T2"], "status": "done"})
    shell.create_run_pull_request(state, fixture.state_path)

    refused = shell.merge_repo_pull_request(state, fixture.state_path, repo_id="mobile")
    assert refused["ok"] is False
    assert refused["blockedBy"] == ["primary"]


def test_pr_merge_is_idempotent_and_cleans_up_only_that_projects_worktree(tmp_path, monkeypatch) -> None:
    # AC1: re-running the merge is a no-op that still reports success — the button is
    # pressed twice, or the pull request was merged on GitHub in between. And a merge
    # takes down its own project's tree only; the other project is still being worked.
    fixture = _two_project_run(tmp_path)
    fake = _fake_gh(monkeypatch, fixture)
    state = read_state(fixture.state_path)
    shell.create_run_pull_request(state, fixture.state_path)

    merged = shell.merge_repo_pull_request(state, fixture.state_path, repo_id="primary")
    assert merged["ok"] is True
    assert merged["alreadyMerged"] is False
    assert merged["worktreeCleanup"] == {"removed": True}
    assert not (fixture.team_dir / "worktree").exists()
    assert (fixture.team_dir / "worktree-mobile").exists()

    merge_calls = [call for call in fake.calls if tuple(call["args"][:2]) == ("pr", "merge")]
    again = shell.merge_repo_pull_request(state, fixture.state_path, repo_id="primary")
    assert again["ok"] is True
    assert again["alreadyMerged"] is True
    # The second press must not reach `gh pr merge` at all: a merged pull request is a
    # settled fact, and asking GitHub to merge it again is how a green button starts
    # reporting the "already merged" error as a failure.
    assert [call for call in fake.calls if tuple(call["args"][:2]) == ("pr", "merge")] == merge_calls
    assert state["sprintengine"]["vcs"]["pullRequestState"] == "merged"


def test_pr_merge_reports_a_project_the_sprint_does_not_work_in(tmp_path, monkeypatch) -> None:
    fixture = _two_project_run(tmp_path)
    _fake_gh(monkeypatch, fixture)
    state = read_state(fixture.state_path)

    result = shell.merge_repo_pull_request(state, fixture.state_path, repo_id="multiauth")
    assert result["ok"] is False
    assert "does not work in project 'multiauth'" in result["error"]
    assert "primary, mobile" in result["error"]


def test_pr_merge_needs_a_pull_request_to_merge(tmp_path, monkeypatch) -> None:
    fixture = _two_project_run(tmp_path, commit_in_mobile=False)
    _fake_gh(monkeypatch, fixture)
    state = read_state(fixture.state_path)
    shell.create_run_pull_request(state, fixture.state_path)

    result = shell.merge_repo_pull_request(state, fixture.state_path, repo_id="mobile")
    assert result["ok"] is False
    assert "has no pull request to merge yet" in result["error"]


def test_pr_merge_cli_merges_the_single_project_run(tmp_path, monkeypatch) -> None:
    # AC6: one project, no companions, nothing to wait for — `--repo` defaults to it and
    # the merge is the one `gh` call it has always been.
    fixture = _single_project_run(tmp_path)
    fake = _fake_gh(monkeypatch, fixture)
    state = read_state(fixture.state_path)
    shell.create_run_pull_request(state, fixture.state_path)

    result = shell.merge_repo_pull_request(state, fixture.state_path)

    assert result["ok"] is True
    assert result["pullRequestUrl"] == "https://github.com/acme/multicode/pull/1"
    assert fake.merged == {"https://github.com/acme/multicode/pull/1"}
    assert not (fixture.team_dir / "worktree").exists()


def test_pr_merge_rejects_an_unknown_merge_method(tmp_path, monkeypatch) -> None:
    fixture = _single_project_run(tmp_path)
    _fake_gh(monkeypatch, fixture)
    state = read_state(fixture.state_path)

    result = shell.merge_repo_pull_request(state, fixture.state_path, method="yolo")
    assert result["ok"] is False
    assert "Unknown merge method" in result["error"]


# --- repo cycles are refused where they are authored ---------------------------


def _two_project_plan(tmp_path: Path) -> SwarmTeamFixture:
    """A two-project run whose plan is one edge short of a repo loop.

    T2 (mobile) waits on T1 (desktop), so the desktop pull request merges first. T3
    (mobile) waits on nothing yet — pointing anything in desktop at it closes the loop.
    """
    workspace = tmp_path / "ws"
    _init_git_repo(workspace, origin=tmp_path / "origin-ws.git")
    _init_git_repo(tmp_path / "multicode-mobile", origin=tmp_path / "origin-mobile.git")
    fixture = _team(workspace)
    fixture.cli.run(
        "init", "--goal", "Span two projects", "--use-worktrees", "true",
        "--agent", "developer:developer-1", "--repo", "mobile=../multicode-mobile",
    )
    fixture.cli.run("plan", "add-task", "--title", "Desktop", "--role", "developer", "--task-id", "T1", "--repo", "primary")
    fixture.cli.run(
        "plan", "add-task", "--title", "Mobile", "--role", "developer", "--task-id", "T2",
        "--repo", "mobile", "--depends-on", "T1",
    )
    fixture.cli.run("plan", "add-task", "--title", "More mobile", "--role", "developer", "--task-id", "T3", "--repo", "mobile")
    return fixture


def test_plan_refuses_a_dependency_that_makes_two_projects_wait_on_each_other(tmp_path) -> None:
    # AC3: a desktop task waiting on a mobile task, while a mobile task waits on a
    # desktop task, is a perfectly orderable TASK graph — no task waits on itself. But
    # each project's pull request would then have to merge before the other's, and no
    # merge order exists at all. Refused where the edge is authored, naming the loop.
    fixture = _two_project_plan(tmp_path)
    fixture.cli.run("plan", "add-task", "--title", "Desktop again", "--role", "developer", "--task-id", "T4", "--repo", "primary")

    failed = fixture.cli.run_failure("plan", "add-dependency", "--task-id", "T4", "--depends-on", "T3")

    assert "wait on each other" in failed.stderr
    assert "primary → mobile → primary" in failed.stderr
    # Refused, not recorded: the plan is exactly what it was before the attempt.
    tasks = {task["id"]: task for task in read_state(fixture.state_path)["tasks"]}
    assert "T3" not in tasks["T4"]["dependsOn"]


def test_plan_refuses_a_new_task_that_closes_a_repo_loop(tmp_path) -> None:
    # The same loop, closed by adding a task rather than an edge to an existing one.
    fixture = _two_project_plan(tmp_path)

    failed = fixture.cli.run_failure(
        "plan", "add-task", "--title", "Desktop again", "--role", "developer", "--task-id", "T4",
        "--repo", "primary", "--depends-on", "T3",
    )

    assert "wait on each other" in failed.stderr
    assert "T4" not in {task["id"] for task in read_state(fixture.state_path)["tasks"]}


def test_plan_refuses_re_targeting_a_task_into_a_repo_loop(tmp_path) -> None:
    # A task's project can be re-targeted after it is planned, which rewrites the repo
    # graph under dependencies that were legal where the task used to live. T4 waiting
    # on T3 is fine while both are mobile; moving T4 to desktop closes the loop.
    fixture = _two_project_plan(tmp_path)
    fixture.cli.run(
        "plan", "add-task", "--title", "More mobile still", "--role", "developer", "--task-id", "T4",
        "--repo", "mobile", "--depends-on", "T3",
    )

    failed = fixture.cli.run_failure("plan", "update-task", "--task-id", "T4", "--repo", "primary")

    assert "wait on each other" in failed.stderr
    tasks = {task["id"]: task for task in read_state(fixture.state_path)["tasks"]}
    assert tasks["T4"]["repo"] == "mobile"


def test_plan_allows_many_dependencies_in_one_direction(tmp_path) -> None:
    # The control: cross-project work is the point. Only a LOOP is refused, and a
    # same-project dependency is never one — a single pull request carries both ends.
    tasks = [
        {"id": "T1", "repo": "primary", "dependsOn": []},
        {"id": "T2", "repo": "mobile", "dependsOn": ["T1"]},
        {"id": "T3", "repo": "mobile", "dependsOn": ["T1", "T2"]},
        {"id": "T4", "repo": "primary", "dependsOn": ["T1"]},
    ]
    assert shell.repo_dependency_cycle(tasks) == []
    shell.assert_no_repo_dependency_cycle(tasks)


def test_repo_dependency_cycle_names_the_loop_it_found() -> None:
    tasks = [
        {"id": "T1", "repo": "primary", "dependsOn": ["T3"]},
        {"id": "T2", "repo": "mobile", "dependsOn": ["T1"]},
        {"id": "T3", "repo": "auth", "dependsOn": ["T2"]},
    ]
    cycle = shell.repo_dependency_cycle(tasks)
    assert cycle[0] == cycle[-1]
    assert set(cycle) == {"primary", "mobile", "auth"}
