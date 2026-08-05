"""A worktree per task (MC-2130) — isolation replaces ownership.

`ownedPaths` only ever existed because agents shared one working tree: git
cannot attribute uncommitted edits, so pre-declared paths acted as file claims
keeping sibling WIP out of your commit. Give each task its own worktree and
"commit everything I changed" becomes trivially safe — no sibling WIP can exist
in the tree — and the residual collision window MC-2127 left open closes.

Conflicts stop being invisible shared-tree races and become ordinary git merges
at a defined integration point: publish commits in the task's tree, then merges
onto the run branch, serialized per repo. A conflict is never auto-resolved.

Off by default: whether isolation becomes the default is the open owner question
on `sprint-worktree-mode-unreachable`. These pin the mechanism either way.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

from helpers import SwarmCli, SwarmTeamFixture, base_state, get_task, read_state, write_state
from sprintengine_mcp import ActorContext, McpRequestContext, SprintEngineMcpServer


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
    (root / "shared.ts").write_text("export const shared = 0\n", encoding="utf-8")
    _git(root, "add", "-A")
    _git(root, "commit", "-qm", "seed")


def _isolated_run(tmp_path: Path, name: str, *, isolation: bool = True) -> SwarmTeamFixture:
    workspace = tmp_path / "ws"
    _init_git_repo(workspace)
    team_dir = workspace / ".multi-code" / "sprintengine" / name
    state_path = team_dir / "run.yaml"
    write_state(state_path, base_state(name, []))
    fixture = SwarmTeamFixture(team_dir=team_dir, state_path=state_path, cli=SwarmCli(state_path, cwd=workspace))
    fixture.cli.run(
        "init",
        "--goal", f"Run {name}",
        "--use-worktrees", "true",
        "--task-worktrees", "true" if isolation else "false",
        "--agent", "developer:developer-1",
    )
    return fixture


def _run_worktree(fixture: SwarmTeamFixture) -> Path:
    return fixture.team_dir / "worktree"


def _task_worktree(fixture: SwarmTeamFixture, task_id: str) -> Path:
    return fixture.team_dir / "task-worktrees" / task_id / "primary"


def _close_plan_gate(fixture: SwarmTeamFixture) -> None:
    fixture.cli.run("task", "status", "--task-id", "T0", "--status", "done", "--id", "architect-1")


def _write(worktree: Path, relative: str, body: str) -> None:
    path = worktree / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")


def _branch_files(worktree: Path, ref: str = "HEAD") -> list[str]:
    return sorted(_git(worktree, "show", "--name-only", "--format=", ref).stdout.split())


# --- provisioning and routing -------------------------------------------------


def test_a_claim_provisions_the_task_its_own_worktree(tmp_path) -> None:
    fixture = _isolated_run(tmp_path, "iso-claim")
    fixture.cli.run("plan", "add-task", "--title", "Alpha", "--role", "developer", "--task-id", "T1")
    _close_plan_gate(fixture)

    assert not _task_worktree(fixture, "T1").exists(), "nothing is provisioned before the claim"
    fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")

    worktree = _task_worktree(fixture, "T1")
    assert worktree.exists(), "claiming provisions the task's tree"
    # Its own branch, off the run branch — two worktrees cannot share one branch.
    # The branch is lowercased by the git-ref sanitizer; the PATH keeps its case,
    # so the tree resolves the same on a case-sensitive filesystem.
    assert _git(worktree, "branch", "--show-current").stdout.strip() == "sprintengine/iso-claim-task-t1"
    assert (worktree / "README.md").exists(), "the tree is a real checkout of the run branch"


def test_nothing_is_provisioned_when_isolation_is_off(tmp_path) -> None:
    """The default: today's one shared checkout per repo per run."""
    fixture = _isolated_run(tmp_path, "iso-off", isolation=False)
    fixture.cli.run("plan", "add-task", "--title", "Alpha", "--role", "developer", "--task-id", "T1")
    _close_plan_gate(fixture)
    fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")

    assert not _task_worktree(fixture, "T1").exists()


# --- the commit, and what it contains -----------------------------------------


