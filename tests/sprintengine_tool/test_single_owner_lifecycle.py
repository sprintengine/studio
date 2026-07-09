"""Single-owner task lifecycle (MC-1542 Stage 1).

One agent owns a task from claim to `done`. Publish detects whether the task
produced a diff and routes it into its phase walk; `advance` is the only mutation
that walks phases. These tests pin the invariants the whole redesign rests on:

- publish routes on CHANGE DETECTION, not on role or gate configuration;
- the owner stays bound to its task through every phase;
- the walk is strictly forward, a phase is visited at most once;
- `escalate` remembers the phase it escalated from and returns there;
- `changes_requested`, `testing`, and `product` are gone with no read-side tolerance.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from helpers import create_team, get_task, read_state, task, write_state
from sprintengine_core import store as folder_store
from sprintengine_core.tool import constants
from sprintengine_core.tool.state import load_mutation_state, with_locked_state
from sprintengine_core.tool.tasks import advance_task, publish_task, task_produced_changes


# --- fixtures ---------------------------------------------------------------


def rostered_team(tmp_path: Path, name: str, tasks: list[dict], **run_keys):
    fixture = create_team(tmp_path, name, tasks)
    state = read_state(fixture.state_path)
    state["sprintengine"]["rosterConfigured"] = True
    state["agents"] = {"developer-1": {"role": "developer", "status": "idle"}}
    state.update(run_keys)
    write_state(fixture.state_path, state)
    return fixture


def owned_task(task_id: str = "T1", owner: str = "developer-1", status: str = "in_progress") -> dict:
    record = task(task_id, "Work", "developer", status=status, owner=owner)
    record["startedAt"] = "2026-07-08T00:00:00Z"
    return record


def mutate(fixture, fn):
    """Run `fn(state)` under the run lock and persist, like a real command."""

    def run(state):
        result = fn(state)
        return {"ok": True, **(result or {})}

    return with_locked_state(fixture.state_path, run)


# --- the status enum --------------------------------------------------------


def test_retired_statuses_are_gone_from_every_enum() -> None:
    """Decision 2 + 8: deleted outright, no read-side tolerance."""
    for retired in ("changes_requested", "testing", "product"):
        assert retired not in constants.VALID_TASK_STATUSES
        assert retired not in folder_store.TASK_STATUSES
    assert constants.VALID_TASK_STATUSES == {"todo", "in_progress", "review", "needs_input", "done", "canceled"}
    # `ready` is the materialized queue folder, not a semantic status.
    assert set(folder_store.TASK_STATUSES) == constants.VALID_TASK_STATUSES | {"ready"}


def test_review_is_an_active_owned_status() -> None:
    """The owner stays bound through review, so review is not spare capacity."""
    assert "review" in constants.ACTIVE_TASK_STATUSES
    assert constants.ACTIVE_TASK_STATUSES == {"in_progress", "review", "needs_input"}


def test_a_task_with_a_retired_status_is_rejected(tmp_path: Path) -> None:
    from sprintengine_core.tool.tasks import normalize_task

    with pytest.raises(SystemExit, match="invalid status"):
        normalize_task({"id": "T1", "title": "t", "role": "developer", "status": "changes_requested"})


# --- change detection -------------------------------------------------------


def test_worktree_mode_change_detection_reads_task_commits(tmp_path: Path) -> None:
    fixture = rostered_team(tmp_path, "cd-worktree", [owned_task()])
    state = read_state(fixture.state_path)
    state["sprintengine"]["vcs"] = {"mode": "run_worktree", "worktreePath": "worktree", "branchName": "b"}
    record = get_task(state, "T1")

    record.setdefault("evidence", {})["commits"] = []
    assert task_produced_changes(state, fixture.state_path, record) is False

    record["evidence"]["commits"] = ["abc1234"]
    assert task_produced_changes(state, fixture.state_path, record) is True


def test_non_worktree_change_detection_reads_the_working_tree(tmp_path: Path) -> None:
    workspace = tmp_path / "repo"
    workspace.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=workspace, check=True)
    team_dir = workspace / ".multi-code" / "sprintengine" / "cd-plain"
    state_path = team_dir / "run.yaml"
    write_state(state_path, {
        "sprintengine": {"name": "cd-plain", "goal": "g", "status": "executing", "rosterConfigured": True},
        "tasks": [owned_task()],
        "agents": {"developer-1": {"role": "developer", "status": "idle"}},
        "events": [], "artifacts": [], "roles": {},
    })
    state = folder_store.state_from_folder_store(team_dir)
    record = get_task(state, "T1")
    record["ownedPaths"] = ["src/thing.py"]

    assert task_produced_changes(state, state_path, record) is False

    (workspace / "src").mkdir()
    (workspace / "src" / "thing.py").write_text("x = 1\n")
    # An untracked new file is a diff: a task whose only output is a new file
    # very much produced changes.
    assert task_produced_changes(state, state_path, record) is True


def test_change_detection_is_failure_safe_without_a_git_repository(tmp_path: Path) -> None:
    """Cannot tell => route to review. Skipping review on a changed tree is worse."""
    fixture = rostered_team(tmp_path, "cd-nogit", [owned_task()])
    state = read_state(fixture.state_path)
    record = get_task(state, "T1")
    record["ownedPaths"] = ["src/thing.py"]

    # tmp_path is not a git repo; `git rev-parse --git-dir` fails there.
    assert task_produced_changes(state, fixture.state_path, record) is True


# --- publish routing --------------------------------------------------------


def _publish(fixture, *, produced: bool, phases=None):
    """Publish T1 with change detection stubbed to `produced`."""
    import sprintengine_core.tool.tasks as tasks_module

    original = tasks_module.task_produced_changes
    tasks_module.task_produced_changes = lambda *_args, **_kw: produced
    try:
        def run(state):
            if phases is not None:
                get_task(state, "T1")["phases"] = phases
            record = get_task(state, "T1")
            return {"result": publish_task(state, fixture.state_path, record, "developer-1", "done it")}

        return mutate(fixture, run)
    finally:
        tasks_module.task_produced_changes = original


def test_publish_with_no_changes_routes_straight_to_done(tmp_path: Path) -> None:
    """The clean-sweep / analysis-only exit."""
    fixture = rostered_team(tmp_path, "pub-clean", [owned_task()])
    result = _publish(fixture, produced=False)["result"]

    assert result["nextStatus"] == "done"
    assert result["producedChanges"] is False
    assert result["phases"] == []

    state = read_state(fixture.state_path)
    record = get_task(state, "T1")
    assert record["status"] == "done"
    assert record["completedAt"]
    assert record["ownerAgentId"] is None


def test_publish_with_changes_enters_the_first_phase_and_keeps_the_owner(tmp_path: Path) -> None:
    fixture = rostered_team(tmp_path, "pub-review", [owned_task()])
    result = _publish(fixture, produced=True)["result"]

    assert result["nextStatus"] == "review"
    assert result["producedChanges"] is True
    assert result["phases"] == ["review"]

    state = read_state(fixture.state_path)
    record = get_task(state, "T1")
    assert record["status"] == "review"
    # Decision 1: the owner is mid-tool-call and stays bound to the task.
    assert record["ownerAgentId"] == "developer-1"
    assert record["completedAt"] is None
    assert state["agents"]["developer-1"]["currentTaskId"] == "T1"


def test_publish_with_changes_but_no_phases_routes_to_done(tmp_path: Path) -> None:
    """`--phases ""` on a docs-only task, or a run with `defaultPhases: []`."""
    fixture = rostered_team(tmp_path, "pub-nophase", [owned_task()])
    result = _publish(fixture, produced=True, phases=[])["result"]

    assert result["nextStatus"] == "done"
    assert result["producedChanges"] is True
    assert read_state(fixture.state_path)["tasks"][0]["status"] == "done"


def test_publish_on_an_empty_default_phases_run_routes_to_done(tmp_path: Path) -> None:
    fixture = rostered_team(tmp_path, "pub-emptyrun", [owned_task()], defaultPhases=[])
    result = _publish(fixture, produced=True)["result"]
    assert result["nextStatus"] == "done"


def test_publish_rejects_a_task_that_is_not_in_progress(tmp_path: Path) -> None:
    fixture = rostered_team(tmp_path, "pub-badstatus", [owned_task(status="review")])
    with pytest.raises(SystemExit, match="Only in_progress tasks can be published"):
        _publish(fixture, produced=True)


# --- advance ----------------------------------------------------------------


def _advance(fixture, actor="developer-1", phase="review", outcome="pass", summary="reviewed", needs_input=None):
    def run(state):
        record = get_task(state, "T1")
        return {"result": advance_task(state, record, actor, phase, outcome, summary, needs_input=needs_input)}

    return mutate(fixture, run)


def test_advance_pass_completes_the_task(tmp_path: Path) -> None:
    fixture = rostered_team(tmp_path, "adv-pass", [owned_task(status="review")])
    result = _advance(fixture)["result"]

    assert result["nextStatus"] == "done"
    assert result["nextPhase"] is None
    record = read_state(fixture.state_path)["tasks"][0]
    assert record["status"] == "done"
    assert record["completedAt"]
    assert record["ownerAgentId"] is None


def test_advance_pass_with_fixes_completes_the_task(tmp_path: Path) -> None:
    fixture = rostered_team(tmp_path, "adv-fixes", [owned_task(status="review")])
    assert _advance(fixture, outcome="pass_with_fixes")["result"]["nextStatus"] == "done"


def test_advance_is_owner_only(tmp_path: Path) -> None:
    fixture = rostered_team(tmp_path, "adv-owner", [owned_task(status="review")])
    with pytest.raises(SystemExit, match="not_task_owner"):
        _advance(fixture, actor="developer-2")


def test_advance_guards_on_the_phase_matching_the_current_status(tmp_path: Path) -> None:
    """A stale call from a resumed session must not skip a phase."""
    fixture = rostered_team(tmp_path, "adv-stale", [owned_task(status="in_progress")])
    with pytest.raises(SystemExit, match="phase_mismatch"):
        _advance(fixture, phase="review")


def test_advance_rejects_an_unknown_phase_and_outcome(tmp_path: Path) -> None:
    fixture = rostered_team(tmp_path, "adv-enum", [owned_task(status="review")])
    with pytest.raises(SystemExit, match="Invalid phase"):
        _advance(fixture, phase="testing")
    with pytest.raises(SystemExit, match="Invalid outcome"):
        _advance(fixture, outcome="changes_requested")


def test_advance_requires_a_summary(tmp_path: Path) -> None:
    fixture = rostered_team(tmp_path, "adv-summary", [owned_task(status="review")])
    with pytest.raises(SystemExit, match="summary is required"):
        _advance(fixture, summary="   ")


# --- escalate + resolution round-trip ---------------------------------------


def test_escalate_parks_in_needs_input_and_remembers_the_originating_phase(tmp_path: Path) -> None:
    fixture = rostered_team(tmp_path, "adv-escalate", [owned_task(status="review")])
    result = _advance(
        fixture,
        outcome="escalate",
        needs_input={"kind": "user", "reason": "product_decision", "question": "Ship or hold?"},
    )["result"]

    assert result["nextStatus"] == "needs_input"
    record = read_state(fixture.state_path)["tasks"][0]
    assert record["status"] == "needs_input"
    assert record["needsInput"]["originatingStatus"] == "review"
    assert record["needsInput"]["kind"] == "user"
    # The owner keeps the task while it is blocked.
    assert record["ownerAgentId"] == "developer-1"


def test_escalate_requires_a_question(tmp_path: Path) -> None:
    fixture = rostered_team(tmp_path, "adv-escalate-q", [owned_task(status="review")])
    with pytest.raises(SystemExit, match="needs-input question"):
        _advance(fixture, outcome="escalate")


def test_resolving_a_mid_phase_escalation_returns_the_task_to_that_phase(tmp_path: Path) -> None:
    """Invariant 7c: only Flow-5 human feedback sends a task back to in_progress."""
    from sprintengine_core.tool.artifacts import resolve_task_input

    fixture = rostered_team(tmp_path, "resolve-phase", [owned_task(status="review")])
    _advance(fixture, outcome="escalate", needs_input={"kind": "architect", "question": "Which contract?"})

    def run(state):
        return {"transition": resolve_task_input(state, get_task(state, "T1"), "architect", "Use contract B.")}

    transition = mutate(fixture, run)["transition"]
    assert transition["status"] == "review"
    assert transition["resumePhase"] == "review"
    record = read_state(fixture.state_path)["tasks"][0]
    assert record["status"] == "review"
    assert record["ownerAgentId"] == "developer-1"


def test_resolving_a_plain_needs_input_resumes_implementation(tmp_path: Path) -> None:
    from sprintengine_core.tool.artifacts import resolve_task_input

    fixture = rostered_team(tmp_path, "resolve-plain", [owned_task(status="needs_input")])

    def run(state):
        record = get_task(state, "T1")
        record["needsInput"] = {"kind": "architect", "question": "?"}
        return {"transition": resolve_task_input(state, record, "architect", "Answer.")}

    transition = mutate(fixture, run)["transition"]
    assert transition["status"] == "in_progress"
    assert transition["resumePhase"] is None


# --- phase-walk invariants --------------------------------------------------


def test_a_phase_is_visited_at_most_once_per_walk(tmp_path: Path) -> None:
    """Invariant 7a: fixes made during review are never re-reviewed."""
    fixture = rostered_team(tmp_path, "walk-once", [owned_task(status="review")])
    assert _advance(fixture, outcome="pass_with_fixes")["result"]["nextStatus"] == "done"
    # The task is done; a second advance cannot re-enter review.
    with pytest.raises(SystemExit, match="phase_mismatch"):
        _advance(fixture)


def test_a_republish_restarts_the_walk(tmp_path: Path) -> None:
    """Invariant 7b: human feedback -> in_progress -> publish re-enters phases[0]."""
    fixture = rostered_team(tmp_path, "walk-restart", [owned_task(status="review")])
    _advance(fixture)  # -> done

    def reopen(state):
        record = get_task(state, "T1")
        record["status"] = "in_progress"
        record["ownerAgentId"] = "developer-1"
        record["completedAt"] = None
        return {}

    mutate(fixture, reopen)
    assert _publish(fixture, produced=True)["result"]["nextStatus"] == "review"


def test_only_publish_enters_the_walk_and_only_advance_moves_it(tmp_path: Path) -> None:
    """Invariant 7d, checked structurally: no other module mutates task['status']
    to a phase name."""
    engine = Path(__file__).resolve().parents[2] / "sprintengine_core"
    offenders: list[str] = []
    for path in sorted(engine.rglob("*.py")):
        source = path.read_text(encoding="utf-8")
        if '"status"] = "review"' in source or "'status'] = 'review'" in source:
            offenders.append(str(path.relative_to(engine.parent)))
    # tasks.py assigns the phase through `next_status`, never a literal, so no
    # module should contain a literal phase assignment.
    assert offenders == [], f"literal phase status assignment outside the walk: {offenders}"


# --- release semantics ------------------------------------------------------


def test_a_review_task_stays_owned_when_its_agent_leaves(tmp_path: Path) -> None:
    """Flow 6: the owner is revived under the same id with a phase brief. Releasing
    it to `todo` would hand a stranger a task whose diff is already published."""
    from sprintengine_core.tool.state import release_agent_targets

    fixture = rostered_team(tmp_path, "release-review", [owned_task(status="review")])

    def run(state):
        return {"released": release_agent_targets(state, "developer-1", reason="left", actor="sprintengine")}

    released = mutate(fixture, run)["released"]
    assert released == []
    record = read_state(fixture.state_path)["tasks"][0]
    assert record["status"] == "review"
    assert record["ownerAgentId"] == "developer-1"


def test_an_in_progress_task_returns_to_the_queue_when_its_agent_leaves(tmp_path: Path) -> None:
    from sprintengine_core.tool.state import release_agent_targets

    fixture = rostered_team(tmp_path, "release-inprogress", [owned_task(status="in_progress")])

    def run(state):
        return {"released": release_agent_targets(state, "developer-1", reason="left", actor="sprintengine")}

    released = mutate(fixture, run)["released"]
    assert len(released) == 1
    assert released[0]["kind"] == "task"
    record = read_state(fixture.state_path)["tasks"][0]
    assert record["status"] == "todo"
    assert record["ownerAgentId"] is None


def test_a_needs_input_task_stays_owned_when_its_agent_leaves(tmp_path: Path) -> None:
    from sprintengine_core.tool.state import release_agent_targets

    fixture = rostered_team(tmp_path, "release-blocked", [owned_task(status="needs_input")])

    def run(state):
        return {"released": release_agent_targets(state, "developer-1", reason="left", actor="sprintengine")}

    assert mutate(fixture, run)["released"] == []
    assert read_state(fixture.state_path)["tasks"][0]["ownerAgentId"] == "developer-1"


# --- ready queue ------------------------------------------------------------


def test_only_todo_tasks_are_ready(tmp_path: Path) -> None:
    from sprintengine_core.tool.tasks import task_is_ready

    state = {"tasks": []}
    for status in ("todo", "in_progress", "review", "needs_input", "done", "canceled"):
        record = task("T1", "t", "developer", status=status)
        assert task_is_ready(state, record) is (status == "todo"), status


def test_a_review_task_is_not_materialized_into_the_ready_folder(tmp_path: Path) -> None:
    fixture = rostered_team(tmp_path, "queue-review", [owned_task(status="review")])
    ready = folder_store.materialized_ready_task_ids(fixture.team_dir)
    assert ready == []
    assert (fixture.team_dir / "tasks" / "review").exists()
    assert not (fixture.team_dir / "tasks" / "changes_requested").exists()


# --- the board --------------------------------------------------------------


def test_the_projection_board_has_no_retired_columns(tmp_path: Path) -> None:
    fixture = rostered_team(tmp_path, "board", [owned_task(status="review")])
    projection = folder_store.build_projection(fixture.team_dir, state_path=fixture.state_path)

    assert set(projection["board"]["columns"]) == set(folder_store.TASK_STATUSES)
    assert "changes_requested" not in projection["board"]["columns"]
    assert "changesRequestedTaskIds" not in projection["board"]
    assert "changesRequested" not in projection["counts"]
    assert projection["board"]["counts"]["review"] == 1


def test_the_projection_no_longer_carries_quality_gate_state(tmp_path: Path) -> None:
    fixture = rostered_team(tmp_path, "board-nogates", [owned_task(status="review")])
    projection = folder_store.build_projection(fixture.team_dir, state_path=fixture.state_path)

    assert "qualityPolicy" not in projection["run"]
    assert "qualityGateSummary" not in projection["tasks"][0]
    assert "qualityGates" not in projection["tasks"][0]


# --- directive delivery: exactly two channels -------------------------------


def _publish_args(state_path: Path, summary: str):
    class Args:
        state = state_path
        task_id = "T1"
        id = "developer-1"
        path: list = []
        summary_data_json = None
        actual_difficulty_pct = None
        actual_difficulty_reason = ""

    Args.summary = summary
    return Args()


def _git_workspace_team(tmp_path: Path, name: str, tasks: list[dict]) -> tuple[Path, Path]:
    """A team inside a real (empty) git repo, so non-worktree change detection runs."""
    workspace = tmp_path / "repo"
    workspace.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=workspace, check=True)
    team_dir = workspace / ".multi-code" / "sprintengine" / name
    state_path = team_dir / "run.yaml"
    write_state(state_path, {
        "sprintengine": {"name": name, "goal": "g", "status": "executing", "rosterConfigured": True},
        "tasks": tasks,
        "agents": {"developer-1": {"role": "developer", "status": "idle"}},
        "events": [], "artifacts": [], "roles": {},
    })
    return workspace, state_path


def test_publish_returns_the_phase_directive_inline(tmp_path: Path) -> None:
    """Channel 1: the live owner is mid-tool-call. No paste, no spawn, no wake."""
    record = owned_task()
    record["ownedPaths"] = ["src/widget.py"]
    record["acceptanceCriteria"] = ["The widget renders."]
    workspace, state_path = _git_workspace_team(tmp_path, "directive-inline", [record])
    (workspace / "src").mkdir()
    (workspace / "src" / "widget.py").write_text("widget = 1\n")

    from sprintengine_core.tool.commands.task import cmd_task_publish

    result = cmd_task_publish(_publish_args(state_path, "Implemented the widget."))
    assert result["nextStatus"] == "review"
    assert result["producedChanges"] is True
    directive = result["nextDirective"]
    assert "reviewing your own work" in directive
    assert "read it as if a stranger wrote it" in directive
    # Item 1566: the directive references the card's acceptance criteria instead
    # of re-serializing bodies the live owner already holds.
    assert "The widget renders." not in directive
    assert "Review against your task card's acceptance criteria" in directive
    assert "sprintengine.task.advance" in directive


def test_publish_with_no_changes_returns_no_directive(tmp_path: Path) -> None:
    record = owned_task()
    record["ownedPaths"] = ["src/widget.py"]
    _workspace, state_path = _git_workspace_team(tmp_path, "directive-none", [record])

    from sprintengine_core.tool.commands.task import cmd_task_publish

    result = cmd_task_publish(_publish_args(state_path, "Analysis only; nothing to fix."))
    assert result["nextStatus"] == "done"
    assert result["producedChanges"] is False
    assert "nextDirective" not in result


def test_task_next_returns_the_phase_respawn_brief_for_a_revived_owner(tmp_path: Path) -> None:
    """Channel 2: a dead owner starts cold and needs the diff back in context."""
    from sprintengine_core.tool.commands.task import cmd_task_next

    fixture = rostered_team(tmp_path, "directive-respawn", [owned_task(status="review")])
    state = read_state(fixture.state_path)
    record = get_task(state, "T1")
    record["evidence"]["summary"] = "Rewired the panel."
    record["evidence"]["touchedFiles"] = ["src/panel.tsx"]
    write_state(fixture.state_path, state)

    class Args:
        state = fixture.state_path
        role = "developer"
        id = "developer-1"
        model = None
        cli = None

    result = cmd_task_next(Args())
    assert result["claimed"] is False
    assert result["reason"] == "agent_already_has_active_task"
    assert result["phase"] == "review"
    prompt = result["prompt"]
    assert "Sprint Engine Phase Handover" in prompt
    assert "Rewired the panel." in prompt          # the published evidence
    assert "src/panel.tsx" in prompt
    assert "read it as if a stranger wrote it" in prompt   # the phase directive


# --- Flow 5: human feedback -------------------------------------------------


def test_reopening_a_done_task_rebinds_it_to_its_implementer(tmp_path: Path) -> None:
    """The Inbox loop. `changes_requested` was claimable; `in_progress` is not, so
    an unowned reopen would strand the task forever."""
    from sprintengine_core.tool.commands.task import cmd_task_status

    record = task("T1", "Work", "developer", status="done")
    record["lastImplementedByAgentId"] = "developer-1"
    record["completedAt"] = "2026-07-08T01:00:00Z"
    fixture = rostered_team(tmp_path, "reopen-owned", [record])

    class Args:
        state = fixture.state_path
        task_id = "T1"
        id = "user"
        status = "in_progress"
        summary = None
        needs_input_kind = None
        needs_input_reason = None
        needs_input_artifact_id = None
        needs_input_question = None
        needs_input_suggested_resolution = None
        actual_difficulty_pct = None
        actual_difficulty_reason = ""

    cmd_task_status(Args())
    reopened = read_state(fixture.state_path)["tasks"][0]
    assert reopened["status"] == "in_progress"
    assert reopened["ownerAgentId"] == "developer-1"
    assert reopened["completedAt"] is None


def test_reopening_a_never_claimed_task_returns_it_to_the_queue(tmp_path: Path) -> None:
    """No implementer on record: `in_progress` with no owner is unclaimable, so it
    must go back to `todo` rather than vanish from every queue."""
    from sprintengine_core.tool.commands.task import cmd_task_status

    fixture = rostered_team(tmp_path, "reopen-unowned", [task("T1", "Work", "developer", status="todo")])

    class Args:
        state = fixture.state_path
        task_id = "T1"
        id = "user"
        status = "in_progress"
        summary = None
        needs_input_kind = None
        needs_input_reason = None
        needs_input_artifact_id = None
        needs_input_question = None
        needs_input_suggested_resolution = None
        actual_difficulty_pct = None
        actual_difficulty_reason = ""

    cmd_task_status(Args())
    reopened = read_state(fixture.state_path)["tasks"][0]
    assert reopened["status"] == "todo"
    assert reopened["ownerAgentId"] is None
