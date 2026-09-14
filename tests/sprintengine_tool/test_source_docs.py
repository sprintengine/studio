"""Canonical source documents on task cards (`sourceDocs`, backlog item 1848).

On reference-sourced sprints the backlog child item (or referenced plan) is the
worker's operating brief, not the architect's compression of it. `--source-doc`
pins that document's project-root-relative path onto the task; the claim prompt
injects each path as read-in-full context and the slim card carries the list
untruncated. These tests pin the round trip and the guards.
"""
from __future__ import annotations

from pathlib import Path

from helpers import create_team, read_state, task, write_state
from sprintengine_core.tool.phase_prompts import build_rework_prompt
from sprintengine_core.tool.tasks import normalize_task

ITEM = "backlog/2026-07-24-example-item.md"
PLAN = "backlog/2026-07-24-example-plan.md"


def rostered_team(tmp_path: Path, name: str):
    fixture = create_team(tmp_path, name, [])
    state = read_state(fixture.state_path)
    state["sprintengine"]["rosterConfigured"] = True
    state["agents"] = {"developer-1": {"role": "developer", "status": "idle"}}
    write_state(fixture.state_path, state)
    return fixture


def test_add_task_round_trips_and_dedupes_source_docs(tmp_path: Path) -> None:
    fixture = rostered_team(tmp_path, "sourcedocs-add")
    payload = fixture.cli.run(
        "plan", "add-task", "--title", "Implement child item", "--role", "developer",
        "--source-doc", ITEM, "--source-doc", ITEM, "--source-doc", PLAN,
    )
    assert payload["task"]["sourceDocs"] == [ITEM, PLAN]
    persisted = read_state(fixture.state_path)["tasks"][0]
    assert persisted["sourceDocs"] == [ITEM, PLAN]


def test_add_task_rejects_absolute_source_doc(tmp_path: Path) -> None:
    fixture = rostered_team(tmp_path, "sourcedocs-abs")
    completed = fixture.cli.run_failure(
        "plan", "add-task", "--title", "Implement child item", "--role", "developer",
        "--source-doc", "/etc/backlog-item.md",
    )
    assert "source" in (completed.stderr + completed.stdout).lower()


def test_update_task_replaces_and_clears_source_docs(tmp_path: Path) -> None:
    fixture = rostered_team(tmp_path, "sourcedocs-update")
    created = fixture.cli.run(
        "plan", "add-task", "--title", "Implement child item", "--role", "developer",
        "--source-doc", ITEM,
    )
    task_id = created["task"]["id"]

    replaced = fixture.cli.run(
        "plan", "update-task", "--task-id", task_id, "--source-doc", PLAN,
    )
    assert replaced["task"]["sourceDocs"] == [PLAN]

    cleared = fixture.cli.run("plan", "update-task", "--task-id", task_id, "--clear-source-docs")
    assert not cleared["task"].get("sourceDocs")
    assert not read_state(fixture.state_path)["tasks"][0].get("sourceDocs")


def test_normalize_task_drops_empty_source_docs() -> None:
    raw = task("T1", "Build", "developer")
    raw["sourceDocs"] = ["", "  "]
    assert "sourceDocs" not in normalize_task(raw)
    assert "sourceDocs" not in normalize_task(task("T2", "Build", "developer"))


def test_rework_prompt_injects_source_docs_as_read_in_full_context(tmp_path: Path) -> None:
    record = task("T1", "Implement child item", "developer", "in_progress", owner="developer-1")
    record["sourceDocs"] = [ITEM, PLAN]
    prompt = build_rework_prompt(tmp_path / ".sprintengine" / "sprintengine" / "s" / "run.yaml", record)
    assert "read each in full before implementing" in prompt
    assert f"- `{ITEM}`" in prompt
    assert f"- `{PLAN}`" in prompt
    assert "the task card carries only the delta" in prompt


def test_rework_prompt_unchanged_without_source_docs(tmp_path: Path) -> None:
    record = task("T1", "Implement", "developer", "in_progress", owner="developer-1")
    prompt = build_rework_prompt(tmp_path / ".sprintengine" / "sprintengine" / "s" / "run.yaml", record)
    assert "Canonical sources" not in prompt
    assert "read each in full" not in prompt


def test_slim_task_card_carries_source_docs_untruncated() -> None:
    from sprintengine_mcp.response_shapes import slim_task_card

    record = task("T1", "Implement child item", "developer")
    record["sourceDocs"] = [ITEM, PLAN]
    card = slim_task_card(record)
    assert card["sourceDocs"] == [ITEM, PLAN]
    assert "sourceDocs" not in slim_task_card(task("T2", "Implement", "developer"))