def test_a_publish_commits_everything_in_the_tree_and_nothing_from_a_sibling(tmp_path) -> None:
    """The acceptance: every file changed in its worktree, new files included."""
    fixture = _isolated_run(tmp_path, "iso-commit")
    fixture.cli.run("plan", "add-task", "--title", "Alpha", "--role", "developer", "--task-id", "T1")
    fixture.cli.run("plan", "add-task", "--title", "Beta", "--role", "developer", "--task-id", "T2")
    _close_plan_gate(fixture)
    fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")
    fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-2")

    alpha = _task_worktree(fixture, "T1")
    beta = _task_worktree(fixture, "T2")
    _write(alpha, "src/alpha.ts", "export const a = 1\n")
    _write(alpha, "brand/new/dir/file.ts", "export const n = 1\n")
    _write(beta, "src/beta.ts", "export const b = 1\n")

    fixture.cli.run("task", "publish", "--task-id", "T1", "--id", "developer-1", "--summary", "Alpha.")

    # Alpha's own commit carries both its files, including the file in a directory
    # no plan ever mentioned — and nothing of Beta's, which is in another tree.
    assert _branch_files(alpha) == ["brand/new/dir/file.ts", "src/alpha.ts"]
    assert _git(alpha, "status", "--porcelain").stdout.strip() == ""
    assert not (alpha / "src" / "beta.ts").exists()


def test_the_orphan_report_is_structurally_empty(tmp_path) -> None:
    """Nothing can be orphaned in a tree only one task writes."""
    fixture = _isolated_run(tmp_path, "iso-orphan")
    fixture.cli.run("plan", "add-task", "--title", "Alpha", "--role", "developer", "--task-id", "T1")
    _close_plan_gate(fixture)
    fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")

    worktree = _task_worktree(fixture, "T1")
    _write(worktree, "src/alpha.ts", "export const a = 1\n")
    _write(worktree, "wherever/stray.ts", "export const s = 1\n")

    committed = fixture.cli.run("vcs", "commit", "--task-id", "T1", "--id", "developer-1")
    assert committed["committed"] is True
    assert committed["orphanedUncommittedPaths"] == []
    assert _branch_files(worktree) == ["src/alpha.ts", "wherever/stray.ts"]


# --- integration, and the conflict that is not auto-resolved ------------------


def test_a_publish_integrates_onto_the_run_branch(tmp_path) -> None:
    fixture = _isolated_run(tmp_path, "iso-integrate")
    fixture.cli.run("plan", "add-task", "--title", "Alpha", "--role", "developer", "--task-id", "T1")
    _close_plan_gate(fixture)
    fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")

    _write(_task_worktree(fixture, "T1"), "src/alpha.ts", "export const a = 1\n")
    fixture.cli.run("task", "publish", "--task-id", "T1", "--id", "developer-1", "--summary", "Alpha.")

    run_tree = _run_worktree(fixture)
    assert (run_tree / "src" / "alpha.ts").exists(), "the work is on the run branch"
    state = read_state(fixture.state_path)
    assert any(event["type"] == "task_work_integrated" for event in state["events"])


