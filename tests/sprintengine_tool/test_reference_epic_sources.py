"""Reference-based epic sprint sources (MC-1447).

File-backed sprint sources (an epic and its child design docs, or any backlog
item) are recorded as project-root-relative references, not copied into the run
store. The architect reviews and updates the originals in place.
"""
from __future__ import annotations

from pathlib import Path

from helpers import SwarmCli, read_state


def _write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def _epic_workspace(tmp_path: Path):
    """A disposable workspace root with an epic + two children under backlog/."""
    root = tmp_path / "project"
    epic = _write(root / "backlog" / "epics" / "auth-revamp.md", "# Auth revamp\n\nEpic design.\n")
    child_a = _write(root / "backlog" / "login-form.md", "---\nepic: auth-revamp\n---\n# Login form\n")
    child_b = _write(root / "backlog" / "session-store.md", "---\nepic: auth-revamp\n---\n# Session store\n")
    state_path = root / ".multi-code" / "sprintengine" / "auth-revamp" / "run.yaml"
    return root, epic, child_a, child_b, state_path


def test_epic_reference_handover_records_references_without_copying(tmp_path) -> None:
    root, epic, child_a, child_b, state_path = _epic_workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)

    payload = cli.run(
        "handover",
        "--name", "auth-revamp",
        "--goal", "Revamp authentication",
        "--handover", str(epic),
        "--source-plan-kind", "epic",
        "--source", f"generic_context:{child_a}",
        "--source", f"generic_context:{child_b}",
        "--reference-sources",
    )
    assert payload["ok"] is True

    team_dir = state_path.parent
    # No content was copied into the run store.
    assert not (team_dir / "handover.md").exists()
    assert not (team_dir / "sources").exists()

    state = read_state(state_path)
    source = state["source"]
    assert source["origin"] == "reference"
    assert source["planKind"] == "epic"
    assert source["path"] == "backlog/epics/auth-revamp.md"
    assert "originalPath" not in source  # reference points straight at the canonical file

    bundle = state["sourceBundle"]
    assert [item["path"] for item in bundle] == ["backlog/login-form.md", "backlog/session-store.md"]
    assert all(item["origin"] == "reference" for item in bundle)
    assert all("fingerprint" not in item for item in bundle)

    # The root handoff artifact points at the canonical epic file, approved, no fingerprint.
    root_artifacts = [a for a in state["artifacts"] if a.get("title") == "Source Handoff"]
    assert len(root_artifacts) == 1
    assert root_artifacts[0]["path"] == "backlog/epics/auth-revamp.md"
    assert root_artifacts[0]["status"] == "approved"
    assert root_artifacts[0]["fingerprint"] is None


def test_epic_init_mints_review_in_place_plan_task_without_seeding_plan(tmp_path) -> None:
    root, epic, child_a, child_b, state_path = _epic_workspace(tmp_path)
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
    # The planning agent is opt-in since MC-2128; an epic source defaults to the
    # direct intake, which mints the graph itself and opens no plan gate.
    init_payload = cli.run("init", "--goal", "Revamp authentication", "--intake", "planned")
    assert init_payload["ok"] is True

    team_dir = state_path.parent
    # plan.md is authored by the architect as a manifest, never seeded at init.
    assert not (team_dir / "plan.md").exists()
    # No product intake gate: no product_plan child exists.
    assert init_payload.get("productTask") is None

    plan_task = init_payload["planTask"]
    assert plan_task["title"] == "Sequence the epic's child items into a task graph"
    joined_ac = " ".join(plan_task["acceptanceCriteria"]).lower()
    assert "child item of the epic is enumerated" in joined_ac
    assert "not re-authored into plan.md" in joined_ac
    # The task context references the canonical originals in place.
    assert "backlog/epics/auth-revamp.md" in plan_task["description"]
    assert "backlog/login-form.md" in plan_task["description"]


