"""Engine intake for a mixed source bundle (backlog item 2061).

The multi-select flow seeds one sprint from an arbitrary selection — several
plain items, several epics, any mix — of which the single-epic launch is a
special case. These tests pin the general shape:

- **the bundle.** A `--source-plan-kind selection` handover needs no root
  document: `epic`-kind entries are the selected epics, attachment kinds are
  reading material, every other entry is a selected work item. Work entries are
  deduped by path and classified honestly — `epicChild` (+ `epicSlug`) when the
  item's own `epic:` frontmatter names a selected epic, `selectedItem`
  otherwise, so a directly-selected child of an UNSELECTED epic is a plain item.
- **the directive.** The plan gate says "Sequence the selected items into a
  task graph", names every source by explicit path, and scopes both membership
  re-read points to exactly the selected epics' slugs. Plain items are a fixed
  list and get no membership pass.
- **the special case.** A selection of exactly one epic still arrives as
  `epic` and produces a byte-identical gate (`epic-plan-gate-card.json`,
  captured from the pre-change branch).
- **the coverage warning.** Advisory as today, but per selected epic, plus one
  for uncovered plain items.
"""
from __future__ import annotations

import json
from pathlib import Path

from helpers import SwarmCli, read_state, write_state
from sprintengine_core.tool.plans import (
    epic_child_coverage_warnings,
    epic_child_source_paths,
    selected_item_source_paths,
    selection_work_entry_paths,
    source_context_reference_lines,
)

FIXTURE_DIR = Path(__file__).resolve().parent

EPIC_AUTH = "backlog/epics/auth-revamp.md"
EPIC_BILLING = "backlog/epics/billing-cleanup.md"
CHILD_LOGIN = "backlog/login-form.md"
CHILD_SESSION = "backlog/session-store.md"
CHILD_INVOICE = "backlog/invoice-dedupe.md"
PLAIN_SEARCH = "backlog/search-index.md"
PLAIN_EXPORT = "backlog/export-csv.md"
ORPHAN_CHILD = "backlog/orphan-tweak.md"  # child of an UNSELECTED epic
MOCKUP = "backlog/mockups/login-form.html"


def _write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def _selection_workspace(tmp_path: Path):
    """Two epics (three children between them), two plain items, one child of an
    unselected epic, and one attached mockup."""
    root = tmp_path / "project"
    _write(root / EPIC_AUTH, "# Auth revamp\n\nEpic design.\n")
    _write(root / EPIC_BILLING, "# Billing cleanup\n\nEpic design.\n")
    _write(root / CHILD_LOGIN, "---\nepic: auth-revamp\n---\n# Login form\n")
    _write(root / CHILD_SESSION, "---\nepic: auth-revamp\n---\n# Session store\n")
    _write(root / CHILD_INVOICE, "---\nepic: billing-cleanup\n---\n# Invoice dedupe\n")
    _write(root / PLAIN_SEARCH, "---\ntype: feature\n---\n# Search index\n")
    _write(root / PLAIN_EXPORT, "# Export CSV\n")
    _write(root / ORPHAN_CHILD, "---\nepic: some-other-epic\n---\n# Orphan tweak\n")
    _write(root / MOCKUP, "<h1>Login</h1>\n")
    state_path = root / ".sprintengine" / "sprintengine" / "mixed-selection" / "run.yaml"
    return root, state_path


def _selection_handover(cli: SwarmCli, root: Path, *sources: tuple[str, str]) -> dict:
    return cli.run(
        "handover",
        "--name", "mixed-selection",
        "--goal", "Deliver the selection",
        "--source-plan-kind", "selection",
        *[arg for kind, path in sources for arg in ("--source", f"{kind}:{root / path}")],
        "--reference-sources",
    )


def _full_selection(cli: SwarmCli, root: Path) -> dict:
    return _selection_handover(
        cli, root,
        ("epic", EPIC_AUTH),
        ("epic", EPIC_BILLING),
        ("generic_context", CHILD_LOGIN),
        ("generic_context", CHILD_SESSION),
        ("generic_context", CHILD_INVOICE),
        ("generic_context", PLAIN_SEARCH),
        ("generic_context", PLAIN_EXPORT),
        ("generic_context", ORPHAN_CHILD),
        ("html_mockup", MOCKUP),
    )


