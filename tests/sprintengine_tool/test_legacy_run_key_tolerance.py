"""Backward tolerance for the run keys this simplification sprint retired.

`requiredSweeps` (MC-1825, the sweep concept), `rosterSource` (MC-1889, the
architect-decides-staffing formation) and `allowedRuntimes` (MC-1890, the Sprint
Engine model catalog) were written into `run.yaml` by shipped versions of the
app. Stores carrying them are on real machines right now, so the engine must
still load them — and must not let them do anything.

"Does nothing" is proven differentially rather than by reading the source: the
same real store is loaded twice, once as captured and once with the three keys
stripped, and every served surface must be identical. A key that still reached a
code path would have to show up as a difference.

The fixture is a copy of a real run store, not a hand-built one — see
`tests/fixtures/legacy-run-store/README.md` for exactly what was copied and the
two documented deviations.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

import pytest
import yaml

from sprintengine_core import store as folder_store
from sprintengine_mcp import SprintEngineMcpServer

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "legacy-run-store"
RETIRED_KEYS = ("requiredSweeps", "rosterSource", "allowedRuntimes")


def actor() -> dict[str, object]:
    return {"id": "operator-1", "role": "architect", "mcpAuthorized": True}


def install(root: Path, variant: str, *, strip_retired: bool, rewrite: bool = False) -> Path:
    """Copy the real store into `root` and return its run.yaml path.

    Each variant gets its own parent but the same leaf directory name: the run's
    id is derived from that leaf, and the differential below compares served
    payloads verbatim.

    By default `run.yaml` keeps the captured bytes. `rewrite` re-emits it through
    the YAML round-trip that stripping needs, so the differential can apply the
    same reformatting to both sides and leave the retired keys as the only
    difference between them.
    """
    team_dir = root / variant / "run-store"
    shutil.copytree(FIXTURE, team_dir)
    (team_dir / "README.md").unlink()
    state_path = team_dir / "run.yaml"
    if strip_retired or rewrite:
        raw = yaml.safe_load(state_path.read_text(encoding="utf-8"))
        if strip_retired:
            for key in RETIRED_KEYS:
                raw.pop(key, None)
        state_path.write_text(yaml.safe_dump(raw, sort_keys=False), encoding="utf-8")
    return state_path


def call(server: SprintEngineMcpServer, state_path: Path, name: str, **args) -> dict[str, Any]:
    payload = server.call_tool(name, {"statePath": str(state_path), **args}, actor())
    assert payload.get("ok") is True, f"{name} failed: {json.dumps(payload)[:600]}"
    return payload["result"]


def test_the_captured_store_really_carries_every_retired_key() -> None:
    """Guards the fixture itself: a copy that lost the keys would make the rest
    of this module pass vacuously."""
    raw = yaml.safe_load((FIXTURE / "run.yaml").read_text(encoding="utf-8"))

    assert raw["schemaVersion"] == 4  # v2/v3 stores are refused by design, not tolerated
    assert raw["requiredSweeps"] == [
        "ui_ux_reviewer", "nuclear_reviewer", "spec_reviewer", "tester",
    ]
    assert raw["rosterSource"] == "architect"
    assert raw["allowedRuntimes"] == [
        {"cli": "claude-code", "model": "opus[1m]"},
        {"cli": "codex", "model": None},
    ]


def test_a_legacy_store_loads_without_error(tmp_path: Path) -> None:
    state_path = install(tmp_path, "legacy", strip_retired=False)
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    run = call(server, state_path, "sprintengine.run.get")["run"]
    assert run["name"] == "mobile-relay-traffic-efficiency2"
    assert run["status"] == "completed"

    card = call(server, state_path, "sprintengine.task.get", taskId="T1")["task"]
    assert card["status"] == "done"

    summary = call(server, state_path, "sprintengine.summary")["summary"]
    assert summary["status"] == "completed"
    assert summary["tasks"]["remaining"] == 0


def test_the_two_differential_variants_differ_only_by_the_retired_keys(tmp_path: Path) -> None:
    """Control for the differentials below: if the variants differed in any other
    way, comparing them would prove nothing about the retired keys."""
    legacy = install(tmp_path, "legacy", strip_retired=False, rewrite=True)
    stripped = install(tmp_path, "stripped", strip_retired=True)

    left = yaml.safe_load(legacy.read_text(encoding="utf-8"))
    right = yaml.safe_load(stripped.read_text(encoding="utf-8"))

    assert set(left) - set(right) == set(RETIRED_KEYS)
    for key in RETIRED_KEYS:
        left.pop(key)
    assert left == right


def test_the_retired_keys_never_reach_the_projection(tmp_path: Path) -> None:
    state_path = install(tmp_path, "legacy", strip_retired=False)

    projection = folder_store.build_projection(state_path.parent, state_path=state_path)

    serialized = json.dumps(projection)
    for key in RETIRED_KEYS:
        assert key not in serialized, f"retired run key {key} survived into the projection"


def test_the_retired_keys_change_nothing_the_engine_serves(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The differential: identical stores apart from the three keys must produce
    byte-identical answers on every surface a run is read through."""
    legacy = install(tmp_path, "legacy", strip_retired=False, rewrite=True)
    stripped = install(tmp_path, "stripped", strip_retired=True)
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])
    # The projection stamps its own build time. Pin the clock rather than
    # scrubbing the field, so a difference anywhere else still fails the compare
    # and the two builds cannot straddle a second boundary.
    monkeypatch.setattr(folder_store, "now_iso", lambda: "2026-01-01T00:00:00Z")

    def surfaces(state_path: Path) -> str:
        team_dir = str(state_path.parent)
        answers = {
            "run": call(server, state_path, "sprintengine.run.get"),
            "tasks": call(server, state_path, "sprintengine.task.list"),
            "plan": call(server, state_path, "sprintengine.plan.read"),
            "artifacts": call(server, state_path, "sprintengine.artifact.list"),
            "summary": call(server, state_path, "sprintengine.summary"),
            "projection": folder_store.build_projection(
                state_path.parent, state_path=state_path
            ),
        }
        # Only the run's own directory name differs between the two copies.
        return json.dumps(answers, sort_keys=True).replace(team_dir, "<team-dir>")

    # Guard the compare itself. Without the pin the two builds can straddle a
    # second boundary and the differential fails on the clock instead of on a
    # retired key, so prove the pinned stamp really reached the projection.
    assert '"generatedAt": "2026-01-01T00:00:00Z"' in surfaces(legacy)

    assert surfaces(legacy) == surfaces(stripped)


