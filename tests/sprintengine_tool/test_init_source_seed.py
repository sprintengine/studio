"""App-created runs seed the sprint source into run.yaml at init (Slice 2).

Multicode resolves the source at workspace creation and passes it to `init` via
`--source-json`/`--source-bundle-json`, so the "Started from" seed exists at t=0
regardless of whether an agent ever runs `handover`. The Python init command
persists it into state; `write_run` round-trips it to run.yaml via
RUN_SOURCE_KEYS.
"""
from __future__ import annotations

import json
from pathlib import Path

from sprintengine_core import store as folder_store
from helpers import SwarmCli, read_state


def _workspace(tmp_path: Path):
    root = tmp_path / "project"
    root.mkdir(parents=True, exist_ok=True)
    state_path = root / ".sprintengine" / "sprintengine" / "auth-revamp" / "run.yaml"
    return root, state_path


def test_init_persists_source_and_bundle_into_run_yaml(tmp_path) -> None:
    root, state_path = _workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)

    source = {
        "kind": "markdown",
        "origin": "reference",
        "path": "backlog/epics/auth-revamp.md",
        "planKind": "epic",
        "capturedAt": "2026-07-05T00:00:00Z",
    }
    bundle = [
        {"kind": "generic_context", "origin": "reference", "path": "backlog/login-form.md", "capturedAt": "2026-07-05T00:00:00Z"},
        {"kind": "generic_context", "origin": "reference", "path": "backlog/session-store.md", "capturedAt": "2026-07-05T00:00:00Z"},
    ]

    payload = cli.run(
        "init",
        "--name", "auth-revamp",
        "--goal", "Revamp authentication",
        "--source-json", json.dumps(source),
        "--source-bundle-json", json.dumps(bundle),
    )
    assert payload["ok"] is True

    # The seed is on disk in run.yaml the moment init returns — before any agent
    # runs (kill-the-terminal scenario): the raw run file already carries it.
    run = folder_store.load_run_yaml(state_path.parent)
    assert run["source"] == source
    assert run["sourceBundle"] == bundle

    # And it round-trips back through the projection.
    state = read_state(state_path)
    assert state["source"]["planKind"] == "epic"
    assert state["source"]["origin"] == "reference"
    assert state["source"]["path"] == "backlog/epics/auth-revamp.md"
    assert [item["path"] for item in state["sourceBundle"]] == [
        "backlog/login-form.md",
        "backlog/session-store.md",
    ]


def test_init_without_source_flags_leaves_source_absent(tmp_path) -> None:
    """CLI/headless and copy-mode paths that omit the flags are unchanged."""
    root, state_path = _workspace(tmp_path)
    cli = SwarmCli(state_path, cwd=root)

    payload = cli.run("init", "--name", "auth-revamp", "--goal", "Revamp authentication")
    assert payload["ok"] is True

    run = folder_store.load_run_yaml(state_path.parent)
    assert "source" not in run
    assert "sourceBundle" not in run
