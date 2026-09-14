"""The coordinator sequences an epic's child items (backlog item 2018).

A sprint seeded from an epic mints ONE task per child item and spends its
planning effort on the graph, not on rewriting content the item already carries.
Three engine-side pieces make that possible, and are what these tests pin:

- **the marker.** A source-bundle entry that IS a child is marked as one, on both
  launch paths (`--source-plan-kind epic` handover, and the desktop's
  `--source-bundle-json`). Without it a child is indistinguishable from the
  mockups sharing the bundle, and neither the directive nor the coverage warning
  can count.
- **the directive.** The plan gate — owned by whichever role plans this run, so
  a roleless run reads identically — tells the planner one task per child,
  title from the item, empty card, modules never files, edges for overlapping
  modules and for authored `dependsOn`.
- **the coverage warning.** Plan approval names a seeded child no task delivers.
  Advisory, never a block: a deliberately partial plan is legitimate.

Goal-sourced runs are a separate intake path and must be untouched.
"""
from __future__ import annotations

import json
from pathlib import Path

from helpers import SwarmCli, read_state, write_state
from sprintengine_core.tool.plans import (
    epic_child_coverage_warnings,
    epic_child_source_paths,
    source_context_reference_lines,
)

CHILD_A = "backlog/login-form.md"
CHILD_B = "backlog/session-store.md"


def _write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def _epic_workspace(tmp_path: Path):
    """A workspace with an epic, two children, and one attached mockup."""
    root = tmp_path / "project"
    epic = _write(root / "backlog" / "epics" / "auth-revamp.md", "# Auth revamp\n\nEpic design.\n")
    child_a = _write(root / "backlog" / CHILD_A.split("/", 1)[1], "---\nepic: auth-revamp\n---\n# Login form\n")
    child_b = _write(root / "backlog" / CHILD_B.split("/", 1)[1], "---\nepic: auth-revamp\n---\n# Session store\n")
    mockup = _write(root / "backlog" / "mockups" / "login-form.html", "<h1>Login</h1>\n")
    state_path = root / ".sprintengine" / "sprintengine" / "auth-revamp" / "run.yaml"
    return root, epic, child_a, child_b, mockup, state_path


def _epic_handover(cli: SwarmCli, epic: Path, *children: Path) -> dict:
    return cli.run(
        "handover",
        "--name", "auth-revamp",
        "--goal", "Revamp authentication",
        "--handover", str(epic),
        "--source-plan-kind", "epic",
        *[arg for child in children for arg in ("--source", f"generic_context:{child}")],
        "--reference-sources",
    )


# --- the marker ---------------------------------------------------------------


def test_epic_handover_marks_every_source_as_a_child(tmp_path) -> None:
    """On `--source-plan-kind epic` the bundle IS the children — that is what the
    flag combination has always meant, so the mobile/CLI launch path needs no new
    flag to say so."""
    root, epic, child_a, child_b, _mockup, state_path = _epic_workspace(tmp_path)
    _epic_handover(SwarmCli(state_path, cwd=root), epic, child_a, child_b)

    state = read_state(state_path)
    assert all(item["epicChild"] is True for item in state["sourceBundle"])
    assert epic_child_source_paths(state) == [CHILD_A, CHILD_B]


def test_a_non_epic_handover_marks_nothing(tmp_path) -> None:
    root, _epic, child_a, _child_b, _mockup, state_path = _epic_workspace(tmp_path)
    plan = _write(root / "backlog" / "checkout-plan.md", "# Checkout plan\n")
    cli = SwarmCli(state_path, cwd=root)
    cli.run(
        "handover",
        "--name", "auth-revamp",
        "--goal", "Checkout",
        "--handover", str(plan),
        "--source-plan-kind", "architect_plan",
        "--source", f"generic_context:{child_a}",
        "--reference-sources",
    )
    state = read_state(state_path)
    assert all("epicChild" not in item for item in state["sourceBundle"])
    assert epic_child_source_paths(state) == []


def test_the_desktop_bundle_separates_children_from_the_mockups_beside_them(tmp_path) -> None:
    """The desktop launch appends a source's attached mockups to the same bundle.
    Only the entries it marked are work; the mockup is reading material."""
    root, _epic, _child_a, _child_b, _mockup, state_path = _epic_workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    cli.run(
        "init",
        "--name", "auth-revamp",
        "--goal", "Revamp authentication",
        "--source-json", json.dumps({
            "kind": "markdown", "origin": "reference",
            "path": "backlog/epics/auth-revamp.md", "planKind": "epic",
        }),
        "--source-bundle-json", json.dumps([
            {"kind": "generic_context", "origin": "reference", "path": CHILD_A, "epicChild": True},
            {"kind": "generic_context", "origin": "reference", "path": CHILD_B, "epicChild": True},
            {"kind": "html_mockup", "origin": "reference", "path": "backlog/mockups/login-form.html"},
        ]),
    )
    assert epic_child_source_paths(read_state(state_path)) == [CHILD_A, CHILD_B]