# --- the bundle ---------------------------------------------------------------


def test_a_selection_handover_needs_no_root_and_classifies_every_entry(tmp_path) -> None:
    root, state_path = _selection_workspace(tmp_path)
    _full_selection(SwarmCli(state_path, cwd=root), root)

    state = read_state(state_path)
    assert state["source"]["planKind"] == "selection"
    by_path = {item["path"]: item for item in state["sourceBundle"]}

    for child, slug in ((CHILD_LOGIN, "auth-revamp"), (CHILD_SESSION, "auth-revamp"), (CHILD_INVOICE, "billing-cleanup")):
        assert by_path[child]["epicChild"] is True
        assert by_path[child]["epicSlug"] == slug
        assert "selectedItem" not in by_path[child]
    for plain in (PLAIN_SEARCH, PLAIN_EXPORT, ORPHAN_CHILD):
        assert by_path[plain]["selectedItem"] is True
        assert "epicChild" not in by_path[plain]
    for non_work in (EPIC_AUTH, EPIC_BILLING, MOCKUP):
        assert "epicChild" not in by_path[non_work]
        assert "selectedItem" not in by_path[non_work]

    assert epic_child_source_paths(state) == [CHILD_LOGIN, CHILD_SESSION, CHILD_INVOICE]
    assert selected_item_source_paths(state) == [PLAIN_SEARCH, PLAIN_EXPORT, ORPHAN_CHILD]


def test_a_child_of_an_unselected_epic_is_a_plain_item(tmp_path) -> None:
    root, state_path = _selection_workspace(tmp_path)
    _selection_handover(
        SwarmCli(state_path, cwd=root), root,
        ("epic", EPIC_AUTH),
        ("generic_context", CHILD_LOGIN),
        ("generic_context", ORPHAN_CHILD),
    )
    state = read_state(state_path)
    assert epic_child_source_paths(state) == [CHILD_LOGIN]
    assert selected_item_source_paths(state) == [ORPHAN_CHILD]


def test_an_epics_own_child_also_selected_directly_is_one_work_entry(tmp_path) -> None:
    """The selection contains auth-revamp AND its own child. The bundle keeps one
    entry for the child, classified as the epic's child — the (repo, path) dedupe
    that keeps `assert_backlog_ref_unclaimed` from ever being asked to mint the
    item twice."""
    root, state_path = _selection_workspace(tmp_path)
    _selection_handover(
        SwarmCli(state_path, cwd=root), root,
        ("epic", EPIC_AUTH),
        ("generic_context", CHILD_LOGIN),
        ("generic_context", CHILD_LOGIN),
        ("generic_context", PLAIN_SEARCH),
    )
    state = read_state(state_path)
    child_entries = [item for item in state["sourceBundle"] if item["path"] == CHILD_LOGIN]
    assert len(child_entries) == 1
    assert child_entries[0]["epicChild"] is True
    assert selection_work_entry_paths(state) == [CHILD_LOGIN, PLAIN_SEARCH]


def test_the_app_seeded_bundle_is_normalized_at_init(tmp_path) -> None:
    """The desktop path seeds via --source-bundle-json with per-entry marks. Init
    settles flavor from frontmatter — a child marked `selectedItem` by the
    launcher lands as its selected epic's child — and unmarked entries stay
    reading material."""
    root, state_path = _selection_workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    cli.run(
        "init",
        "--name", "mixed-selection",
        "--goal", "Deliver the selection",
        "--source-json", json.dumps({
            "kind": "selection", "origin": "selection", "path": "backlog",
            "planKind": "selection",
        }),
        "--source-bundle-json", json.dumps([
            {"kind": "epic", "origin": "reference", "path": EPIC_AUTH},
            {"kind": "generic_context", "origin": "reference", "path": CHILD_LOGIN, "selectedItem": True},
            {"kind": "generic_context", "origin": "reference", "path": PLAIN_SEARCH, "selectedItem": True},
            {"kind": "html_mockup", "origin": "reference", "path": MOCKUP},
        ]),
    )
    state = read_state(state_path)
    assert epic_child_source_paths(state) == [CHILD_LOGIN]
    assert selected_item_source_paths(state) == [PLAIN_SEARCH]
    mockup = next(item for item in state["sourceBundle"] if item["path"] == MOCKUP)
    assert "epicChild" not in mockup and "selectedItem" not in mockup


