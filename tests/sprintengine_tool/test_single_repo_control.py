"""The single-repo control: a default run must behave exactly as it did pre-epic.

Multi-repo sprints (MC-1610) made every run a *set* of projects and every task target
one of them. Nearly every real run declares no sibling and is therefore a one-entry
list — so the epic is only safe to ship if that one-entry list is not a special case
but the same code path arriving at the same answers. This module is the regression
check that says so, and it is the mitigation of record for shipping cross-repo
behavior before the post-merge real-app E2E runs (plan §7).

**Why the expectations here are literals.** The per-seam suites assert equivalence
against the current implementation (`body == build_run_pull_request_body(...)`), which
proves internal consistency but would happily follow the implementation as it drifts.
The values below were instead captured by running this exact scenario against the
PRE-epic engine (`main` @ cfce6533, extracted with `git archive`) and are pinned as
the bytes that code produced. They are the pre-epic contract, not a restatement of
today's code, so a future change that alters what a default run does trips this suite
rather than silently updating its own baseline.

The three tests naming `PRE_EPIC_*` were executed UNMODIFIED against that pre-epic
engine and pass there too — which is the whole claim of this module: one scenario, two
engines, same answers. The rest assert that the seams the epic ADDED (`vcs.repos`,
`task_repo`, the per-repo orphan scan) are no-ops for a default run; they name APIs
that did not exist pre-epic, so they can only run here, and they are what would catch
a future special-case creeping into the one-entry path.

Deliberately NOT asserted as unchanged: the run store itself. `vcs.repos` and the
schema 3->4 bump ARE the epic, and a v3 store is rejected rather than migrated
(`test_vcs_repos.py`). This module pins the observable behavior of a default run, not
the shape of the file it is recorded in.
"""
from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any, Dict, List

from helpers import SwarmCli, SwarmTeamFixture, base_state, read_state, write_state
from sprintengine_core import store as folder_store
from sprintengine_core.tool import shell


# Captured from the pre-epic engine (`main` @ cfce6533). Every value below is what a
# default run produced BEFORE `vcs.repos` existed.
PRE_EPIC_WORKTREE_PATH = ".sprintengine/sprintengine/alpha/worktree"
PRE_EPIC_BRANCH_NAME = "sprintengine/alpha"
PRE_EPIC_COMMIT_SUBJECT = "SprintEngine T1: Add the endpoint"
PRE_EPIC_COMMIT_BODY = "Task: T1\nAgent: developer-1"
# The body a default run produces. Its FORMAT is no longer the pre-epic one — the
# delivery summary (checklist, per-item grouping, review notes) replaced the flat
# list — but what this constant pins about a single-project run is unchanged: no
# "Companion pull requests" section, and every delivered task listed, because the
# per-repo filter must be a no-op when there is one repo.
SINGLE_PROJECT_PULL_REQUEST_BODY = (
    "Sprint Engine run delivery for branch `sprintengine/alpha`.\n"
    "\n"
    "**Goal:** Ship the thing\n"
    "\n"
    "## Tasks\n"
    "\n"
    "**Delivered: 2 of 2**\n"
    "\n"
    "- [x] Add the endpoint _(developer)_\n"
    "  - Endpoint lands with tests.\n"
    "- [x] Wire the panel _(frontend)_\n"
    "  - Panel reads the endpoint."
)