def test_a_conflict_comes_back_as_rework_and_the_run_branch_is_untouched(tmp_path) -> None:
    """Two concurrent tasks editing the same file: the second is told, not merged.

    The headline acceptance. Both tasks publish; the second integration reports a
    conflict to ITS agent rather than silently merging or sweeping, and after the
    rework publish the run branch carries both changes.
    """
    fixture = _isolated_run(tmp_path, "iso-conflict")
    fixture.cli.run("plan", "add-task", "--title", "Alpha", "--role", "developer", "--task-id", "T1")
    fixture.cli.run("plan", "add-task", "--title", "Beta", "--role", "developer", "--task-id", "T2")
    _close_plan_gate(fixture)
    fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")
    fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-2")

    alpha = _task_worktree(fixture, "T1")
    beta = _task_worktree(fixture, "T2")
    # Both edit the SAME line of the same file — dependency-free, so they ran
    # concurrently, which the module guard permits because neither declares one.
    _write(alpha, "shared.ts", "export const shared = 'alpha'\n")
    _write(beta, "shared.ts", "export const shared = 'beta'\n")

    fixture.cli.run("task", "publish", "--task-id", "T1", "--id", "developer-1", "--summary", "Alpha.")
    run_tree = _run_worktree(fixture)
    head_after_alpha = _git(run_tree, "rev-parse", "HEAD").stdout.strip()

    refused = fixture.cli.run_failure(
        "task", "publish", "--task-id", "T2", "--id", "developer-2", "--summary", "Beta.",
    )
    assert "shared.ts" in refused.stderr, "the conflicting path is named"
    assert "rebase" in refused.stderr, "the way out is named"
    # Never auto-resolved: the run branch is exactly where Alpha left it.
    assert _git(run_tree, "rev-parse", "HEAD").stdout.strip() == head_after_alpha
    assert "beta" not in (run_tree / "shared.ts").read_text(encoding="utf-8")
    # Beta's own commit is safe on its own branch, and its task is still its own.
    assert _branch_files(beta) == ["shared.ts"]
    assert get_task(read_state(fixture.state_path), "T2")["status"] == "in_progress"

    # The rework: Beta rebases onto the run branch, resolves, and republishes.
    _git(beta, "fetch", str(run_tree.resolve()), "sprintengine/iso-conflict")
    merge = subprocess.run(
        ["git", "merge", "FETCH_HEAD"], cwd=str(beta), text=True, capture_output=True, check=False
    )
    assert merge.returncode != 0, "the merge conflicts in the task's own tree, as expected"
    _write(beta, "shared.ts", "export const shared = 'alpha and beta'\n")
    _git(beta, "add", "shared.ts")
    _git(beta, "commit", "-qm", "Resolve the conflict")

    fixture.cli.run("task", "publish", "--task-id", "T2", "--id", "developer-2", "--summary", "Beta, rebased.")
    assert "alpha and beta" in (run_tree / "shared.ts").read_text(encoding="utf-8")


# --- lifecycle ----------------------------------------------------------------


def test_a_landed_tasks_worktree_disappears(tmp_path) -> None:
    fixture = _isolated_run(tmp_path, "iso-land", isolation=True)
    fixture.cli.run(
        "plan", "add-task", "--title", "Alpha", "--role", "developer", "--task-id", "T1", "--phases", "",
    )
    _close_plan_gate(fixture)
    fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")
    _write(_task_worktree(fixture, "T1"), "src/alpha.ts", "export const a = 1\n")

    published = fixture.cli.run(
        "task", "publish", "--task-id", "T1", "--id", "developer-1", "--summary", "Alpha.",
    )
    assert published["nextStatus"] == "done", "a no-phase task lands straight to done"
    assert not _task_worktree(fixture, "T1").exists(), "a landed task's tree is reclaimed"
    # And its work is on the run branch, which is what made the tree disposable.
    assert (_run_worktree(fixture) / "src" / "alpha.ts").exists()


def test_a_canceled_tasks_worktree_disappears_without_integrating(tmp_path) -> None:
    fixture = _isolated_run(tmp_path, "iso-cancel")
    fixture.cli.run("plan", "add-task", "--title", "Alpha", "--role", "developer", "--task-id", "T1")
    _close_plan_gate(fixture)
    fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")
    _write(_task_worktree(fixture, "T1"), "src/alpha.ts", "export const a = 1\n")

    fixture.cli.run("task", "status", "--task-id", "T1", "--status", "canceled", "--id", "architect-1")

    assert not _task_worktree(fixture, "T1").exists()
    # Deliberately dropped: the run decided against this work, so it must not land.
    assert not (_run_worktree(fixture) / "src" / "alpha.ts").exists()


def test_canceling_the_run_sweeps_every_task_worktree_it_still_holds(tmp_path) -> None:
    """The backstop for an abandoned run: per-task cleanup never got to run."""
    fixture = _isolated_run(tmp_path, "iso-sweep")
    fixture.cli.run("plan", "add-task", "--title", "Alpha", "--role", "developer", "--task-id", "T1")
    fixture.cli.run("plan", "add-task", "--title", "Beta", "--role", "developer", "--task-id", "T2")
    _close_plan_gate(fixture)
    fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")
    fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-2")
    _write(_task_worktree(fixture, "T1"), "src/alpha.ts", "export const a = 1\n")
    assert _task_worktree(fixture, "T1").exists() and _task_worktree(fixture, "T2").exists()

    canceled = fixture.cli.run("cancel", "--id", "user")

    assert sorted(canceled["removedTaskWorktrees"]) == ["T1", "T2"]
    assert not _task_worktree(fixture, "T1").exists()
    assert not _task_worktree(fixture, "T2").exists()
    # The RUN worktree is deliberately left in place, exactly as before.
    assert _run_worktree(fixture).exists()
    assert not (_run_worktree(fixture) / "src" / "alpha.ts").exists()


