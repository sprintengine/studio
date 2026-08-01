"""The backlog item a task delivers (`backlogRef`, backlog item 2020).

`sourceDocs` is a reading list and `task.source` models bidirectional tracker
sync, so neither can carry "this task IS MC-1843". `backlogRef` is that
identity: single-valued, optional, additive (no `RUN_SCHEMA_VERSION` bump), and
unique across the run because the Epic tab resolves an item to exactly one task.
These tests pin the round trip, the two path guards, and the uniqueness refusal.
"""
from __future__ import annotations

from pathlib import Path

from helpers import create_team, read_state, task, write_state
from sprintengine_core.tool.tasks import normalize_task

ITEM = "backlog/2026-07-30-task-backlog-pointer.md"
OTHER_ITEM = "backlog/2026-07-30-owned-modules-not-files.md"


def rostered_team(tmp_path: Path, name: str):
    fixture = create_team(tmp_path, name, [])
    state = read_state(fixture.state_path)
    state["sprintengine"]["rosterConfigured"] = True
    state["agents"] = {"developer-1": {"role": "developer", "status": "idle"}}
    write_state(fixture.state_path, state)
    return fixture


def test_add_task_round_trips_backlog_ref(tmp_path: Path) -> None:
    fixture = rostered_team(tmp_path, "backlogref-add")
    payload = fixture.cli.run(
        "plan", "add-task", "--title", "Deliver the item", "--role", "developer",
        "--backlog-ref", ITEM, "--backlog-key", "MC-2020",
    )
    assert payload["task"]["backlogRef"] == {"projectRelativePath": ITEM, "displayKey": "MC-2020"}
    persisted = read_state(fixture.state_path)["tasks"][0]
    assert persisted["backlogRef"] == {"projectRelativePath": ITEM, "displayKey": "MC-2020"}


def test_projection_carries_backlog_ref_so_the_renderer_never_parses_run_internals(tmp_path: Path) -> None:
    from sprintengine_core import store as folder_store

    fixture = rostered_team(tmp_path, "backlogref-projection")
    fixture.cli.run(
        "plan", "add-task", "--title", "Deliver the item", "--role", "developer",
        "--backlog-ref", ITEM, "--backlog-key", "MC-2020",
    )
    projection = folder_store.build_projection(fixture.state_path.parent, state_path=fixture.state_path)
    projected = next(task for task in projection["tasks"] if task["title"] == "Deliver the item")
    assert projected["backlogRef"] == {"projectRelativePath": ITEM, "displayKey": "MC-2020"}


def test_add_task_accepts_backlog_ref_without_display_key(tmp_path: Path) -> None:
    fixture = rostered_team(tmp_path, "backlogref-nokey")
    payload = fixture.cli.run(
        "plan", "add-task", "--title", "Deliver the item", "--role", "developer",
        "--backlog-ref", ITEM,
    )
    assert payload["task"]["backlogRef"] == {"projectRelativePath": ITEM}


def test_add_task_rejects_absolute_backlog_ref(tmp_path: Path) -> None:
    fixture = rostered_team(tmp_path, "backlogref-abs")
    completed = fixture.cli.run_failure(
        "plan", "add-task", "--title", "Deliver the item", "--role", "developer",
        "--backlog-ref", "/Users/someone/backlog/item.md",
    )
    output = completed.stderr + completed.stdout
    assert "/Users/someone/backlog/item.md" in output
    assert "absolute" in output.lower()


def test_add_task_rejects_backlog_ref_outside_project_root(tmp_path: Path) -> None:
    fixture = rostered_team(tmp_path, "backlogref-escape")
    completed = fixture.cli.run_failure(
        "plan", "add-task", "--title", "Deliver the item", "--role", "developer",
        "--backlog-ref", "../other-project/backlog/item.md",
    )
    output = completed.stderr + completed.stdout
    assert "../other-project/backlog/item.md" in output
    assert "outside the project root" in output