@pytest.mark.parametrize("role", ["developer", "architect", "ui_ux_reviewer"])
def test_the_retired_keys_change_nothing_an_agent_is_told(tmp_path: Path, role: str) -> None:
    """`requiredSweeps` used to add mandatory sweep roles to the architect's
    planning directive and `rosterSource` used to branch its prompt, so the
    composed join prompt is where a surviving key would show first."""
    legacy = install(tmp_path, "legacy", strip_retired=False, rewrite=True)
    stripped = install(tmp_path, "stripped", strip_retired=True)
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    def joined(state_path: Path) -> dict[str, Any]:
        return call(
            server, state_path, "sprintengine.agent.join", role=role, agentId=f"{role}-1"
        )

    legacy_join = joined(legacy)
    stripped_join = joined(stripped)

    assert legacy_join["prompt"] == stripped_join["prompt"]
    assert legacy_join["roleManifest"] == stripped_join["roleManifest"]
    for key in RETIRED_KEYS:
        assert key not in legacy_join["prompt"]


def test_a_write_through_the_engine_carries_the_keys_over_untouched(tmp_path: Path) -> None:
    """Writing to a legacy store preserves the retired keys rather than cleaning
    them out, so a store that has them keeps them for the rest of its life.

    That is fine — they are inert — but it means "the store will drop them on the
    next write" is not a thing anyone may rely on, and it is why the differentials
    above matter for as long as these stores exist.
    """
    state_path = install(tmp_path, "legacy", strip_retired=False)
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])
    before = yaml.safe_load(state_path.read_text(encoding="utf-8"))

    call(
        server, state_path, "sprintengine.task.comment",
        taskId="T1", id="operator-1", body="Legacy-store round-trip.",
    )
    call(
        server, state_path, "sprintengine.plan.add_task", id="operator-1",
        role="developer", title="Work planned onto a legacy store",
        description="Forces a run-level rewrite, not just a task-file write.",
        acceptance=["It lands."], path=["notes.md"],
    )
    after = yaml.safe_load(state_path.read_text(encoding="utf-8"))

    assert len(after["tasks"]) == len(before["tasks"]) + 1, "the run block was never rewritten"
    for key in RETIRED_KEYS:
        assert after[key] == before[key]

    # Preserved on disk, still absent from everything the engine serves. The run
    # reopens because status is derived from the graph and it just gained a task.
    assert call(server, state_path, "sprintengine.run.get")["run"]["status"] == "planned"
    projection = folder_store.build_projection(state_path.parent, state_path=state_path)
    for key in RETIRED_KEYS:
        assert key not in json.dumps(projection)
