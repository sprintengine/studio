"""Tasks own modules, not files (backlog item 2019).

`ownedPaths` entries are the directories a task works in, and they are also its
commit pathspec — so the containment predicate, the plan-time refusal of a file
entry, the commit/orphan behaviour it buys, and the dispatch guard that keeps
coarse ownership safe are all one contract, covered here.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

from helpers import SwarmCli, SwarmTeamFixture, base_state, read_state, task, write_state
from sprintengine_core.tool.shell import module_contains_path, paths_overlap


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


def _worktree_run(tmp_path: Path, name: str, tasks: list[dict] | None = None) -> SwarmTeamFixture:
    """A worktree-mode run, optionally seeded with tasks the store already carried."""
    workspace = tmp_path / "ws"
    _init_git_repo(workspace)
    team_dir = workspace / ".multi-code" / "sprintengine" / name
    state_path = team_dir / "run.yaml"
    write_state(state_path, base_state(name, tasks or []))
    fixture = SwarmTeamFixture(team_dir=team_dir, state_path=state_path, cli=SwarmCli(state_path, cwd=workspace))
    fixture.cli.run("init", "--goal", f"Run {name}", "--use-worktrees", "true", "--agent", "developer:developer-1")
    return fixture


def _worktree_dir(fixture: SwarmTeamFixture) -> Path:
    return fixture.team_dir / "worktree"


def _close_plan_gate(fixture: SwarmTeamFixture) -> None:
    fixture.cli.run("task", "status", "--task-id", "T0", "--status", "done", "--id", "architect-1")


def _write(worktree: Path, relative: str, body: str) -> None:
    path = worktree / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")


# --- the containment predicate ------------------------------------------------


def test_a_module_contains_its_children_and_not_its_lookalike_sibling() -> None:
    # The pinned example: segment comparison, never string prefix.
    assert module_contains_path("payments-api/webhooks", "payments-api/webhooks/delivery.ts") is True
    assert module_contains_path("payments-api/webhooks", "payments-api/webhooks/retry/backoff.ts") is True
    assert module_contains_path("payments-api/webhooks", "payments-api/webhooks") is True
    assert module_contains_path("payments-api/webhooks", "payments-api/webhooks-v2/delivery.ts") is False
    assert module_contains_path("payments-api/webhooks", "payments-api/webhooks-v2") is False
    # Spelling of the same module does not change the answer.
    assert module_contains_path("payments-api/webhooks/", "payments-api/webhooks/delivery.ts") is True
    assert module_contains_path("./payments-api/webhooks", "payments-api/webhooks/delivery.ts") is True
    # A file entry from an older run store contains only itself.
    assert module_contains_path("src/panel.ts", "src/panel.ts") is True
    assert module_contains_path("src/panel.ts", "src/panel.test.ts") is False
    assert module_contains_path("", "src/panel.ts") is False


def test_overlap_is_symmetric_containment() -> None:
    assert paths_overlap("src/panel", "src/panel/detail") is True
    assert paths_overlap("src/panel/detail", "src/panel") is True
    assert paths_overlap("src/panel", "src/rail") is False
    assert paths_overlap("src/panel", "src/panel-v2") is False


# --- plan-time contract -------------------------------------------------------


def test_plan_add_task_rejects_a_file_and_names_the_module_to_declare(tmp_path) -> None:
    fixture = _worktree_run(tmp_path, "plan-time")
    _write(_worktree_dir(fixture), "src/panel/Panel.tsx", "export const Panel = 1\n")

    failure = fixture.cli.run_failure(
        "plan", "add-task", "--title", "Panel", "--role", "developer", "--task-id", "T1",
        "--path", "src/panel/Panel.tsx",
    )

    assert "is a file" in failure.stderr
    assert "`src/panel`" in failure.stderr


def test_plan_takes_a_directory_and_a_path_the_task_will_create(tmp_path) -> None:
    fixture = _worktree_run(tmp_path, "plan-time-ok")
    _write(_worktree_dir(fixture), "src/panel/Panel.tsx", "export const Panel = 1\n")

    added = fixture.cli.run(
        "plan", "add-task", "--title", "Panel", "--role", "developer", "--task-id", "T1",
        "--path", "src/panel", "--path", "src/rail",
    )

    # `src/rail` does not exist yet — it is a module this task is about to create,
    # which is exactly why existence is not the test; being a FILE is.
    assert added["task"]["ownedPaths"] == ["src/panel", "src/rail"]


def test_plan_update_task_refuses_a_file_entry_too(tmp_path) -> None:
    fixture = _worktree_run(tmp_path, "plan-time-update")
    fixture.cli.run("plan", "add-task", "--title", "Panel", "--role", "developer", "--task-id", "T1", "--path", "src/panel")
    _write(_worktree_dir(fixture), "src/panel/Panel.tsx", "export const Panel = 1\n")

    failure = fixture.cli.run_failure(
        "plan", "update-task", "--task-id", "T1", "--path", "src/panel/Panel.tsx"
    )

    assert "is a file" in failure.stderr


# --- what coarse ownership buys ----------------------------------------------


def test_files_created_inside_an_owned_module_are_committed_and_never_orphaned(tmp_path) -> None:
    # The live bug this contract closes: a file the agent legitimately added was in
    # no task's ownedPaths, so it was committed by nobody and reported as an orphan.
    fixture = _worktree_run(tmp_path, "module-commit")
    fixture.cli.run("plan", "add-task", "--title", "Panel", "--role", "developer", "--task-id", "T1", "--path", "src/panel")
    _close_plan_gate(fixture)
    claimed = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")
    assert claimed["claimed"] is True

    worktree = _worktree_dir(fixture)
    _write(worktree, "src/panel/Panel.tsx", "export { helper } from './helper'\n")
    _write(worktree, "src/panel/helper.ts", "export const helper = 1\n")
    _write(worktree, "src/panel/nested/deep.ts", "export const deep = 2\n")

    committed = fixture.cli.run("vcs", "commit", "--task-id", "T1", "--id", "developer-1")

    assert committed["committed"] is True
    assert committed["orphanedUncommittedPaths"] == []
    assert sorted(_git(worktree, "show", "--name-only", "--format=", "HEAD").stdout.split()) == [
        "src/panel/Panel.tsx",
        "src/panel/helper.ts",
        "src/panel/nested/deep.ts",
    ]
    # Nothing this task made is left behind for a later publish to block on.
    published = fixture.cli.run(
        "task", "publish", "--task-id", "T1", "--id", "developer-1", "--summary", "Panel module lands."
    )
    assert published["ok"] is True
    assert _git(worktree, "status", "--porcelain").stdout.strip() == ""


def test_a_lookalike_sibling_module_is_not_swept_into_the_commit(tmp_path) -> None:
    fixture = _worktree_run(tmp_path, "module-lookalike")
    fixture.cli.run("plan", "add-task", "--title", "Panel", "--role", "developer", "--task-id", "T1", "--path", "src/panel")
    _close_plan_gate(fixture)
    fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")

    worktree = _worktree_dir(fixture)
    _write(worktree, "src/panel/Panel.tsx", "export const Panel = 1\n")
    _write(worktree, "src/panel-v2/Panel.tsx", "export const PanelV2 = 2\n")

    committed = fixture.cli.run("vcs", "commit", "--task-id", "T1", "--id", "developer-1")

    assert committed["committed"] is True
    assert _git(worktree, "show", "--name-only", "--format=", "HEAD").stdout.split() == ["src/panel/Panel.tsx"]
    assert "src/panel-v2/" in _git(worktree, "status", "--porcelain").stdout


# --- the dispatch invariant ---------------------------------------------------


def test_overlapping_modules_never_hold_active_leases_at_the_same_time(tmp_path) -> None:
    fixture = _worktree_run(tmp_path, "module-guard")
    fixture.cli.run("plan", "add-task", "--title", "Panel", "--role", "developer", "--task-id", "T1", "--path", "src/panel")
    fixture.cli.run("plan", "add-task", "--title", "Detail", "--role", "developer", "--task-id", "T2", "--path", "src/panel/detail")
    _close_plan_gate(fixture)

    first = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")
    assert first["claimed"] is True and first["task"]["id"] == "T1"

    blocked = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-2")

    assert blocked["claimed"] is False
    assert blocked["reason"] == "module_held_by_active_task"
    assert blocked["blocker"]["taskId"] == "T1"
    assert blocked["blocker"]["module"] == "src/panel"
    assert blocked["blocker"]["workerId"] == "developer-1"
    assert "src/panel" in blocked["message"] and "T1" in blocked["message"]
    state = read_state(fixture.state_path)
    assert [t["id"] for t in state["tasks"] if t.get("lease")] == ["T1"]

    # The module frees with the task that held it.
    _write(_worktree_dir(fixture), "src/panel/Panel.tsx", "export const Panel = 1\n")
    fixture.cli.run("task", "publish", "--task-id", "T1", "--id", "developer-1", "--summary", "Panel lands.")
    fixture.cli.run(
        "task", "advance", "--task-id", "T1", "--id", "developer-1", "--phase", "review",
        "--outcome", "pass", "--summary", "Reviewed the panel diff.",
    )
    resumed = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-2")
    assert resumed["claimed"] is True and resumed["task"]["id"] == "T2"


def test_disjoint_modules_run_concurrently(tmp_path) -> None:
    fixture = _worktree_run(tmp_path, "module-disjoint")
    fixture.cli.run("plan", "add-task", "--title", "Panel", "--role", "developer", "--task-id", "T1", "--path", "src/panel")
    fixture.cli.run("plan", "add-task", "--title", "Rail", "--role", "developer", "--task-id", "T2", "--path", "src/rail")
    _close_plan_gate(fixture)

    first = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")
    second = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-2")

    assert first["claimed"] is True and first["task"]["id"] == "T1"
    assert second["claimed"] is True and second["task"]["id"] == "T2"
    state = read_state(fixture.state_path)
    assert sorted(t["id"] for t in state["tasks"] if t.get("lease")) == ["T1", "T2"]


def test_a_blocked_task_is_skipped_not_fatal(tmp_path) -> None:
    # A held module must not stall the queue behind it: the next ready task with
    # disjoint modules still runs.
    fixture = _worktree_run(tmp_path, "module-skip")
    fixture.cli.run("plan", "add-task", "--title", "Panel", "--role", "developer", "--task-id", "T1", "--path", "src/panel")
    fixture.cli.run("plan", "add-task", "--title", "Detail", "--role", "developer", "--task-id", "T2", "--path", "src/panel/detail")
    fixture.cli.run("plan", "add-task", "--title", "Rail", "--role", "developer", "--task-id", "T3", "--path", "src/rail")
    _close_plan_gate(fixture)
    fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")

    claimed = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-2")

    assert claimed["claimed"] is True
    assert claimed["task"]["id"] == "T3"


def test_direct_claim_cannot_bypass_the_module_guard(tmp_path) -> None:
    fixture = _worktree_run(tmp_path, "module-direct-claim")
    fixture.cli.run("plan", "add-task", "--title", "Panel", "--role", "developer", "--task-id", "T1", "--path", "src/panel")
    fixture.cli.run("plan", "add-task", "--title", "Detail", "--role", "developer", "--task-id", "T2", "--path", "src/panel/detail")
    _close_plan_gate(fixture)
    fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")

    refused = fixture.cli.run("task", "claim", "--task-id", "T2", "--id", "developer-2")

    assert refused["ok"] is False
    assert refused["reason"] == "module_held_by_active_task"
    assert refused["blocker"]["taskId"] == "T1"
    assert refused["blocker"]["module"] == "src/panel"
    state = read_state(fixture.state_path)
    assert [t["id"] for t in state["tasks"] if t.get("lease")] == ["T1"]


# --- migration ----------------------------------------------------------------


def test_a_run_store_with_file_level_owned_paths_dispatches_and_commits_unchanged(tmp_path) -> None:
    # Written before ownership moved to modules: file entries, one per task. The
    # containment predicate treats a file entry as itself, so nothing about this
    # run's dispatch or commit scope changes.
    fixture = _worktree_run(
        tmp_path,
        "legacy",
        [
            task("T1", "Alpha", "developer", owned_paths=["src/alpha.ts"]),
            task("T2", "Beta", "developer", owned_paths=["src/beta.ts"]),
        ],
    )
    worktree = _worktree_dir(fixture)
    _write(worktree, "src/alpha.ts", "export const alpha = 1\n")
    _write(worktree, "src/beta.ts", "export const beta = 2\n")

    first = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")
    second = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-2")
    assert first["claimed"] is True and first["task"]["id"] == "T1"
    # Distinct files are distinct scopes, so the pair still runs concurrently.
    assert second["claimed"] is True and second["task"]["id"] == "T2"

    committed = fixture.cli.run("vcs", "commit", "--task-id", "T1", "--id", "developer-1")

    assert committed["committed"] is True
    assert _git(worktree, "show", "--name-only", "--format=", "HEAD").stdout.split() == ["src/alpha.ts"]
    assert "src/beta.ts" in _git(worktree, "status", "--porcelain").stdout