def test_add_task_rejects_a_windows_style_escape(tmp_path: Path) -> None:
    """Separators fold to POSIX before validation, so `..\\` cannot slip past it."""
    fixture = rostered_team(tmp_path, "backlogref-escape-win")
    completed = fixture.cli.run_failure(
        "plan", "add-task", "--title", "Deliver the item", "--role", "developer",
        "--backlog-ref", "..\\other-project\\backlog\\item.md",
    )
    assert "outside the project root" in (completed.stderr + completed.stdout)


def test_add_task_rejects_display_key_without_a_path(tmp_path: Path) -> None:
    fixture = rostered_team(tmp_path, "backlogref-keyonly")
    completed = fixture.cli.run_failure(
        "plan", "add-task", "--title", "Deliver the item", "--role", "developer",
        "--backlog-key", "MC-2020",
    )
    assert "--backlog-key needs --backlog-ref" in (completed.stderr + completed.stdout)


def test_second_task_on_the_same_item_is_rejected_naming_the_holder(tmp_path: Path) -> None:
    fixture = rostered_team(tmp_path, "backlogref-dup")
    holder = fixture.cli.run(
        "plan", "add-task", "--title", "Deliver the item", "--role", "developer",
        "--backlog-ref", ITEM,
    )["task"]["id"]

    completed = fixture.cli.run_failure(
        "plan", "add-task", "--title", "Deliver it again", "--role", "developer",
        "--backlog-ref", ITEM,
    )
    output = completed.stderr + completed.stdout
    assert ITEM in output
    assert holder in output
    assert len(read_state(fixture.state_path)["tasks"]) == 1


def test_the_same_path_under_two_declared_projects_is_two_items(tmp_path: Path) -> None:
    """The pointer is relative to the task's OWN project root, so identity is
    (repo, path). Keying on the path alone would refuse a legal multi-repo plan."""
    fixture = rostered_team(tmp_path, "backlogref-multirepo")
    state = read_state(fixture.state_path)
    state.setdefault("sprintengine", {})["vcs"] = {
        "mode": "run_worktree",
        "worktreePath": ".multi-code/sprintengine/alpha/worktree",
        "branchName": "sprintengine/alpha",
        "baseRef": "main",
        "status": "ready",
        "repos": [
            {"id": "primary", "root": ".", "worktreePath": ".multi-code/sprintengine/alpha/worktree", "branchName": "sprintengine/alpha", "baseRef": "main", "status": "ready"},
            {"id": "mobile", "root": "../mobile", "worktreePath": ".multi-code/sprintengine/alpha/worktree-mobile", "branchName": "sprintengine/alpha", "baseRef": "main", "status": "ready"},
        ],
    }
    write_state(fixture.state_path, state)

    fixture.cli.run(
        "plan", "add-task", "--title", "Deliver it here", "--role", "developer",
        "--repo", "primary", "--backlog-ref", ITEM,
    )
    sibling = fixture.cli.run(
        "plan", "add-task", "--title", "Deliver the mobile one", "--role", "developer",
        "--repo", "mobile", "--backlog-ref", ITEM,
    )
    assert sibling["task"]["backlogRef"] == {"projectRelativePath": ITEM}

    completed = fixture.cli.run_failure(
        "plan", "add-task", "--title", "Deliver it here twice", "--role", "developer",
        "--repo", "primary", "--backlog-ref", ITEM,
    )
    assert ITEM in (completed.stderr + completed.stdout)


def test_update_task_sets_replaces_and_clears_backlog_ref(tmp_path: Path) -> None:
    fixture = rostered_team(tmp_path, "backlogref-update")
    task_id = fixture.cli.run(
        "plan", "add-task", "--title", "Deliver the item", "--role", "developer",
    )["task"]["id"]

    attached = fixture.cli.run(
        "plan", "update-task", "--task-id", task_id, "--backlog-ref", ITEM, "--backlog-key", "MC-2020",
    )
    assert attached["task"]["backlogRef"] == {"projectRelativePath": ITEM, "displayKey": "MC-2020"}

    retargeted = fixture.cli.run(
        "plan", "update-task", "--task-id", task_id, "--backlog-ref", OTHER_ITEM,
    )
    assert retargeted["task"]["backlogRef"] == {"projectRelativePath": OTHER_ITEM}

    cleared = fixture.cli.run("plan", "update-task", "--task-id", task_id, "--clear-backlog-ref")
    assert "backlogRef" not in cleared["task"]
    assert "backlogRef" not in read_state(fixture.state_path)["tasks"][0]