def test_the_marker_is_inert_on_a_run_that_is_not_epic_sourced(tmp_path) -> None:
    """The root plan kind is what makes a bundle a work list. A stray marker on
    any other run is ignored rather than silently promoted into a work list."""
    root, _epic, _child_a, _child_b, _mockup, state_path = _epic_workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    cli.run(
        "init",
        "--name", "auth-revamp",
        "--goal", "Revamp authentication",
        "--source-json", json.dumps({
            "kind": "markdown", "origin": "reference",
            "path": "backlog/checkout-plan.md", "planKind": "architect_plan",
        }),
        "--source-bundle-json", json.dumps([
            {"kind": "generic_context", "origin": "reference", "path": CHILD_A, "epicChild": True},
        ]),
    )
    state = read_state(state_path)
    assert epic_child_source_paths(state) == []
    assert epic_child_coverage_warnings(state) == []


# --- the directive ------------------------------------------------------------


def _init_epic_run(tmp_path, *, roles: list[str] | None = None):
    root, epic, child_a, child_b, _mockup, state_path = _epic_workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    _epic_handover(cli, epic, child_a, child_b)
    # `--intake planned` is the opt-in planning agent (MC-2128). An epic source
    # now defaults to the direct intake, which mints the graph itself and has no
    # plan gate; everything below tests the planner that a human opted into.
    init_args = ["init", "--goal", "Revamp authentication", "--intake", "planned"]
    if roles is not None:
        init_args += ["--configured-roles-json", json.dumps(roles)]
    return cli, state_path, cli.run(*init_args)


def test_the_plan_gate_directs_one_task_per_child_and_an_empty_card(tmp_path) -> None:
    _cli, _state_path, init_payload = _init_epic_run(tmp_path)
    plan_task = init_payload["planTask"]

    assert plan_task["title"] == "Sequence the epic's child items into a task graph"
    acceptance = " ".join(plan_task["acceptanceCriteria"])
    assert "Exactly one task is minted per open child item" in acceptance
    assert "no task covers two children" in acceptance
    assert "backlogRef" in acceptance
    assert "Minted tasks carry no description and no acceptance criteria" in acceptance
    assert "no minted task declares a file path" in acceptance
    assert "Tasks whose modules overlap carry an ordering edge" in acceptance
    assert "`dependsOn` frontmatter is reproduced as a dependency edge" in acceptance

    notes = " ".join(plan_task["implementationNotes"])
    # The children are named as a labelled list the planner enumerates, not as a
    # snapshot: live membership is re-checked before the plan is finished.
    assert "Epic child item" in notes
    assert "grep -l \"^epic: <slug>$\" backlog/*.md" in notes
    assert "Leave the description and acceptance criteria empty" in notes
    assert "never a file" in notes
    # The old "split a child when it genuinely needs it" licence is gone.
    assert "Split a child" not in notes
    # The planning-time grep only covers launch -> approval. The item's
    # verification pass is the END-of-run one, and it rides the terminal task
    # that already exists rather than a new mechanism.
    assert "terminal integration-review task" in notes
    assert "after the graph was approved" in notes


def test_an_unmarked_bundle_gets_the_live_grep_and_no_phantom_list(tmp_path) -> None:
    """A run store seeded before the marker existed has an unlabelled bundle.
    Pointing the planner at a labelled list that is not there would read as "no
    children"; the live membership check is what carries those runs."""
    root, _epic, _child_a, _child_b, _mockup, state_path = _epic_workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    init_payload = cli.run(
        "init",
        "--name", "auth-revamp",
        "--goal", "Revamp authentication",
        "--intake", "planned",
        "--source-json", json.dumps({
            "kind": "markdown", "origin": "reference",
            "path": "backlog/epics/auth-revamp.md", "planKind": "epic",
        }),
        "--source-bundle-json", json.dumps([
            {"kind": "generic_context", "origin": "reference", "path": CHILD_A},
        ]),
    )
    notes = " ".join(init_payload["planTask"]["implementationNotes"])
    assert "Epic child item" not in notes
    assert "grep -l \"^epic: <slug>$\" backlog/*.md" in notes


def test_the_source_context_labels_children_and_leaves_reading_material_alone(tmp_path) -> None:
    root, _epic, _child_a, _child_b, _mockup, state_path = _epic_workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    cli.run(
        "init",
        "--name", "auth-revamp",
        "--goal", "Revamp authentication",
        "--source-json", json.dumps({
            "kind": "markdown", "origin": "reference",
            "path": "backlog/epics/auth-revamp.md", "planKind": "epic",
        }),
        "--source-bundle-json", json.dumps([
            {"kind": "generic_context", "origin": "reference", "path": CHILD_A, "epicChild": True},
            {"kind": "html_mockup", "origin": "reference", "path": "backlog/mockups/login-form.html"},
        ]),
    )
    state = read_state(state_path)
    lines = source_context_reference_lines(state, state_path)
    child_line = next(line for line in lines if CHILD_A in line)
    mockup_line = next(line for line in lines if "login-form.html" in line)
    assert child_line.startswith("- Epic child item (Context):")
    assert "Epic child item" not in mockup_line


