"""Task repo targeting and its validation at creation and at claim (MC-1611).

A run declares a set of repos; a task targets exactly ONE of them, named by the
declared id and defaulting to the primary repo. The id is the only way to say
"the other repo" — `ownedPaths` stay relative to the target repo's root, and path
validation is unchanged, so a sibling repo is expressible only as (repo id,
relative path) and never as an absolute or `../` path.

The declared set is enforced in the same two places roles are:

  1. **At creation**, so a typo cannot be planned into the graph.
  2. **At claim**, so a task naming a repo the run does not declare fails loudly
     instead of silently resolving against the primary tree.

The claim also stamps the repo onto the lease, so the queue filter that selected
the worker and the tree its diff evidence is captured from cannot disagree.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from helpers import REPO_ROOT, create_team, get_task, read_state, task, write_state
from sprintengine_core import store as folder_store
from sprintengine_core.tool import shell
from sprintengine_core.tool.state import declared_repo_ids, ensure_task_repo_declared, task_lease


def _declare_repos(state_path: Path, *repo_ids: str) -> None:
    """Give the fixture run a worktree vcs block declaring `repo_ids` (primary first)."""
    state = read_state(state_path)
    state.setdefault("sprintengine", {})["vcs"] = {
        "mode": "run_worktree",
        "worktreePath": ".multi-code/sprintengine/alpha/worktree",
        "branchName": "sprintengine/alpha",
        "baseRef": "main",
        "status": "ready",
        "repos": [
            {
                "id": repo_id,
                "root": "." if index == 0 else f"../{repo_id}",
                "worktreePath": (
                    ".multi-code/sprintengine/alpha/worktree"
                    if index == 0
                    else f".multi-code/sprintengine/alpha/worktree-{repo_id}"
                ),
                "branchName": "sprintengine/alpha",
                "baseRef": "main",
                "status": "ready",
            }
            for index, repo_id in enumerate(repo_ids)
        ],
    }
    write_state(state_path, state)


# --- the default: a run that never mentions a repo is unchanged --------------


def test_task_with_no_repo_defaults_to_primary(tmp_path: Path) -> None:
    fixture = create_team(tmp_path, "repo-default", [])
    added = fixture.cli.run(
        "plan", "add-task", "--title", "Ship it", "--role", "developer", "--path", "src/x.ts"
    )
    assert added["task"]["repo"] == folder_store.DEFAULT_TASK_REPO
    assert get_task(read_state(fixture.state_path), added["task"]["id"])["repo"] == folder_store.DEFAULT_TASK_REPO


def test_a_run_with_no_vcs_block_declares_exactly_the_primary_repo(tmp_path: Path) -> None:
    """Non-worktree runs work in the workspace itself, so the boundary still has
    one legal target rather than none — `--repo primary` is accepted there."""
    fixture = create_team(tmp_path, "repo-no-vcs", [])
    assert declared_repo_ids(read_state(fixture.state_path)) == [folder_store.DEFAULT_TASK_REPO]
    added = fixture.cli.run(
        "plan", "add-task", "--title", "Ship it", "--role", "developer", "--repo", "primary"
    )
    assert added["task"]["repo"] == "primary"


def test_stored_task_without_the_repo_key_reads_as_primary() -> None:
    """Every task written before multi-repo runs targeted the run's one repo,
    which is entry zero today — so an absent key must not read as unknown."""
    assert folder_store.task_repo({"id": "T1", "role": "developer"}) == "primary"
    assert folder_store.task_repo({"id": "T1", "repo": "  "}) == "primary"
    assert folder_store.task_repo({"id": "T1", "repo": " mobile "}) == "mobile"


# --- creation-time validation -----------------------------------------------


def test_add_task_records_the_declared_sibling_repo(tmp_path: Path) -> None:
    fixture = create_team(tmp_path, "repo-add", [])
    _declare_repos(fixture.state_path, "primary", "mobile")

    added = fixture.cli.run(
        "plan", "add-task",
        "--title", "Phone consumer",
        "--role", "developer",
        "--repo", "mobile",
        "--path", "src/x.ts",
    )

    assert added["task"]["repo"] == "mobile"
    stored = get_task(read_state(fixture.state_path), added["task"]["id"])
    assert stored["repo"] == "mobile"
    # The path is recorded relative to the TARGET repo's root, not rewritten to
    # reach it from the primary one.
    assert stored["ownedPaths"] == ["src/x.ts"]


def test_add_task_rejects_an_undeclared_repo_naming_the_declared_ones(tmp_path: Path) -> None:
    fixture = create_team(tmp_path, "repo-add-unknown", [])
    _declare_repos(fixture.state_path, "primary", "mobile")

    failure = fixture.cli.run_failure(
        "plan", "add-task", "--title", "Nope", "--role", "developer", "--repo", "unknown"
    )

    message = failure.stdout + failure.stderr
    assert "unknown" in message
    assert "primary, mobile" in message
    assert read_state(fixture.state_path)["tasks"] == []


def test_update_task_rejects_an_undeclared_repo(tmp_path: Path) -> None:
    fixture = create_team(tmp_path, "repo-update", [task("T1", "Retarget me", "developer")])
    _declare_repos(fixture.state_path, "primary", "mobile")

    fixture.cli.run_failure("plan", "update-task", "--task-id", "T1", "--repo", "unknown")
    assert folder_store.task_repo(get_task(read_state(fixture.state_path), "T1")) == "primary"

    fixture.cli.run("plan", "update-task", "--task-id", "T1", "--repo", "mobile")
    assert get_task(read_state(fixture.state_path), "T1")["repo"] == "mobile"


# --- path validation is NOT weakened by repo targeting ----------------------


@pytest.mark.parametrize("bad_path", ["/etc/passwd", "../multicode-mobile/src/x.ts", "~/x.ts"])
def test_repo_targeting_does_not_admit_escaping_paths(tmp_path: Path, bad_path: str) -> None:
    """The declared id is the ONLY way to name another repo. A path that tries to
    walk there stays rejected — with or without a `--repo` on the same task."""
    fixture = create_team(tmp_path, "repo-paths", [])
    _declare_repos(fixture.state_path, "primary", "mobile")

    for repo_args in ((), ("--repo", "mobile")):
        failure = fixture.cli.run_failure(
            "plan", "add-task", "--title", "Escape", "--role", "developer", "--path", bad_path, *repo_args
        )
        assert "--path" in failure.stdout + failure.stderr
    assert read_state(fixture.state_path)["tasks"] == []


# --- claim-time validation --------------------------------------------------


def test_claim_rejects_a_task_targeting_an_undeclared_repo(tmp_path: Path) -> None:
    """The second gate: a task whose repo the run does not declare (a store from
    another era, a hand edit) must fail at claim rather than quietly resolving
    against the primary tree."""
    fixture = create_team(tmp_path, "repo-claim-unknown", [])
    _declare_repos(fixture.state_path, "primary", "mobile")
    state = read_state(fixture.state_path)
    stray = task("T1", "Wrong tree", "developer")
    stray["repo"] = "gone"
    state["tasks"] = [stray]
    write_state(fixture.state_path, state)

    for args in (
        ("task", "next", "--role", "developer", "--id", "developer-1"),
        ("task", "claim", "--task-id", "T1", "--id", "developer-1"),
    ):
        failure = fixture.cli.run_failure(*args)
        message = failure.stdout + failure.stderr
        assert "gone" in message and "primary, mobile" in message
    assert get_task(read_state(fixture.state_path), "T1")["status"] == "todo"


def test_claim_stamps_the_task_repo_onto_the_lease(tmp_path: Path) -> None:
    fixture = create_team(tmp_path, "repo-claim-lease", [])
    _declare_repos(fixture.state_path, "primary", "mobile")
    state = read_state(fixture.state_path)
    targeted = task("T1", "Phone consumer", "developer")
    targeted["repo"] = "mobile"
    state["tasks"] = [targeted]
    write_state(fixture.state_path, state)

    claimed = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")

    assert claimed["claimed"] is True
    assert claimed["task"]["repo"] == "mobile"
    # The lease is the assignment authority, so IT carries the tree the worker
    # commits in — the queue filter and the diff capture read the same field.
    assert task_lease(get_task(read_state(fixture.state_path), "T1"))["repo"] == "mobile"


def test_lease_repo_reaches_the_projection_worker_view(tmp_path: Path) -> None:
    fixture = create_team(tmp_path, "repo-worker-view", [])
    _declare_repos(fixture.state_path, "primary", "mobile")
    state = read_state(fixture.state_path)
    targeted = task("T1", "Phone consumer", "developer")
    targeted["repo"] = "mobile"
    state["tasks"] = [targeted]
    write_state(fixture.state_path, state)

    claimed = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")

    assert claimed["agent"]["repo"] == "mobile"
    projection = folder_store.build_projection(fixture.state_path.parent)
    assert projection["workers"]["developer-1"]["repo"] == "mobile"
    assert [t["repo"] for t in projection["tasks"]] == ["mobile"]


def test_ensure_task_repo_declared_returns_the_clean_id(tmp_path: Path) -> None:
    fixture = create_team(tmp_path, "repo-helper", [])
    _declare_repos(fixture.state_path, "primary", "mobile")
    state = read_state(fixture.state_path)

    assert ensure_task_repo_declared(state, " mobile ", context="Task T1") == "mobile"
    assert ensure_task_repo_declared(state, None, context="Task T1") == "primary"
    with pytest.raises(SystemExit) as excinfo:
        ensure_task_repo_declared(state, "unknown", context="Task T1")
    assert "Task T1" in str(excinfo.value)


# --- the default repo id is spelled in three places -------------------------


def test_default_task_repo_matches_its_mirrors() -> None:
    """store.py names the default; shell.py names entry zero; the renderer keeps
    its own copy. All three are the same repo — drift here is the known bug class."""
    assert folder_store.DEFAULT_TASK_REPO == shell.PRIMARY_REPO_ID

    source = (REPO_ROOT / "src/shared/sprintengine/run-types.ts").read_text(encoding="utf-8")
    match = re.search(r"export const DEFAULT_SPRINTENGINE_TASK_REPO = '([^']+)'", source)
    assert match, "DEFAULT_SPRINTENGINE_TASK_REPO not found in src/shared/sprintengine/run-types.ts"
    assert match.group(1) == folder_store.DEFAULT_TASK_REPO