def test_epic_with_product_plan_child_opens_product_gate_from_reference(tmp_path) -> None:
    root, epic, child_a, _child_b, state_path = _epic_workspace(tmp_path)
    product_child = _write(
        root / "backlog" / "product-brief.md",
        "---\nepic: auth-revamp\n---\n# Product brief\n\nAuthoritative requirements.\n",
    )
    cli = SwarmCli(state_path, cwd=root)
    cli.run(
        "handover",
        "--name", "auth-revamp",
        "--goal", "Revamp authentication",
        "--handover", str(epic),
        "--source-plan-kind", "epic",
        "--source", f"generic_context:{child_a}",
        "--source", f"product_plan:{product_child}",
        "--reference-sources",
    )
    init_payload = cli.run("init", "--goal", "Revamp authentication")

    # A product_plan child opens the intake gate and seeds product-requirements.md
    # from the referenced original (out-of-scope to change product intake).
    assert init_payload.get("productTask") is not None
    seeded = (state_path.parent / "product-requirements.md").read_text(encoding="utf-8")
    assert "Authoritative requirements." in seeded


def test_markdown_reference_handover_leaves_no_copy(tmp_path) -> None:
    root = tmp_path / "project"
    plan = _write(root / "backlog" / "checkout-plan.md", "# Checkout plan\n\nDetails.\n")
    state_path = root / ".multi-code" / "sprintengine" / "checkout" / "run.yaml"
    cli = SwarmCli(state_path, cwd=root)
    cli.run(
        "handover",
        "--name", "checkout",
        "--goal", "Checkout",
        "--handover", str(plan),
        "--source-plan-kind", "architect_plan",
        "--reference-sources",
    )
    team_dir = state_path.parent
    assert not (team_dir / "handover.md").exists()
    state = read_state(state_path)
    assert state["source"]["origin"] == "reference"
    assert state["source"]["path"] == "backlog/checkout-plan.md"


def test_referenced_plan_init_mints_review_in_place_task_without_seeding_plan(tmp_path) -> None:
    root = tmp_path / "project"
    plan = _write(root / "backlog" / "checkout-plan.md", "# Checkout plan\n\nDetails.\n")
    state_path = root / ".multi-code" / "sprintengine" / "checkout" / "run.yaml"
    cli = SwarmCli(state_path, cwd=root)
    cli.run(
        "handover",
        "--name", "checkout",
        "--goal", "Checkout",
        "--handover", str(plan),
        "--source-plan-kind", "architect_plan",
        "--reference-sources",
    )
    init_payload = cli.run("init", "--goal", "Checkout")
    assert init_payload["ok"] is True

    # The referenced backlog file is the canonical plan; plan.md is authored by
    # the architect as a thin manifest, never seeded with a copy at init.
    assert not (state_path.parent / "plan.md").exists()

    plan_task = init_payload["planTask"]
    assert plan_task["title"] == "Review referenced plan in place and create task graph"
    assert "backlog/checkout-plan.md" in plan_task["description"]
    joined_ac = " ".join(plan_task["acceptanceCriteria"])
    assert "not re-authored into plan.md" in joined_ac
    assert "plan.md is a manifest" in joined_ac
    notes = " ".join(plan_task["implementationNotes"])
    # MC-1614: the copy to edit is named per project, since a run has one worktree
    # per declared project rather than a single run worktree.
    assert "the copy of the referenced plan in its own project's worktree" in notes


def test_text_handover_still_copies_into_run_store(tmp_path) -> None:
    state_path = tmp_path / "project" / ".multi-code" / "sprintengine" / "inline" / "run.yaml"
    cli = SwarmCli(state_path, cwd=tmp_path / "project")
    (tmp_path / "project").mkdir(parents=True, exist_ok=True)
    cli.run(
        "handover",
        "--name", "inline",
        "--goal", "Inline",
        "--handover-text", "Build the feature.",
    )
    # Inline/stdin sources have no durable file, so they keep the copy behavior.
    assert (state_path.parent / "handover.md").is_file()