def test_a_run_with_no_architect_gets_the_same_directive(tmp_path) -> None:
    """`resolve_coordinator_seat` already answers "who coordinates"; the directive
    rides the plan gate, so a run with no architect reads identically."""
    _cli, _state_path, architect_run = _init_epic_run(tmp_path / "architect", roles=["architect", "developer"])
    _cli, _state_path, roleless_run = _init_epic_run(tmp_path / "roleless", roles=[])

    # The roleless gate carries no role at all; the architect gate is unchanged.
    assert "role" not in roleless_run["planTask"]
    assert architect_run["planTask"]["role"] == "architect"
    assert roleless_run["planTask"]["acceptanceCriteria"] == architect_run["planTask"]["acceptanceCriteria"]
    assert roleless_run["planTask"]["implementationNotes"] == architect_run["planTask"]["implementationNotes"]


# --- the coverage warning -----------------------------------------------------


def _deliver(state: dict, task_id: str, child_path: str, *, status: str = "todo") -> None:
    state.setdefault("tasks", []).append({
        "id": task_id,
        "title": f"Deliver {child_path}",
        "role": "developer",
        "status": status,
        "dependsOn": [],
        "ownedPaths": [],
        "acceptanceCriteria": [],
        "implementationNotes": [],
        "evidence": {"summary": "", "touchedFiles": [], "commandsRan": [], "results": [], "scopeExpansions": []},
        "notes": [],
        "backlogRef": {"projectRelativePath": child_path},
    })


def test_an_undelivered_child_warns_by_name(tmp_path) -> None:
    _cli, state_path, _init_payload = _init_epic_run(tmp_path)
    state = read_state(state_path)
    _deliver(state, "T5", CHILD_A)

    warnings = epic_child_coverage_warnings(state)
    assert len(warnings) == 1
    assert "epic_child_uncovered" in warnings[0]
    assert CHILD_B in warnings[0]
    assert CHILD_A not in warnings[0]


def test_a_plan_covering_every_child_is_quiet(tmp_path) -> None:
    _cli, state_path, _init_payload = _init_epic_run(tmp_path)
    state = read_state(state_path)
    _deliver(state, "T5", CHILD_A)
    _deliver(state, "T6", CHILD_B)
    assert epic_child_coverage_warnings(state) == []


def test_a_canceled_task_does_not_cover_its_child(tmp_path) -> None:
    _cli, state_path, _init_payload = _init_epic_run(tmp_path)
    state = read_state(state_path)
    _deliver(state, "T5", CHILD_A, status="canceled")
    _deliver(state, "T6", CHILD_B)
    assert CHILD_A in epic_child_coverage_warnings(state)[0]


def test_plan_approval_reports_the_gap_and_still_approves(tmp_path) -> None:
    """Advisory, never a block: a docs-only or deliberately partial plan is
    legitimate, and approval under an autonomous run must not start refusing."""
    cli, state_path, _init_payload = _init_epic_run(tmp_path)
    state = read_state(state_path)
    _deliver(state, "T5", CHILD_A)
    write_state(state_path, state)
    (state_path.parent / "plan.md").write_text("# Plan\n\nSequencing only.\n", encoding="utf-8")

    plan_artifact = next(a for a in read_state(state_path)["artifacts"] if a["kind"] == "architect_plan")
    cli.run("artifact", "ready", "--artifact-id", plan_artifact["id"], "--id", "architect-1")
    approved = cli.run("artifact", "approve", "--artifact-id", plan_artifact["id"], "--id", "user")

    assert approved["ok"] is True
    assert approved["artifact"]["status"] == "approved"
    joined = " ".join(approved["integrationWarnings"])
    assert "epic_child_uncovered" in joined
    assert CHILD_B in joined


# --- goal-sourced runs are untouched ------------------------------------------


def test_a_goal_sourced_run_keeps_its_plan_gate_verbatim(tmp_path) -> None:
    """The epic path is a SECOND intake, not a replacement. A goal-only run has
    no source, no children, no coverage warning, and the plan gate copy the
    architect has always read."""
    root = tmp_path / "project"
    root.mkdir(parents=True, exist_ok=True)
    state_path = root / ".sprintengine" / "sprintengine" / "goal-run" / "run.yaml"
    cli = SwarmCli(state_path, cwd=root)
    init_payload = cli.run("init", "--name", "goal-run", "--goal", "Build the thing")

    plan_task = init_payload["planTask"]
    assert plan_task["title"] == "Review architect plan artifact"
    assert "Sequence" not in plan_task["title"]
    assert plan_task["implementationNotes"] == []

    state = read_state(state_path)
    assert "sourceBundle" not in state
    assert epic_child_source_paths(state) == []
    assert epic_child_coverage_warnings(state) == []
