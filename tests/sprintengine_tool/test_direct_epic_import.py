"""Deterministic epic import (MC-2128) — init mints the graph, no planner runs.

An epic whose children are already written and ordered IS the plan. The engine
mints one task per open child at `sprintengine init`, in the same process that
used to mint the plan-gate task, and the run opens with its board populated and
zero agent tokens spent.

What the planning agent used to do here was a mechanical loop the engine already
specified in prose — one task per open child, carry the backlog ref, add the
dependency edges — for roughly 200k tokens. These pin that loop, executed.

The opt-in planner (`--intake planned`) selects the previous behaviour unchanged;
`test_epic_child_sequencing.py` covers that path and the directive it hands over.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from helpers import SwarmCli, read_state


EPIC = "backlog/epics/auth-revamp.md"


def _write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def _child(root: Path, slug: str, title: str, *, status: str = "ready", depends_on: str = "") -> str:
    """One epic child item, and its project-relative path."""
    frontmatter = ["---", "type: feature", f"status: {status}", "epic: auth-revamp"]
    if depends_on:
        frontmatter.append(f"dependsOn: {depends_on}")
    frontmatter.append("---")
    body = "\n".join(frontmatter) + f"\n\n# {title}\n\nThe item is the spec.\n"
    _write(root / "backlog" / f"{slug}.md", body)
    return f"backlog/{slug}.md"


def _init_epic_run(
    root: Path, children: list[str], *, intake: str | None = None, name: str = "auth-revamp"
) -> tuple[SwarmCli, Path]:
    _write(root / EPIC, "---\ntype: epic\n---\n\n# Auth revamp\n\nEpic design.\n")
    state_path = root / ".multi-code" / "sprintengine" / name / "run.yaml"
    cli = SwarmCli(state_path, cwd=root)
    cli.run(
        "init",
        "--name", name,
        "--goal", "Revamp authentication",
        *(["--intake", intake] if intake else []),
        "--source-json", json.dumps({
            "kind": "markdown", "origin": "reference", "path": EPIC, "planKind": "epic",
        }),
        "--source-bundle-json", json.dumps([
            {"kind": "generic_context", "origin": "reference", "path": path, "epicChild": True}
            for path in children
        ]),
    )
    return cli, state_path


def _tasks(state_path: Path) -> list[dict]:
    return read_state(state_path)["tasks"]


# --- the import ---------------------------------------------------------------


def test_one_task_per_open_child_and_no_planning_session(tmp_path) -> None:
    """The headline acceptance: 6 children, 2 closed, 4 tasks, no agent ran."""
    root = tmp_path / "project"
    children = [
        _child(root, "login-form", "Login form"),
        _child(root, "session-store", "Session store"),
        _child(root, "token-refresh", "Token refresh"),
        _child(root, "audit-log", "Audit log"),
        _child(root, "old-cookie-shim", "Old cookie shim", status="completed"),
        _child(root, "passkeys-someday", "Passkeys someday", status="idea"),
    ]
    _cli, state_path = _init_epic_run(root, children)

    tasks = _tasks(state_path)
    assert len(tasks) == 4
    assert [task["title"] for task in tasks] == [
        "Login form", "Session store", "Token refresh", "Audit log",
    ]
    # Each points at its child, and the card is empty: the item is the spec.
    for task, path in zip(tasks, children[:4]):
        assert task["backlogRef"]["projectRelativePath"] == path
        assert task["sourceDocs"] == [path]
        # `work` normalizes to an absent kind — a plain task, not a review one.
        assert task.get("kind") is None
        assert task["status"] == "todo"
        assert not task.get("description")
        assert task.get("acceptanceCriteria") == []
        assert task.get("implementationNotes") == []
        # No ownedPaths: publish scope is what the task changed (MC-2127), which
        # is exactly why that item landed first.
        assert task.get("ownedPaths") == []

    # No plan gate, no plan artifact — nothing for an agent to be spawned against.
    state = read_state(state_path)
    assert state["artifacts"] == []
    assert not any("plan" in str(task.get("title", "")).lower() for task in tasks)
    assert state["sprintengine"]["intake"] == "direct"


def test_the_closed_children_are_reported_not_silently_dropped(tmp_path) -> None:
    root = tmp_path / "project"
    children = [
        _child(root, "login-form", "Login form"),
        _child(root, "old-cookie-shim", "Old cookie shim", status="completed"),
        _child(root, "passkeys-someday", "Passkeys someday", status="idea"),
        _child(root, "dead-idea", "Dead idea", status="archived"),
    ]
    _write(root / EPIC, "---\ntype: epic\n---\n\n# Auth revamp\n")
    state_path = root / ".multi-code" / "sprintengine" / "auth-revamp" / "run.yaml"
    cli = SwarmCli(state_path, cwd=root)
    payload = cli.run(
        "init",
        "--name", "auth-revamp",
        "--goal", "Revamp authentication",
        "--source-json", json.dumps({
            "kind": "markdown", "origin": "reference", "path": EPIC, "planKind": "epic",
        }),
        "--source-bundle-json", json.dumps([
            {"kind": "generic_context", "origin": "reference", "path": path, "epicChild": True}
            for path in children
        ]),
    )

    assert len(payload["importedTasks"]) == 1
    assert sorted(payload["skippedChildren"]) == sorted(children[1:])


def test_the_run_opens_claimable_with_no_gate_in_the_way(tmp_path) -> None:
    """No plan gate blocks the first claim — the point of skipping it."""
    root = tmp_path / "project"
    children = [_child(root, "login-form", "Login form")]
    cli, state_path = _init_epic_run(root, children)

    claimed = cli.run("task", "next", "--id", "developer-1")
    assert claimed["claimed"] is True
    assert claimed["task"]["title"] == "Login form"
    # The item rides the claim as read-in-full context, which is what lets the
    # card stay empty.
    assert claimed["task"]["sourceDocs"] == ["backlog/login-form.md"]


# --- the edges ----------------------------------------------------------------


def test_a_sibling_dependency_becomes_a_task_edge(tmp_path) -> None:
    root = tmp_path / "project"
    children = [
        _child(root, "session-store", "Session store"),
        _child(root, "login-form", "Login form", depends_on="session-store"),
    ]
    _cli, state_path = _init_epic_run(root, children)

    tasks = {task["title"]: task for task in _tasks(state_path)}
    assert tasks["Login form"]["dependsOn"] == [tasks["Session store"]["id"]]
    assert tasks["Session store"]["dependsOn"] == []


def test_an_edge_resolves_even_when_its_target_is_seeded_later(tmp_path) -> None:
    """Edges are resolved in a second pass, so seed order cannot lose one."""
    root = tmp_path / "project"
    children = [
        _child(root, "login-form", "Login form", depends_on="session-store"),
        _child(root, "session-store", "Session store"),
    ]
    _cli, state_path = _init_epic_run(root, children)

    tasks = {task["title"]: task for task in _tasks(state_path)}
    assert tasks["Login form"]["dependsOn"] == [tasks["Session store"]["id"]]


def test_a_completed_outside_dependency_yields_no_edge_and_no_warning(tmp_path) -> None:
    root = tmp_path / "project"
    _write(
        root / "backlog" / "old-groundwork.md",
        "---\ntype: feature\nstatus: completed\n---\n\n# Old groundwork\n",
    )
    children = [_child(root, "login-form", "Login form", depends_on="old-groundwork")]
    _write(root / EPIC, "---\ntype: epic\n---\n\n# Auth revamp\n")
    state_path = root / ".multi-code" / "sprintengine" / "auth-revamp" / "run.yaml"
    payload = SwarmCli(state_path, cwd=root).run(
        "init",
        "--name", "auth-revamp",
        "--goal", "Revamp authentication",
        "--source-json", json.dumps({
            "kind": "markdown", "origin": "reference", "path": EPIC, "planKind": "epic",
        }),
        "--source-bundle-json", json.dumps([
            {"kind": "generic_context", "origin": "reference", "path": children[0], "epicChild": True},
        ]),
    )

    assert "warnings" not in payload
    assert _tasks(state_path)[0]["dependsOn"] == []


def test_an_open_outside_dependency_warns_but_never_blocks_creation(tmp_path) -> None:
    """One stale frontmatter line must not stop a sprint from being created."""
    root = tmp_path / "project"
    _write(
        root / "backlog" / "unfinished-groundwork.md",
        "---\ntype: feature\nstatus: ready\n---\n\n# Unfinished groundwork\n",
    )
    children = [_child(root, "login-form", "Login form", depends_on="unfinished-groundwork")]
    _write(root / EPIC, "---\ntype: epic\n---\n\n# Auth revamp\n")
    state_path = root / ".multi-code" / "sprintengine" / "auth-revamp" / "run.yaml"
    payload = SwarmCli(state_path, cwd=root).run(
        "init",
        "--name", "auth-revamp",
        "--goal", "Revamp authentication",
        "--source-json", json.dumps({
            "kind": "markdown", "origin": "reference", "path": EPIC, "planKind": "epic",
        }),
        "--source-bundle-json", json.dumps([
            {"kind": "generic_context", "origin": "reference", "path": children[0], "epicChild": True},
        ]),
    )

    assert payload["ok"] is True
    assert len(payload["importedTasks"]) == 1
    assert any("unfinished-groundwork" in warning for warning in payload["warnings"])
    # Visible on the run itself, not only in the creation response.
    state = read_state(state_path)
    assert any(event["type"] == "epic_import_warning" for event in state["events"])
    # And the task still runs: no edge means nothing blocks it.
    assert state["tasks"][0]["dependsOn"] == []


# --- the opt-in planner, and the intakes this must not touch ------------------


def test_intake_planned_reproduces_the_planning_gate(tmp_path) -> None:
    """Picking a planning agent selects today's behaviour exactly."""
    root = tmp_path / "project"
    children = [_child(root, "login-form", "Login form")]
    _cli, state_path = _init_epic_run(root, children, intake="planned")

    state = read_state(state_path)
    tasks = state["tasks"]
    assert len(tasks) == 1
    assert tasks[0]["title"] == "Sequence the epic's child items into a task graph"
    assert state["artifacts"], "the planned intake keeps its plan-approval artifact"
    assert state["sprintengine"]["intake"] == "planned"