def test_update_task_rejects_an_item_another_task_already_delivers(tmp_path: Path) -> None:
    fixture = rostered_team(tmp_path, "backlogref-update-dup")
    holder = fixture.cli.run(
        "plan", "add-task", "--title", "Deliver the item", "--role", "developer",
        "--backlog-ref", ITEM,
    )["task"]["id"]
    other = fixture.cli.run(
        "plan", "add-task", "--title", "Deliver something else", "--role", "developer",
    )["task"]["id"]

    completed = fixture.cli.run_failure(
        "plan", "update-task", "--task-id", other, "--backlog-ref", ITEM,
    )
    output = completed.stderr + completed.stdout
    assert holder in output


def test_update_task_may_restate_its_own_backlog_ref(tmp_path: Path) -> None:
    fixture = rostered_team(tmp_path, "backlogref-self")
    task_id = fixture.cli.run(
        "plan", "add-task", "--title", "Deliver the item", "--role", "developer",
        "--backlog-ref", ITEM,
    )["task"]["id"]

    restated = fixture.cli.run(
        "plan", "update-task", "--task-id", task_id, "--backlog-ref", ITEM, "--backlog-key", "MC-2020",
    )
    assert restated["task"]["backlogRef"] == {"projectRelativePath": ITEM, "displayKey": "MC-2020"}


def test_normalize_task_tolerates_an_absent_backlog_ref() -> None:
    assert "backlogRef" not in normalize_task(task("T1", "Build", "developer"))


def test_normalize_task_posix_normalizes_and_rejects_an_empty_path() -> None:
    windows_style = task("T1", "Build", "developer")
    windows_style["backlogRef"] = {"projectRelativePath": "backlog\\item.md"}
    assert normalize_task(windows_style)["backlogRef"]["projectRelativePath"] == "backlog/item.md"

    empty = task("T2", "Build", "developer")
    empty["backlogRef"] = {"projectRelativePath": "   "}
    try:
        normalize_task(empty)
    except SystemExit as exc:
        assert "backlogRef.projectRelativePath cannot be empty" in str(exc)
    else:
        raise AssertionError("An empty backlogRef path must be rejected.")


def test_the_field_is_additive_so_a_store_written_before_it_still_loads(tmp_path: Path) -> None:
    """No migration and no schema bump for THIS field: a task carrying no pointer
    round-trips. (The store version has since moved for unrelated reasons; what
    this pins is that `backlogRef` never forced one.)"""

    fixture = rostered_team(tmp_path, "backlogref-additive")
    task_id = fixture.cli.run(
        "plan", "add-task", "--title", "Predates the field", "--role", "developer",
    )["task"]["id"]

    reloaded = read_state(fixture.state_path)["tasks"][0]
    assert "backlogRef" not in reloaded

    rewritten = fixture.cli.run("plan", "update-task", "--task-id", task_id, "--title", "Still fine")
    assert "backlogRef" not in rewritten["task"]


def test_mcp_payload_maps_backlog_ref_object_onto_the_cli_arguments() -> None:
    from sprintengine_mcp.payloads import command_payload_to_namespace

    namespace = command_payload_to_namespace(
        "sprintengine.plan.add_task",
        Path("run.yaml"),
        {"title": "Deliver the item", "role": "developer", "backlogRef": {"projectRelativePath": ITEM, "displayKey": "MC-2020"}},
        None,
    )
    assert namespace.backlog_ref == ITEM
    assert namespace.backlog_key == "MC-2020"

    without = command_payload_to_namespace(
        "sprintengine.plan.add_task",
        Path("run.yaml"),
        {"title": "Deliver the item", "role": "developer"},
        None,
    )
    assert without.backlog_ref is None
    assert without.backlog_key is None