def test_the_source_context_labels_children_items_and_reading_material(tmp_path) -> None:
    root, state_path = _selection_workspace(tmp_path)
    _full_selection(SwarmCli(state_path, cwd=root), root)
    state = read_state(state_path)
    lines = source_context_reference_lines(state, state_path)

    assert any(line.startswith("- Epic child item (Context):") and CHILD_LOGIN in line for line in lines)
    assert any(line.startswith("- Selected item (Context):") and PLAIN_SEARCH in line for line in lines)
    epic_line = next(line for line in lines if EPIC_AUTH in line)
    assert epic_line.startswith("- Epic:")
    mockup_line = next(line for line in lines if MOCKUP in line)
    assert "Epic child item" not in mockup_line and "Selected item" not in mockup_line


# --- the directive ------------------------------------------------------------


def _init_selection_run(tmp_path):
    root, state_path = _selection_workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    _full_selection(cli, root)
    return cli, state_path, cli.run(
        "init", "--goal", "Deliver the selection",
        "--configured-roles-json", json.dumps(["architect", "developer"]),
    )


def test_the_plan_gate_sequences_the_selection_and_names_every_source(tmp_path) -> None:
    _cli, _state_path, init_payload = _init_selection_run(tmp_path)
    plan_task = init_payload["planTask"]

    assert plan_task["title"] == "Sequence the selected items into a task graph"
    for path in (EPIC_AUTH, EPIC_BILLING, CHILD_LOGIN, CHILD_SESSION, CHILD_INVOICE, PLAIN_SEARCH, PLAIN_EXPORT, MOCKUP):
        assert path in plan_task["description"]

    acceptance = " ".join(plan_task["acceptanceCriteria"])
    assert "Exactly one task is minted per selected work item" in acceptance
    assert "a child of a selected epic is minted once" in acceptance
    assert "backlogRef" in acceptance
    assert "Minted tasks carry no description and no acceptance criteria" in acceptance
    assert "no minted task declares a file path" in acceptance
    assert "Tasks whose modules overlap carry an ordering edge" in acceptance
    assert "`dependsOn` frontmatter is reproduced as a dependency edge" in acceptance

    notes = " ".join(plan_task["implementationNotes"])
    assert "`Epic child item` or `Selected item`" in notes
    assert "Leave the description and acceptance criteria empty" in notes


def test_both_membership_passes_cover_exactly_the_selected_epics_slugs(tmp_path) -> None:
    _cli, _state_path, init_payload = _init_selection_run(tmp_path)
    notes = init_payload["planTask"]["implementationNotes"]

    live_note = next(note for note in notes if note.startswith("Re-check live membership"))
    terminal_note = next(note for note in notes if "terminal integration-review task" in note)
    for slug in ("auth-revamp", "billing-cleanup"):
        assert f'`grep -l "^epic: {slug}$" backlog/*.md`' in live_note
    assert "some-other-epic" not in live_note
    assert "<slug>" not in live_note
    assert "Directly-selected items are a fixed list and get no membership pass" in live_note
    assert "each selected epic named above" in terminal_note


def test_a_selection_of_plain_items_only_gets_no_membership_pass(tmp_path) -> None:
    root, state_path = _selection_workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    _selection_handover(
        cli, root,
        ("generic_context", PLAIN_SEARCH),
        ("generic_context", PLAIN_EXPORT),
    )
    init_payload = cli.run("init", "--goal", "Deliver the selection")
    notes = " ".join(init_payload["planTask"]["implementationNotes"])
    assert "Re-check live membership" not in notes
    assert "terminal integration-review task" not in notes
    assert "grep -l" not in notes