def test_a_goal_sourced_run_is_untouched_and_still_plans(tmp_path) -> None:
    root = tmp_path / "project"
    root.mkdir(parents=True, exist_ok=True)
    state_path = root / ".multi-code" / "sprintengine" / "goal-run" / "run.yaml"
    SwarmCli(state_path, cwd=root).run("init", "--name", "goal-run", "--goal", "Build a thing")

    state = read_state(state_path)
    assert state["sprintengine"]["intake"] == "planned"
    assert state["artifacts"], "a goal run still opens its plan-approval gate"


def test_re_initialising_a_direct_run_mints_nothing_twice(tmp_path) -> None:
    root = tmp_path / "project"
    children = [
        _child(root, "login-form", "Login form"),
        _child(root, "session-store", "Session store"),
    ]
    cli, state_path = _init_epic_run(root, children)
    assert len(_tasks(state_path)) == 2

    cli.run(
        "init",
        "--name", "auth-revamp",
        "--goal", "Revamp authentication",
        "--source-json", json.dumps({
            "kind": "markdown", "origin": "reference", "path": EPIC, "planKind": "epic",
        }),
        "--source-bundle-json", json.dumps([
            {"kind": "generic_context", "origin": "reference", "path": path, "epicChild": True}
            for path in children
        ]),
    )
    assert len(_tasks(state_path)) == 2


def test_an_intake_cannot_be_flipped_by_a_second_init(tmp_path) -> None:
    """The graph exists by then; changing how it was built would be a lie."""
    root = tmp_path / "project"
    children = [_child(root, "login-form", "Login form")]
    cli, state_path = _init_epic_run(root, children)

    cli.run(
        "init",
        "--name", "auth-revamp",
        "--goal", "Revamp authentication",
        "--intake", "planned",
        "--source-json", json.dumps({
            "kind": "markdown", "origin": "reference", "path": EPIC, "planKind": "epic",
        }),
    )
    state = read_state(state_path)
    assert state["sprintengine"]["intake"] == "direct"
    assert state["artifacts"] == []


def test_a_child_with_no_h1_still_yields_a_recognisable_task(tmp_path) -> None:
    root = tmp_path / "project"
    _write(root / "backlog" / "headless.md", "---\ntype: feature\nstatus: ready\nepic: auth-revamp\n---\n\nNo heading.\n")
    _cli, state_path = _init_epic_run(root, ["backlog/headless.md"])

    assert _tasks(state_path)[0]["title"] == "headless"
