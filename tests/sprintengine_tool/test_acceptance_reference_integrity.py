"""Acceptance-reference integrity (MC-1697).

A source/acceptance reference the plan names must be found or escalated. The
root-cause failure: a mockup carrying the owner's intent was referenced as
`mockups/...` (no `backlog/` prefix); the engine resolved it from the repo root,
recorded it absent while it sat under `backlog/`, and auto-run built to the spec
text anyway. These tests pin the two engine-side fixes:

1. `source_item_absolute_path` retries a reference path under `backlog/` before
   reporting it missing.
2. `source_bundle_reference_notes` emits a machine warning naming the
   needs_input(user) escalation when a reference source resolves to no file.
"""
from __future__ import annotations

from pathlib import Path

from sprintengine_core.tool import plans


def _state_path(root: Path) -> Path:
    return root / ".sprintengine" / "sprintengine" / "team" / "run.yaml"


def _repo(tmp_path: Path, monkeypatch) -> Path:
    root = tmp_path / "project"
    (root / ".git").mkdir(parents=True)
    state_path = _state_path(root)
    state_path.parent.mkdir(parents=True)
    # repository_root_for_state consults Path.cwd() first; anchor it on the temp
    # repo so resolution does not pick up the surrounding checkout.
    monkeypatch.chdir(root)
    return root


def test_reference_resolves_under_backlog_prefix(tmp_path, monkeypatch) -> None:
    root = _repo(tmp_path, monkeypatch)
    (root / "backlog" / "mockups").mkdir(parents=True)
    (root / "backlog" / "mockups" / "x.html").write_text("<html></html>", encoding="utf-8")

    item = {"kind": "html_mockup", "origin": "reference", "path": "mockups/x.html"}
    resolved = plans.source_item_absolute_path(_state_path(root), item, "mockups/x.html")

    # Authored without the `backlog/` prefix, found under it — the exact slip.
    assert resolved == (root / "backlog" / "mockups" / "x.html").resolve()
    assert resolved.exists()


def test_reference_prefers_repo_root_when_present_at_both(tmp_path, monkeypatch) -> None:
    root = _repo(tmp_path, monkeypatch)
    (root / "mockups").mkdir(parents=True)
    (root / "mockups" / "x.html").write_text("root", encoding="utf-8")
    (root / "backlog" / "mockups").mkdir(parents=True)
    (root / "backlog" / "mockups" / "x.html").write_text("backlog", encoding="utf-8")

    item = {"kind": "html_mockup", "origin": "reference", "path": "mockups/x.html"}
    resolved = plans.source_item_absolute_path(_state_path(root), item, "mockups/x.html")

    # The as-authored root path wins; the fallback only fires when it is missing.
    assert resolved == (root / "mockups" / "x.html").resolve()


def test_missing_reference_reports_against_authored_path(tmp_path, monkeypatch) -> None:
    root = _repo(tmp_path, monkeypatch)
    item = {"kind": "html_mockup", "origin": "reference", "path": "mockups/gone.html"}
    resolved = plans.source_item_absolute_path(_state_path(root), item, "mockups/gone.html")

    # Neither root resolves → the miss is reported against the authored path.
    assert resolved == (root / "mockups" / "gone.html").resolve()
    assert not resolved.exists()


def test_reference_notes_warn_on_unresolvable_reference(tmp_path, monkeypatch) -> None:
    root = _repo(tmp_path, monkeypatch)
    (root / "backlog" / "mockups").mkdir(parents=True)
    (root / "backlog" / "mockups" / "present.html").write_text("x", encoding="utf-8")

    state = {
        "sourceBundle": [
            {"kind": "html_mockup", "origin": "reference", "path": "mockups/present.html"},
            {"kind": "html_mockup", "origin": "reference", "path": "mockups/absent.html"},
        ]
    }
    notes = plans.source_bundle_reference_notes(state, _state_path(root))
    warnings = [n for n in notes if n.startswith("WARNING")]

    # Exactly the dangling reference is flagged, naming the escalation.
    assert len(warnings) == 1
    assert "mockups/absent.html" in warnings[0]
    assert "needs_input(user)" in warnings[0]
    assert "auto-run" in warnings[0]
    # The resolvable ref keeps its normal mockup note and earns no warning.
    assert any("present.html" in n and not n.startswith("WARNING") for n in notes)


def test_reference_notes_backward_compatible_without_state_path(tmp_path, monkeypatch) -> None:
    _repo(tmp_path, monkeypatch)
    state = {
        "sourceBundle": [
            {"kind": "html_mockup", "origin": "reference", "path": "mockups/absent.html"},
        ]
    }
    # Legacy call sites that pass no state_path skip existence checking entirely —
    # no warning, no regression to the prior note set.
    notes = plans.source_bundle_reference_notes(state)
    assert all(not n.startswith("WARNING") for n in notes)
    assert any("mockups/absent.html" in n for n in notes)