def test_a_selection_run_opens_no_product_gate_without_a_product_plan(tmp_path) -> None:
    root, state_path = _selection_workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    _full_selection(cli, root)
    init_payload = cli.run("init", "--goal", "Deliver the selection")
    assert init_payload["productTask"] is None


# --- the single-epic special case ---------------------------------------------


def test_a_one_epic_selection_still_arrives_as_epic_and_the_gate_is_byte_identical(tmp_path) -> None:
    """The renderer sends a selection of exactly one epic as planKind `epic`
    (the T4 contract). That launch must produce the pre-change gate byte for
    byte — fixture captured from the branch before this change."""
    root = tmp_path / "project"
    epic = _write(root / "backlog" / "epics" / "auth-revamp.md", "# Auth revamp\n\nEpic design.\n")
    child_a = _write(root / "backlog" / "login-form.md", "---\nepic: auth-revamp\n---\n# Login form\n")
    child_b = _write(root / "backlog" / "session-store.md", "---\nepic: auth-revamp\n---\n# Session store\n")
    state_path = root / ".sprintengine" / "sprintengine" / "auth-revamp" / "run.yaml"
    cli = SwarmCli(state_path, cwd=root)
    cli.run(
        "handover",
        "--name", "auth-revamp",
        "--goal", "Revamp authentication",
        "--handover", str(epic),
        "--source-plan-kind", "epic",
        "--source", f"generic_context:{child_a}",
        "--source", f"generic_context:{child_b}",
        "--reference-sources",
    )
    init_payload = cli.run(
        "init", "--goal", "Revamp authentication",
        # The gate this pins is the opt-in planner's (MC-2128); an epic source
        # otherwise takes the direct intake and mints no gate at all.
        "--intake", "planned",
        "--configured-roles-json", json.dumps(["architect", "developer"]),
    )
    plan_task = init_payload["planTask"]
    fixture = json.loads((FIXTURE_DIR / "epic-plan-gate-card.json").read_text(encoding="utf-8"))
    assert plan_task["title"] == fixture["title"]
    assert plan_task["description"] == fixture["description"]
    assert plan_task["acceptanceCriteria"] == fixture["acceptanceCriteria"]
    assert plan_task["implementationNotes"] == fixture["implementationNotes"]


# --- minting and the write-time guard -----------------------------------------


def test_minting_one_task_per_work_entry_and_the_guard_refuses_a_double_mint(tmp_path) -> None:
    """A run seeded from 2 epics + 3 plain items mints one task per open epic
    child plus one per plain item, each carrying its backlogRef; a second task
    for an already-delivered item is refused at write time."""
    cli, state_path, _init_payload = _init_selection_run(tmp_path)
    state = read_state(state_path)
    work_paths = selection_work_entry_paths(state)
    assert work_paths == [
        CHILD_LOGIN, CHILD_SESSION, CHILD_INVOICE,
        PLAIN_SEARCH, PLAIN_EXPORT, ORPHAN_CHILD,
    ]

    minted: list[str] = []
    for index, path in enumerate(work_paths):
        payload = cli.run(
            "plan", "add-task",
            "--actor", "architect-1",
            "--title", f"Deliver {path}",
            "--role", "developer",
            "--path", "src",
            "--backlog-ref", path,
        )
        minted.append(payload["task"]["id"])
        assert payload["task"]["backlogRef"]["projectRelativePath"] == path
    assert len(minted) == len(set(minted)) == 6

    refused = cli.run_failure(
        "plan", "add-task",
        "--actor", "architect-1",
        "--title", "Deliver it again",
        "--role", "developer",
        "--path", "src",
        "--backlog-ref", CHILD_LOGIN,
    )
    assert CHILD_LOGIN in refused.stderr + refused.stdout