def test_isolation_cannot_be_flipped_by_a_second_init(tmp_path) -> None:
    """Fixed at creation, like the worktree toggle and the repo set.

    Flipping it mid-run would change which tree live tasks' commits are read
    from, and strand the trees already provisioned around the old answer.
    """
    fixture = _isolated_run(tmp_path, "iso-fixed")
    # Re-declaring the same value is an idempotent no-op.
    fixture.cli.run("init", "--goal", "Run iso-fixed", "--use-worktrees", "true", "--task-worktrees", "true")

    refused = fixture.cli.run_failure(
        "init", "--goal", "Run iso-fixed", "--use-worktrees", "true", "--task-worktrees", "false",
    )
    assert "fixed at creation" in refused.stderr
    assert read_state(fixture.state_path)["sprintengine"]["vcs"]["taskIsolation"] is True


def test_run_level_operations_still_read_the_run_branch(tmp_path) -> None:
    """Isolation is invisible above the task: the run's tree and branch are its own."""
    fixture = _isolated_run(tmp_path, "iso-runlevel")
    fixture.cli.run(
        "plan", "add-task", "--title", "Alpha", "--role", "developer", "--task-id", "T1", "--phases", "",
    )
    _close_plan_gate(fixture)
    fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")
    _write(_task_worktree(fixture, "T1"), "src/alpha.ts", "export const a = 1\n")
    fixture.cli.run("task", "publish", "--task-id", "T1", "--id", "developer-1", "--summary", "Alpha.")

    status = fixture.cli.run("vcs", "status")
    vcs = read_state(fixture.state_path)["sprintengine"]["vcs"]
    # The recorded worktree and branch are still the RUN's — what the diff view,
    # the board, and PR creation all resolve through.
    assert vcs["worktreePath"] == ".multi-code/sprintengine/iso-runlevel/worktree"
    assert vcs["branchName"] == "sprintengine/iso-runlevel"
    primary = next(repo for repo in status["repos"] if repo["id"] == "primary")
    assert primary["branchName"] == "sprintengine/iso-runlevel"
    assert primary["worktreePath"] == ".multi-code/sprintengine/iso-runlevel/worktree"
    # The run tree is clean: agents never wrote in it, only integrations did.
    assert primary["clean"] is True and primary["dirtyFiles"] == []
    assert vcs["lastCommitSha"], "the run branch carries the integrated work"


def test_a_pre_change_per_run_worktree_store_still_works(tmp_path) -> None:
    """Migration: a run built around one shared tree keeps behaving that way."""
    fixture = _isolated_run(tmp_path, "iso-legacy", isolation=False)
    fixture.cli.run(
        "plan", "add-task", "--title", "Alpha", "--role", "developer", "--task-id", "T1", "--path", "src/alpha",
    )
    _close_plan_gate(fixture)
    fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")

    run_tree = _run_worktree(fixture)
    _write(run_tree, "src/alpha/a.ts", "export const a = 1\n")
    published = fixture.cli.run(
        "task", "publish", "--task-id", "T1", "--id", "developer-1", "--summary", "Alpha.",
    )

    assert published["ok"] is True
    assert published["committed"] is True
    assert _branch_files(run_tree) == ["src/alpha/a.ts"]
    # No task tree was made, and nothing tried to integrate.
    assert not (fixture.team_dir / "task-worktrees").exists()
    assert not any(
        event["type"] == "task_work_integrated" for event in read_state(fixture.state_path)["events"]
    )


# --- the terminal-cwd half (MC-2136) ------------------------------------------
#
# Isolation only holds end-to-end if the AGENT works in its task's tree. The app
# cannot move a terminal after it starts, so it provisions the tree at dispatch
# and reads where it is from the run store — these pin both halves of that
# contract, plus the claim guard that keeps a session in one tree from owning
# another task.


