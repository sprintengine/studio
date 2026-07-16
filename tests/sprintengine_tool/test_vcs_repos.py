"""The run's declared repo list and the v3 store rejection (MC-1611).

A run declares `sprintengine.vcs.repos`; every task targets one entry of it. Entry
zero is the primary repo (`root: "."`). Runs stored before the list existed
describe their one repo with the flat `vcs` fields, so `vcs_repos` reads both
shapes and callers only ever handle the list.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from sprintengine_core import store as folder_store
from sprintengine_core.tool import shell

FLAT_VCS = {
    "mode": "run_worktree",
    "worktreePath": ".multi-code/sprintengine/alpha/worktree",
    "branchName": "sprintengine/alpha",
    "baseRef": "main",
    "status": "committed",
    "lastCommitSha": "abc1234",
}


def _repos_vcs() -> dict:
    vcs = dict(FLAT_VCS)
    vcs["repos"] = [
        {
            "id": "primary",
            "root": ".",
            "worktreePath": ".multi-code/sprintengine/alpha/worktree",
            "branchName": "sprintengine/alpha",
            "baseRef": "main",
            "status": "committed",
            "lastCommitSha": "abc1234",
            "pullRequestUrl": "https://github.com/acme/multicode/pull/1",
            "pullRequestState": "open",
            "pullRequestError": None,
        },
        {
            "id": "mobile",
            "root": "../multicode-mobile",
            "worktreePath": ".multi-code/sprintengine/alpha/worktree-mobile",
            "branchName": "sprintengine/alpha",
            "baseRef": "main",
            "status": "ready",
            "lastCommitSha": None,
            "pullRequestUrl": None,
            "pullRequestState": None,
            "pullRequestError": None,
        },
    ]
    return vcs


def test_flat_vcs_reads_back_as_a_one_entry_repo_list() -> None:
    # AC2: the pre-list shape is a single-repo run described flat. It reads back as
    # the one-entry list it always semantically was, values identical.
    repos = shell.vcs_repos(FLAT_VCS)

    assert repos == [
        {
            "id": "primary",
            "root": ".",
            "worktreePath": ".multi-code/sprintengine/alpha/worktree",
            "branchName": "sprintengine/alpha",
            "baseRef": "main",
            "status": "committed",
            "lastCommitSha": "abc1234",
            "pullRequestUrl": None,
            "pullRequestState": None,
            "pullRequestError": None,
        }
    ]


def test_declared_repos_round_trip_with_no_field_loss() -> None:
    # AC1: every field of every declared entry survives normalization.
    assert shell.vcs_repos(_repos_vcs()) == _repos_vcs()["repos"]


def test_repos_shape_wins_over_the_flat_block() -> None:
    # The flat block is entry zero in the other shape. When both are present the
    # list is what callers get — never a third, merged repo.
    vcs = _repos_vcs()
    repos = shell.vcs_repos(vcs)

    assert [repo["id"] for repo in repos] == ["primary", "mobile"]


def test_repos_entry_missing_a_required_field_is_rejected_loudly() -> None:
    # A repo with no tree to resolve would scope commits to the wrong worktree.
    # Fail with the field named rather than dropping it into a silent default.
    vcs = _repos_vcs()
    del vcs["repos"][1]["worktreePath"]

    with pytest.raises(SystemExit) as excinfo:
        shell.vcs_repos(vcs)

    assert "vcs.repos[1]" in str(excinfo.value)
    assert "worktreePath" in str(excinfo.value)


def test_vcs_repos_of_a_non_worktree_run_is_empty() -> None:
    assert shell.vcs_repos(None) == []


def test_status_writes_reach_both_shapes() -> None:
    # The flat block and entry zero are the same repo stored twice while the app
    # still reads the flat one. A writer that updated only one would drift.
    vcs = _repos_vcs()

    shell.set_vcs_status(vcs, "pr_opened")
    shell.set_vcs_last_commit_sha(vcs, "def5678")

    assert vcs["status"] == vcs["repos"][0]["status"] == "pr_opened"
    assert vcs["lastCommitSha"] == vcs["repos"][0]["lastCommitSha"] == "def5678"
    # A sibling repo is not the primary and must not be touched by either writer.
    assert vcs["repos"][1]["status"] == "ready"
    assert vcs["repos"][1]["lastCommitSha"] is None


def test_pull_request_writes_reach_both_shapes_and_only_their_own_repo() -> None:
    # A run spanning projects has one pull request per project. The primary's is also
    # the flat block the app reads; a sibling's belongs to the sibling alone.
    vcs = _repos_vcs()

    shell.set_repo_pull_request(vcs, "mobile", url="https://github.com/acme/multicode-mobile/pull/9", state="open", error=None)
    shell.set_repo_pull_request(vcs, "primary", url=None, state=None, error="gh: could not authenticate")

    assert vcs["repos"][1]["pullRequestUrl"] == "https://github.com/acme/multicode-mobile/pull/9"
    assert vcs["repos"][1]["pullRequestState"] == "open"
    # The sibling's pull request is not the run's: the flat block stays the primary's.
    assert vcs["pullRequestUrl"] == vcs["repos"][0]["pullRequestUrl"] is None
    assert vcs["pullRequestError"] == vcs["repos"][0]["pullRequestError"] == "gh: could not authenticate"


def test_status_writes_on_a_flat_only_store_stay_flat() -> None:
    vcs = dict(FLAT_VCS)

    shell.set_vcs_status(vcs, "ready")

    assert vcs["status"] == "ready"
    assert "repos" not in vcs


def test_v3_store_is_rejected_naming_the_break_and_the_remedy(tmp_path: Path) -> None:
    # AC4. Standing policy: pre-release stores are rejected, never migrated — the
    # v3→v4 bump kills every existing run store, which is the point.
    team_dir = tmp_path / ".multi-code" / "sprintengine" / "alpha"

    with pytest.raises(folder_store.RunStoreVersionError) as excinfo:
        folder_store.assert_store_is_current({"schemaVersion": 3}, team_dir)

    message = str(excinfo.value)
    assert "schemaVersion 3" in message
    assert f"expected {folder_store.RUN_SCHEMA_VERSION}" in message
    assert "more than one repository" in message, "the message names the break"
    assert str(team_dir) in message and "re-run the sprint" in message, "and the remedy"


def test_current_store_is_accepted(tmp_path: Path) -> None:
    folder_store.assert_store_is_current({"schemaVersion": folder_store.RUN_SCHEMA_VERSION}, tmp_path)