# --- the T3×T4 seam (T7): the renderer's bundle through intake to minting -----


def test_seam_a_two_epic_three_item_selection_mints_a_deduped_task_set(tmp_path) -> None:
    """The AC shape end to end: a bundle of 2 epics + 3 plain items — one of them
    a selected epic's OWN child, arriving twice (picked directly AND implied by
    its epic, exactly what MC-2060's builder hands over) — seeded through the
    real handover path, then minted. The task set must be deduped with each
    task carrying the right backlogRef."""
    root, state_path = _selection_workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    _selection_handover(
        cli, root,
        ("epic", EPIC_AUTH),
        ("epic", EPIC_BILLING),
        ("generic_context", CHILD_LOGIN),   # picked directly…
        ("generic_context", CHILD_LOGIN),   # …and implied by its selected epic
        ("generic_context", PLAIN_SEARCH),
        ("generic_context", PLAIN_EXPORT),
    )
    init_payload = cli.run(
        "init", "--goal", "Deliver the selection",
        "--configured-roles-json", json.dumps(["architect", "developer"]),
    )
    assert init_payload["planTask"]["title"] == "Sequence the selected items into a task graph"

    state = read_state(state_path)
    assert state["source"]["planKind"] == "selection"
    child_entries = [item for item in state["sourceBundle"] if item["path"] == CHILD_LOGIN]
    assert len(child_entries) == 1, "the twice-selected child rides the bundle once"
    assert child_entries[0]["epicChild"] is True
    assert child_entries[0]["epicSlug"] == "auth-revamp"
    work_paths = selection_work_entry_paths(state)
    assert work_paths == [CHILD_LOGIN, PLAIN_SEARCH, PLAIN_EXPORT]

    minted: dict[str, str] = {}
    for path in work_paths:
        payload = cli.run(
            "plan", "add-task",
            "--actor", "architect-1",
            "--title", f"Deliver {path}",
            "--role", "developer",
            "--path", "src",
            "--backlog-ref", path,
        )
        minted[path] = payload["task"]["id"]
        assert payload["task"]["backlogRef"]["projectRelativePath"] == path
    assert len(set(minted.values())) == 3, "one task per selected work item, no twins"

    refused = cli.run_failure(
        "plan", "add-task",
        "--actor", "architect-1",
        "--title", "Deliver the login form again",
        "--role", "developer",
        "--path", "src",
        "--backlog-ref", CHILD_LOGIN,
    )
    assert CHILD_LOGIN in refused.stderr + refused.stdout


def test_seam_the_dialog_init_seed_shape_lands_and_gates_identically(tmp_path) -> None:
    """The desktop dialog (MC-2062) seeds at init with the EXACT shape
    buildSprintEngineInitSourceSeed emits: source {kind: 'markdown', origin:
    'reference', path: <anchor>, planKind: 'selection', capturedAt} and bundle
    entries {kind, origin: 'reference', path, capturedAt, epicChild/selectedItem}
    — the anchor epic riding the bundle as well as being the root. That byte
    shape must land as a selection run whose gate sequences the work entries."""
    root, state_path = _selection_workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)
    captured_at = "2026-07-31T12:00:00.000Z"
    init_payload = cli.run(
        "init",
        "--name", "mixed-selection",
        "--goal", "Deliver the selection",
        "--configured-roles-json", json.dumps(["architect", "developer"]),
        "--source-json", json.dumps({
            "kind": "markdown", "origin": "reference", "path": EPIC_AUTH,
            "planKind": "selection", "capturedAt": captured_at,
        }),
        "--source-bundle-json", json.dumps([
            {"kind": "epic", "origin": "reference", "path": EPIC_AUTH, "capturedAt": captured_at},
            {"kind": "generic_context", "origin": "reference", "path": CHILD_LOGIN, "capturedAt": captured_at, "epicChild": True},
            {"kind": "epic", "origin": "reference", "path": EPIC_BILLING, "capturedAt": captured_at},
            {"kind": "generic_context", "origin": "reference", "path": PLAIN_SEARCH, "capturedAt": captured_at, "selectedItem": True},
            {"kind": "generic_context", "origin": "reference", "path": PLAIN_EXPORT, "capturedAt": captured_at, "selectedItem": True},
        ]),
    )

    state = read_state(state_path)
    assert state["source"]["planKind"] == "selection"
    assert state["source"]["path"] == EPIC_AUTH
    assert epic_child_source_paths(state) == [CHILD_LOGIN]
    assert selected_item_source_paths(state) == [PLAIN_SEARCH, PLAIN_EXPORT]
    anchor = next(item for item in state["sourceBundle"] if item["path"] == EPIC_AUTH)
    assert "epicChild" not in anchor and "selectedItem" not in anchor, "the anchor epic is scope, not work"

    plan_task = init_payload["planTask"]
    assert plan_task is not None, "the app-seeded init still mints the selection plan gate"
    assert plan_task["title"] == "Sequence the selected items into a task graph"
    live_note = next(
        note for note in plan_task["implementationNotes"] if note.startswith("Re-check live membership")
    )
    for slug in ("auth-revamp", "billing-cleanup"):
        assert f'`grep -l "^epic: {slug}$" backlog/*.md`' in live_note


