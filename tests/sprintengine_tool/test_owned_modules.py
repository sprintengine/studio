"""Tasks own modules, not files (backlog item 2019).

`ownedPaths` entries are the directories a task works in, and they are also its
commit pathspec — so the containment predicate, the plan-time refusal of a file
entry, the commit/orphan behaviour it buys, and the dispatch guard that keeps
coarse ownership safe are all one contract, covered here.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

from helpers import SwarmCli, SwarmTeamFixture, base_state, create_team, read_state, task, write_state
from sprintengine_core.tool.shell import module_contains_path, paths_overlap
from sprintengine_mcp import SprintEngineMcpServer


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


def test_the_project_root_is_a_module_that_contains_everything() -> None:
    # `.` is a directory, so the plan-time rule accepts it, and telling architects
    # to declare directories makes it the natural spelling for "the whole tree".
    # Segment comparison alone answers False for every candidate, which would make
    # such a task own nothing and commit nothing — silently.
    for spelling in (".", "./", "  .  "):
        assert module_contains_path(spelling, "src/panel/Panel.tsx") is True
        assert module_contains_path(spelling, "README.md") is True
    assert paths_overlap(".", "src/panel") is True
    # Only the PROJECT root is special. A blank entry is unusable, and an absolute
    # root owns nothing — absolute entries are dropped from every commit pathspec,
    # and the dispatch guard does not filter them, so promoting `/` to the project
    # root would silently make it overlap every module in the run.
    assert module_contains_path("", "src/panel/Panel.tsx") is False
    assert module_contains_path("/", "src/panel/Panel.tsx") is False
    assert paths_overlap("/", "src/panel") is False
    assert module_contains_path("src/panel", ".") is False


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
    # The refusal leaves the task exactly as it was — no half-applied replacement.
    stored = read_state(fixture.state_path)["tasks"]
    assert [t["ownedPaths"] for t in stored if t["id"] == "T1"] == [["src/panel"]]


def test_the_mcp_boundary_refuses_a_file_entry_too(tmp_path) -> None:
    # The surface architects actually plan through, and the surface the contract
    # is documented on (`path` in sprintengine.plan.add_task).
    fixture = create_team(tmp_path, "mcp-modules", [task("T1", "Seed", "developer")])
    (tmp_path / "src" / "panel").mkdir(parents=True)
    (tmp_path / "src" / "panel" / "Panel.tsx").write_text("export const Panel = 1\n", encoding="utf-8")
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])
    request = {"statePath": str(fixture.state_path), "title": "Panel", "role": "developer"}
    caller = {"id": "architect-1", "role": "architect", "mcpAuthorized": True}

    refused = server.call_tool(
        "sprintengine.plan.add_task", {**request, "path": ["src/panel/Panel.tsx"]}, caller
    )
    accepted = server.call_tool(
        "sprintengine.plan.add_task", {**request, "path": ["src/panel"]}, caller
    )

    assert refused["ok"] is False
    assert "`src/panel`" in refused["error"]["message"]
    assert accepted["ok"] is True
    # The refusal is not a half-write: only the module-owning task entered the store.
    stored = read_state(fixture.state_path)["tasks"]
    assert [t["title"] for t in stored] == ["Seed", "Panel"]
    assert stored[1]["ownedPaths"] == ["src/panel"]


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


def test_a_root_module_owns_and_commits_the_whole_tree(tmp_path) -> None:
    fixture = _worktree_run(tmp_path, "module-root")
    fixture.cli.run("plan", "add-task", "--title", "Whole", "--role", "developer", "--task-id", "T1", "--path", ".")
    _close_plan_gate(fixture)
    fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")

    worktree = _worktree_dir(fixture)
    _write(worktree, "src/alpha/a.ts", "export const a = 1\n")
    _write(worktree, "docs/note.md", "note\n")

    committed = fixture.cli.run("vcs", "commit", "--task-id", "T1", "--id", "developer-1")

    assert committed["committed"] is True
    assert committed["orphanedUncommittedPaths"] == []
    assert sorted(_git(worktree, "show", "--name-only", "--format=", "HEAD").stdout.split()) == [
        "docs/note.md",
        "src/alpha/a.ts",
    ]


def test_a_live_siblings_module_is_never_swept_in_by_a_declared_path(tmp_path) -> None:
    """The dispatch guard reads ownedPaths; the commit pathspec is wider than that.

    It also carries evidence-declared touched files and explicit `--path`, so two
    tasks with DISJOINT modules — which correctly run concurrently — could still
    have one commit stage the other's half-finished work through that channel.
    """
    fixture = _worktree_run(tmp_path, "module-foreign")
    fixture.cli.run("plan", "add-task", "--title", "Alpha", "--role", "developer", "--task-id", "T1", "--path", "src/alpha")
    fixture.cli.run("plan", "add-task", "--title", "Beta", "--role", "developer", "--task-id", "T2", "--path", "src/beta")
    _close_plan_gate(fixture)
    assert fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")["claimed"] is True
    assert fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-2")["claimed"] is True

    worktree = _worktree_dir(fixture)
    _write(worktree, "src/alpha/a.ts", "export const a = 1\n")
    _write(worktree, "src/beta/b.ts", "export const b = 'T2 is mid-edit'\n")
    _write(worktree, "src/beta/nested/c.ts", "export const c = 'T2 is mid-edit'\n")

    # T1 declares a touched file in T2's module, and passes T2's whole module as an
    # explicit path — the vocabulary coarse ownership hands every agent.
    fixture.cli.run(
        "task", "log", "--task-id", "T1", "--id", "developer-1",
        "--summary", "Needed a beta hook.", "--file", "src/beta/b.ts",
    )
    fixture.cli.run("vcs", "commit", "--task-id", "T1", "--id", "developer-1", "--path", "src/beta")

    assert _git(worktree, "show", "--name-only", "--format=", "HEAD").stdout.split() == ["src/alpha/a.ts"]
    # T2's work is untouched and still its own to commit.
    status = _git(worktree, "status", "--porcelain", "--untracked-files=all").stdout
    assert "src/beta/b.ts" in status and "src/beta/nested/c.ts" in status


def test_a_declared_path_outside_every_live_module_still_commits(tmp_path) -> None:
    # The exclusion is scoped to LIVE siblings: an ordinary scope expansion into a
    # module nobody is working still rides the task's own commit.
    fixture = _worktree_run(tmp_path, "module-expansion")
    fixture.cli.run("plan", "add-task", "--title", "Alpha", "--role", "developer", "--task-id", "T1", "--path", "src/alpha")
    fixture.cli.run("plan", "add-task", "--title", "Beta", "--role", "developer", "--task-id", "T2", "--path", "src/beta")
    _close_plan_gate(fixture)
    fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")

    worktree = _worktree_dir(fixture)
    _write(worktree, "src/alpha/a.ts", "export const a = 1\n")
    _write(worktree, "src/beta/b.ts", "export const b = 1\n")
    fixture.cli.run(
        "task", "log", "--task-id", "T1", "--id", "developer-1",
        "--summary", "Needed a beta hook.", "--file", "src/beta/b.ts",
    )

    fixture.cli.run("vcs", "commit", "--task-id", "T1", "--id", "developer-1")

    # T2 is ready, not live, so nothing of its module is half-finished to protect.
    assert sorted(_git(worktree, "show", "--name-only", "--format=", "HEAD").stdout.split()) == [
        "src/alpha/a.ts",
        "src/beta/b.ts",
    ]


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


def test_legacy_tasks_sharing_one_file_now_serialize(tmp_path) -> None:
    """The half of migration that is NOT unchanged, and is not meant to be.

    Commit scope on a pre-change store is identical — a file entry contains only
    itself. Dispatch is not: the guard is unconditional, so two legacy tasks both
    listing `src/shared.ts` serialize where they used to run concurrently. That is
    the item's own argument applied to a file: both tasks commit that file, so
    whoever commits first takes the other's in-progress edits to it.
    """
    fixture = _worktree_run(
        tmp_path,
        "legacy-shared-file",
        [
            task("T1", "Alpha", "developer", owned_paths=["src/shared.ts", "src/alpha.ts"]),
            task("T2", "Beta", "developer", owned_paths=["src/shared.ts", "src/beta.ts"]),
        ],
    )

    first = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")
    second = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-2")

    assert first["claimed"] is True and first["task"]["id"] == "T1"
    assert second["claimed"] is False
    assert second["reason"] == "module_held_by_active_task"
    assert second["blocker"]["module"] == "src/shared.ts"
    assert second["blocker"]["taskId"] == "T1"