def _git(repo: Path, *args: str) -> str:
    completed = subprocess.run(
        ["git", *args],
        cwd=str(repo),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if completed.returncode != 0:
        raise AssertionError(f"git {' '.join(args)} failed: {completed.stdout}")
    return completed.stdout


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


def _default_run(tmp_path: Path) -> SwarmTeamFixture:
    """A run created the way nearly every real run is: `--use-worktrees`, no `--repo`."""
    workspace = tmp_path / "ws"
    _init_git_repo(workspace)
    team_dir = workspace / ".sprintengine" / "sprintengine" / "alpha"
    state_path = team_dir / "run.yaml"
    write_state(state_path, base_state("alpha", []))
    fixture = SwarmTeamFixture(team_dir=team_dir, state_path=state_path, cli=SwarmCli(state_path, cwd=workspace))
    fixture.cli.run("init", "--goal", "Ship the thing", "--use-worktrees", "true")
    return fixture


def _delivered_tasks() -> List[Dict[str, Any]]:
    """Two done tasks that name no repo — the shape every pre-epic task record had."""
    return [
        {
            "id": "T1", "title": "Add the endpoint", "role": "developer", "status": "done",
            "ownedPaths": ["src"], "evidence": {"summary": "Endpoint lands with tests."},
        },
        {
            "id": "T2", "title": "Wire the panel", "role": "frontend", "status": "done",
            "ownedPaths": ["src"], "evidence": {"summary": "Panel reads the endpoint."},
        },
    ]


# --- the tree a default run works in ------------------------------------------


def test_default_run_worktree_path_and_branch_are_the_pre_epic_ones(tmp_path) -> None:
    # AC1: path, branch, and the tree on disk. A sibling's `worktree-<id>` form must
    # not appear for a run that declared no sibling.
    fixture = _default_run(tmp_path)

    vcs = read_state(fixture.state_path)["sprintengine"]["vcs"]
    assert vcs["worktreePath"] == PRE_EPIC_WORKTREE_PATH
    assert vcs["branchName"] == PRE_EPIC_BRANCH_NAME
    assert (fixture.team_dir / "worktree").exists()
    assert list(fixture.team_dir.glob("worktree-*")) == []
    assert _git(fixture.team_dir / "worktree", "rev-parse", "--abbrev-ref", "HEAD").strip() == PRE_EPIC_BRANCH_NAME


def test_the_one_declared_repo_is_the_flat_block_it_always_was(tmp_path) -> None:
    # The list and the flat fields are one repo in two shapes: a reader of either sees
    # the same tree, which is what lets every pre-epic consumer keep reading flat.
    fixture = _default_run(tmp_path)

    vcs = read_state(fixture.state_path)["sprintengine"]["vcs"]
    repos = shell.vcs_repos(vcs)
    assert [repo["id"] for repo in repos] == [folder_store.DEFAULT_TASK_REPO]
    assert repos[0]["root"] == "."
    assert repos[0]["worktreePath"] == vcs["worktreePath"]
    assert repos[0]["branchName"] == vcs["branchName"]


# --- what a default run commits ------------------------------------------------


def test_default_run_commit_shape_is_the_pre_epic_one(tmp_path) -> None:
    # AC1: same message subject, same trailer body, same task-scoped file set. The
    # commit is what survives the run, so its shape is the load-bearing one.
    fixture = _default_run(tmp_path)
    state = read_state(fixture.state_path)
    state["tasks"] = _delivered_tasks()
    worktree = fixture.team_dir / "worktree"
    (worktree / "src").mkdir(parents=True, exist_ok=True)
    (worktree / "src" / "endpoint.ts").write_text("export const ok = true\n", encoding="utf-8")

    sha = shell.commit_run_worktree_paths(state, fixture.state_path, state["tasks"][0], "developer-1")

    assert sha
    assert _git(worktree, "log", "-1", "--pretty=%s").strip() == PRE_EPIC_COMMIT_SUBJECT
    assert _git(worktree, "log", "-1", "--pretty=%b").strip() == PRE_EPIC_COMMIT_BODY
    assert _git(worktree, "show", "--name-only", "--pretty=format:").split() == ["src/endpoint.ts"]


def test_a_task_naming_no_repo_still_commits_in_the_default_run(tmp_path) -> None:
    # Repo targeting must not become mandatory by the back door: every pre-epic task
    # record has no `repo` key, and a run full of them commits exactly as before.
    fixture = _default_run(tmp_path)
    state = read_state(fixture.state_path)
    state["tasks"] = _delivered_tasks()
    assert all("repo" not in task for task in state["tasks"])

    worktree = fixture.team_dir / "worktree"
    (worktree / "src").mkdir(parents=True, exist_ok=True)
    (worktree / "src" / "panel.tsx").write_text("export const Panel = null\n", encoding="utf-8")

    assert shell.commit_run_worktree_paths(state, fixture.state_path, state["tasks"][1], "frontend-1")
    assert folder_store.task_repo(state["tasks"][1]) == folder_store.DEFAULT_TASK_REPO


# --- the pull request a default run opens --------------------------------------


def test_default_run_pull_request_body_carries_no_companion_section(tmp_path) -> None:
    # AC2, and the epic's named risk: the body must not grow an empty "Companion pull
    # requests" section, and the per-repo task filter must be a no-op — both delivered
    # tasks name no repo, so both must still be listed.
    #
    # This pins the body the reviewer actually reads, transitively: T6's
    # `test_single_project_run_opens_exactly_one_unchanged_pull_request` asserts the
    # body handed to `gh pr create` IS this builder's output (and that pass two never
    # runs), so pinning the builder byte-for-byte pins what GitHub receives.
    fixture = _default_run(tmp_path)
    state = read_state(fixture.state_path)
    state["sprintengine"]["goal"] = "Ship the thing"
    state["tasks"] = _delivered_tasks()

    body = shell.build_run_pull_request_body(state, PRE_EPIC_BRANCH_NAME)

    assert body == SINGLE_PROJECT_PULL_REQUEST_BODY
    assert "Companion" not in body


# --- scheduling: repo is a filter, and with one repo it filters nothing ----------


def test_repo_targeting_is_a_no_op_filter_for_a_default_run(tmp_path) -> None:
    # AC3 (engine side): the repo a default run's tasks resolve to is the primary, so
    # every repo-keyed lookup returns the same answer for every task, and the one tree
    # is the answer for all of them. The scheduler half — a demand key that stays the
    # bare role — is `testDemandKeyIsRoleAndRepo` in
    # `src/shared/sprintengine/auto-run.test.ts`.
    fixture = _default_run(tmp_path)
    state = read_state(fixture.state_path)
    state["tasks"] = _delivered_tasks()

    repos = {folder_store.task_repo(task) for task in state["tasks"]}
    assert repos == {folder_store.DEFAULT_TASK_REPO}
    for task in state["tasks"]:
        # `worktree_for_task` resolves its path, so resolve both sides: a symlinked
        # temp dir must not be the reason this passes or fails.
        assert shell.worktree_for_task(state, fixture.state_path, task) == (fixture.team_dir / "worktree").resolve()


def test_every_orphan_in_a_default_run_is_reported_against_the_one_repo(tmp_path) -> None:
    # The orphan scan is per-repo now. With one repo it must still see the whole tree:
    # an orphan that stops a pre-epic run from completing must still stop this one.
    fixture = _default_run(tmp_path)
    state = read_state(fixture.state_path)
    state["tasks"] = _delivered_tasks()
    worktree = fixture.team_dir / "worktree"
    (worktree / "stray").mkdir(parents=True, exist_ok=True)
    (worktree / "stray" / "nobody-owns-this.ts").write_text("orphan\n", encoding="utf-8")

    orphans = shell.run_orphaned_dirty_paths(state, fixture.state_path)

    assert orphans == [{"repo": folder_store.DEFAULT_TASK_REPO, "path": "stray/nobody-owns-this.ts"}]