# --- the coverage warning -----------------------------------------------------


def _deliver(state: dict, task_id: str, item_path: str, *, status: str = "todo") -> None:
    state.setdefault("tasks", []).append({
        "id": task_id,
        "title": f"Deliver {item_path}",
        "role": "developer",
        "status": status,
        "dependsOn": [],
        "ownedPaths": [],
        "acceptanceCriteria": [],
        "implementationNotes": [],
        "evidence": {"summary": "", "touchedFiles": [], "commandsRan": [], "results": [], "scopeExpansions": []},
        "notes": [],
        "backlogRef": {"projectRelativePath": item_path},
    })


def test_coverage_warns_per_selected_epic_and_once_for_plain_items(tmp_path) -> None:
    _cli, state_path, _init_payload = _init_selection_run(tmp_path)
    state = read_state(state_path)
    _deliver(state, "T5", CHILD_LOGIN)

    warnings = epic_child_coverage_warnings(state)
    auth = next(w for w in warnings if "`auth-revamp`" in w)
    billing = next(w for w in warnings if "`billing-cleanup`" in w)
    plain = next(w for w in warnings if w.startswith("selected_item_uncovered"))
    assert len(warnings) == 3
    assert auth.startswith("epic_child_uncovered")
    assert CHILD_SESSION in auth and CHILD_LOGIN not in auth and CHILD_INVOICE not in auth
    assert CHILD_INVOICE in billing
    assert PLAIN_SEARCH in plain and PLAIN_EXPORT in plain and ORPHAN_CHILD in plain


def test_a_fully_covered_selection_is_quiet_and_approval_reports_gaps(tmp_path) -> None:
    cli, state_path, _init_payload = _init_selection_run(tmp_path)
    state = read_state(state_path)
    for index, path in enumerate(selection_work_entry_paths(state)):
        _deliver(state, f"T{index + 5}", path)
    assert epic_child_coverage_warnings(state) == []

    # Drop one delivery and approve the plan: the gap rides the advisory
    # integrationWarnings channel and approval still succeeds.
    state["tasks"] = [t for t in state["tasks"] if t.get("backlogRef", {}).get("projectRelativePath") != CHILD_INVOICE]
    write_state(state_path, state)
    (state_path.parent / "plan.md").write_text("# Plan\n\nSequencing only.\n", encoding="utf-8")
    plan_artifact = next(a for a in read_state(state_path)["artifacts"] if a["kind"] == "architect_plan")
    cli.run("artifact", "ready", "--artifact-id", plan_artifact["id"], "--id", "architect-1")
    approved = cli.run("artifact", "approve", "--artifact-id", plan_artifact["id"], "--id", "user")
    assert approved["ok"] is True
    joined = " ".join(approved["integrationWarnings"])
    assert "`billing-cleanup`" in joined and CHILD_INVOICE in joined
