"""Publish-time commit scope (MC-2127).

Ownership moved from a plan-time guess to a publish-time fact. Nobody planning
work knows which files it will touch, so `ownedPaths` stopped being the commit
pathspec and became an optional scheduling advisory. What decides scope now:

- the agent's self-reported changed paths, when it gives them;
- otherwise a sweep of everything dirty MINUS what live siblings claim;
- and whatever is left over comes back as a QUESTION, never a refusal.

These pin the item's acceptance directly. The neighbouring behaviour — the
sibling fence, the segment-matching predicate, the multi-repo asymmetry — lives
in `test_owned_modules.py`, `test_run_worktree.py`, and
`test_multi_repo_execution.py`.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from helpers import SwarmCli, SwarmTeamFixture, base_state, get_task, read_state, write_state


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(
        ["git", *args], cwd=str(repo), text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False
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


def _worktree_run(tmp_path: Path, name: str) -> SwarmTeamFixture:
    workspace = tmp_path / "ws"
    _init_git_repo(workspace)
    team_dir = workspace / ".sprintengine" / "sprintengine" / name
    state_path = team_dir / "run.yaml"
    write_state(state_path, base_state(name, []))
    fixture = SwarmTeamFixture(team_dir=team_dir, state_path=state_path, cli=SwarmCli(state_path, cwd=workspace))
    fixture.cli.run("init", "--goal", f"Run {name}", "--use-worktrees", "true", "--agent", "developer:developer-1")
    return fixture


def _worktree_dir(fixture: SwarmTeamFixture) -> Path:
    return fixture.team_dir / "worktree"


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


def _head_files(worktree: Path) -> list[str]:
    return sorted(_git(worktree, "show", "--name-only", "--format=", "HEAD").stdout.split())


# --- a task with no declared scope at all -----------------------------------


def test_a_task_with_no_owned_paths_commits_everything_it_changed(tmp_path) -> None:
    """The headline: today this commits NOTHING.

    An empty `ownedPaths` used to build an empty pathspec, and an empty pathspec
    committed nothing at all — so a directly-imported task (which declares no
    modules by design) would publish with its whole diff stranded in the tree.
    """
    fixture = _worktree_run(tmp_path, "scope-noowned")
    fixture.cli.run("plan", "add-task", "--title", "Import", "--role", "developer", "--task-id", "T1")
    _close_plan_gate(fixture)
    _claim(fixture, "T1", "developer-1")

    assert get_task(read_state(fixture.state_path), "T1").get("ownedPaths") in (None, [])

    worktree = _worktree_dir(fixture)
    _write(worktree, "src/feature.ts", "export const f = 1\n")
    # A brand new directory nowhere near anything declared — the shape that used to
    # be "orphaned" and refused.
    _write(worktree, "docs/notes/new.md", "notes\n")

    published = fixture.cli.run(
        "task", "publish", "--task-id", "T1", "--id", "developer-1", "--summary", "Did the work."
    )

    assert published["ok"] is True
    assert published["committed"] is True
    assert _head_files(worktree) == ["docs/notes/new.md", "src/feature.ts"]
    assert _git(worktree, "status", "--porcelain").stdout.strip() == ""
    assert "uncommittedPaths" not in published


# --- the self-report and the question -----------------------------------------


def test_a_self_report_commits_exactly_what_it_names_and_asks_about_the_rest(tmp_path) -> None:
    fixture = _worktree_run(tmp_path, "scope-report")
    fixture.cli.run("plan", "add-task", "--title", "Feature", "--role", "developer", "--task-id", "T1")
    _close_plan_gate(fixture)
    _claim(fixture, "T1", "developer-1")

    worktree = _worktree_dir(fixture)
    _write(worktree, "src/feature.ts", "export const f = 1\n")
    _write(worktree, "scratch.txt", "left behind on purpose\n")

    published = fixture.cli.run(
        "task", "publish", "--task-id", "T1", "--id", "developer-1",
        "--summary", "Shipped the feature.", "--changed-path", "src/feature.ts",
    )

    assert published["ok"] is True
    assert _head_files(worktree) == ["src/feature.ts"]
    # The leftover is a question, not a refusal — and it names the way to include it.
    assert published["uncommittedPaths"] == ["scratch.txt"]
    assert "scratch.txt" in published["uncommittedPathsQuestion"]
    assert "--changed-path" in published["uncommittedPathsQuestion"]


def test_a_follow_up_publish_can_include_the_paths_the_question_asked_about(tmp_path) -> None:
    """The other half of "a question, not a refusal": answering it must work."""
    fixture = _worktree_run(tmp_path, "scope-followup")
    fixture.cli.run("plan", "add-task", "--title", "Feature", "--role", "developer", "--task-id", "T1")
    _close_plan_gate(fixture)
    _claim(fixture, "T1", "developer-1")

    worktree = _worktree_dir(fixture)
    _write(worktree, "src/feature.ts", "export const f = 1\n")
    _write(worktree, "scratch.txt", "actually mine\n")

    first = fixture.cli.run(
        "task", "publish", "--task-id", "T1", "--id", "developer-1",
        "--summary", "Shipped.", "--changed-path", "src/feature.ts",
    )
    assert first["uncommittedPaths"] == ["scratch.txt"]

    # Publish routed T1 into `review`; the reported leftover is committed through
    # the same targeted route the question names, with no plan edit anywhere.
    committed = fixture.cli.run(
        "vcs", "commit", "--task-id", "T1", "--id", "developer-1", "--path", "scratch.txt"
    )
    assert committed["committed"] is True
    assert _head_files(worktree) == ["scratch.txt"]
    assert _git(worktree, "status", "--porcelain").stdout.strip() == ""


# --- scope expansions are live claims ----------------------------------------


def test_a_scope_expanded_path_is_committed_and_fenced_off_from_siblings(tmp_path) -> None:
    """Rule 5: an expansion joins the claim set, in both directions.

    Publish used to ignore scope-expanded paths entirely — an agent logged the
    justification and the file still went uncommitted.
    """
    fixture = _worktree_run(tmp_path, "scope-expansion")
    fixture.cli.run(
        "plan", "add-task", "--title", "Alpha", "--role", "developer", "--task-id", "T1", "--path", "src/alpha",
    )
    fixture.cli.run(
        "plan", "add-task", "--title", "Beta", "--role", "developer", "--task-id", "T2", "--path", "src/beta",
    )
    _close_plan_gate(fixture)
    _claim(fixture, "T1", "developer-1")
    _claim(fixture, "T2", "developer-2")

    worktree = _worktree_dir(fixture)
    _write(worktree, "src/alpha/a.ts", "export const a = 1\n")
    _write(worktree, "src/shared/helper.ts", "export const h = 1\n")
    _write(worktree, "src/beta/b.ts", "export const b = 'T2 is mid-edit'\n")

    # T1 declares it is also working in src/shared.
    fixture.cli.run(
        "task", "log", "--task-id", "T1", "--id", "developer-1", "--summary", "Needed a shared helper.",
        "--scope-expansion-json", json.dumps({"path": "src/shared", "reason": "shared helper", "risk": "low"}),
    )
    state = read_state(fixture.state_path)
    assert [e["path"] for e in get_task(state, "T1")["evidence"]["scopeExpansions"]] == ["src/shared"]

    # T2 publishes FIRST. The expansion is a live claim, so T2's sweep leaves
    # src/shared alone even though nothing in T2's plan mentions it.
    fixture.cli.run("task", "publish", "--task-id", "T2", "--id", "developer-2", "--summary", "Beta done.")
    assert _head_files(worktree) == ["src/beta/b.ts"]

    # And T1's own publish carries the expanded path.
    fixture.cli.run("task", "publish", "--task-id", "T1", "--id", "developer-1", "--summary", "Alpha done.")
    assert _head_files(worktree) == ["src/alpha/a.ts", "src/shared/helper.ts"]
    assert _git(worktree, "status", "--porcelain").stdout.strip() == ""


def test_a_scope_expansion_serializes_dispatch_against_an_overlapping_task(tmp_path) -> None:
    """The same claim, read by the dispatch guard rather than the commit."""
    fixture = _worktree_run(tmp_path, "scope-expansion-dispatch")
    fixture.cli.run(
        "plan", "add-task", "--title", "Alpha", "--role", "developer", "--task-id", "T1", "--path", "src/alpha",
    )
    fixture.cli.run(
        "plan", "add-task", "--title", "Shared", "--role", "developer", "--task-id", "T2", "--path", "src/shared",
    )
    _close_plan_gate(fixture)
    _claim(fixture, "T1", "developer-1")

    fixture.cli.run(
        "task", "log", "--task-id", "T1", "--id", "developer-1", "--summary", "Expanding into shared.",
        "--scope-expansion-json", json.dumps({"path": "src/shared", "reason": "shared helper", "risk": "low"}),
    )

    # T2 would collide with T1's live expansion, so it must not be dispatched while
    # T1 holds it — the guard that makes the commit-time exclusion meaningful. Pin
    # the REASON too, so this cannot pass on capacity or readiness instead.
    blocked = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-2")
    assert blocked["claimed"] is False
    assert blocked["reason"] == "module_held_by_active_task"
    assert blocked["blocker"]["module"] == "src/shared"
    assert blocked["blocker"]["taskId"] == "T1"


# --- the guard, and the pre-change store -------------------------------------


def test_a_refused_publish_commits_nothing(tmp_path) -> None:
    """MC-2072's guard, retested against the widened scope code.

    Widening commit scope on an entry point any agent can call against another
    agent's task would have widened that hole too, which is why the guard landed
    first. The refusal must still happen before anything reaches git.
    """
    fixture = _worktree_run(tmp_path, "scope-owner")
    fixture.cli.run("plan", "add-task", "--title", "Feature", "--role", "developer", "--task-id", "T1")
    _close_plan_gate(fixture)
    _claim(fixture, "T1", "developer-1")

    worktree = _worktree_dir(fixture)
    _write(worktree, "src/feature.ts", "export const f = 1\n")
    head_before = _git(worktree, "rev-parse", "HEAD").stdout.strip()

    refused = fixture.cli.run_failure(
        "task", "publish", "--task-id", "T1", "--id", "developer-2", "--summary", "Not mine to publish.",
    )
    assert "not_task_owner" in refused.stderr
    # Nothing staged, nothing committed, and the tree is exactly as it was — the
    # sweep would otherwise have taken the whole tree into a stranger's commit.
    assert "src/feature.ts" in _git(worktree, "status", "--porcelain", "-uall").stdout
    assert _git(worktree, "rev-parse", "HEAD").stdout.strip() == head_before
    assert _git(worktree, "diff", "--cached", "--name-only").stdout.strip() == ""
    assert get_task(read_state(fixture.state_path), "T1")["ownerAgentId"] == "developer-1"


def test_a_pre_change_store_with_owned_paths_still_commits_its_work(tmp_path) -> None:
    """Migration: declared paths keep working, and now carry the rest of the diff too.

    Effective scope becomes the union of what was declared and what the new
    mechanisms find — so an existing store loses nothing.
    """
    fixture = _worktree_run(tmp_path, "scope-legacy")
    fixture.cli.run(
        "plan", "add-task", "--title", "Legacy", "--role", "developer", "--task-id", "T1", "--path", "src/legacy",
    )
    _close_plan_gate(fixture)
    _claim(fixture, "T1", "developer-1")

    worktree = _worktree_dir(fixture)
    _write(worktree, "src/legacy/thing.ts", "export const t = 1\n")

    published = fixture.cli.run(
        "task", "publish", "--task-id", "T1", "--id", "developer-1", "--summary", "Legacy work."
    )

    assert published["ok"] is True
    assert published["committed"] is True
    assert _head_files(worktree) == ["src/legacy/thing.ts"]
    assert published["nextStatus"] == "review"
    assert get_task(read_state(fixture.state_path), "T1")["ownedPaths"] == ["src/legacy"]