def test_a_provisioned_task_worktree_is_recorded_on_the_task(tmp_path) -> None:
    """The projection carries the path; the app never recomputes it."""
    fixture = _isolated_run(tmp_path, "iso-record")
    fixture.cli.run("plan", "add-task", "--title", "Alpha", "--role", "developer", "--task-id", "T1")
    _close_plan_gate(fixture)

    assert "worktreePath" not in get_task(read_state(fixture.state_path), "T1"), "nothing recorded before a tree exists"
    fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")

    recorded = get_task(read_state(fixture.state_path), "T1")["worktreePath"]
    assert recorded == ".multi-code/sprintengine/iso-record/task-worktrees/T1/primary"
    # Project-root-relative, exactly like the run worktree, so every reader joins
    # it onto the workspace root the same way.
    assert (fixture.state_path.parents[3] / recorded).exists()


def test_the_dispatch_command_provisions_ahead_of_the_claim(tmp_path) -> None:
    """Claim is too late for a terminal: its cwd is fixed before it can claim."""
    fixture = _isolated_run(tmp_path, "iso-dispatch")
    fixture.cli.run("plan", "add-task", "--title", "Alpha", "--role", "developer", "--task-id", "T1")
    _close_plan_gate(fixture)

    result = fixture.cli.run("vcs", "task-worktree", "--task-id", "T1")

    assert result["isolated"] is True
    assert result["worktreePath"] == ".multi-code/sprintengine/iso-dispatch/task-worktrees/T1/primary"
    assert _task_worktree(fixture, "T1").exists(), "the tree stands up before anyone claims"
    # Re-entrant: the claim that follows adopts the same tree rather than failing
    # or losing what the agent already wrote into it.
    _write(_task_worktree(fixture, "T1"), "src/alpha.ts", "export const a = 1\n")
    fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")
    assert (_task_worktree(fixture, "T1") / "src" / "alpha.ts").exists()


def test_the_dispatch_command_is_a_no_op_without_isolation(tmp_path) -> None:
    """A shared-worktree run answers "no tree", not an error and not a path."""
    fixture = _isolated_run(tmp_path, "iso-dispatch-off", isolation=False)
    fixture.cli.run("plan", "add-task", "--title", "Alpha", "--role", "developer", "--task-id", "T1")
    _close_plan_gate(fixture)

    result = fixture.cli.run("vcs", "task-worktree", "--task-id", "T1")

    assert result["isolated"] is False
    assert result["worktreePath"] is None
    assert not (fixture.team_dir / "task-worktrees").exists()


def test_a_task_bound_session_can_claim_only_its_own_task(tmp_path) -> None:
    """The guard behind the cwd: a session in T2's tree must not own T1.

    The MCP server binds this from the worktree the session was spawned into, so
    an agent that ignores its brief and asks the queue for anything still gets
    only the task whose tree it is sitting in — and a payload-supplied task is
    dropped, never honoured as a self-selected filter.
    """
    fixture = _isolated_run(tmp_path, "iso-bound")
    fixture.cli.run("plan", "add-task", "--title", "Alpha", "--role", "developer", "--task-id", "T1")
    fixture.cli.run("plan", "add-task", "--title", "Beta", "--role", "developer", "--task-id", "T2")
    _close_plan_gate(fixture)

    workspace_root = fixture.state_path.parents[3]
    actor = {"id": "operator", "role": "user", "mcpAuthorized": True}
    server = SprintEngineMcpServer(allowed_roots=[workspace_root])

    def claim(agent_id: str, bound_task: str) -> dict:
        context = McpRequestContext(
            actor=ActorContext.from_value(actor),
            state_path=fixture.state_path,
            workspace_root=workspace_root,
            allowed_roots=(workspace_root,),
            agent_id=agent_id,
            role="developer",
            task_id=bound_task,
        )
        response = server.call_tool(
            "sprintengine.task.next",
            {"role": "developer", "id": agent_id},
            actor,
            context=context,
        )
        assert response["ok"] is True, response.get("error")
        return response["result"]

    # T1 is first in the ready queue, so an unbound claim would take it: this
    # session gets T2 only because it is bound to T2's tree.
    claimed = claim("developer-1", "T2")
    assert claimed["claimed"] is True
    assert claimed["task"]["id"] == "T2"

    # With its own task no longer claimable, a bound session gets a refusal that
    # names why — never a sibling's ready work, and never a bare "idle queue".
    blocked = claim("developer-2", "T2")
    assert blocked["claimed"] is False
    assert blocked["reason"] == "bound_task_not_claimable"
    assert "T2" in blocked["message"]
    assert get_task(read_state(fixture.state_path), "T1")["status"] != "in_progress", (
        "the ready sibling stays untouched by a session bound elsewhere"
    )
