"""Phase runtime bindings — a stronger model reviews every task (MC-1543).

Premium mode on top of MC-1542. `phaseRuntimes.review = {cli, model}` makes each
task's review phase a FRESH, diff-seeded session on that runtime while cheap models
do the building.

The cost invariant is the whole point of these tests: **absent the key, zero extra
sessions are created**, and a binding equal to the owner's own runtime buys nothing.
An operator must never pay for a session by accident.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from helpers import create_team, get_task, read_state, task, write_state
from sprintengine_core import store as folder_store
from sprintengine_core.tool.state import (
    apply_phase_runtimes,
    phase_needs_own_session,
    with_locked_state,
)
from sprintengine_core.tool.tasks import (
    advance_task,
    claim_phase_session,
    publish_task,
    task_awaiting_phase_session,
)

FABLE = {"cli": "claude-code", "model": "fable"}
HAIKU = {"cli": "claude-code", "model": "haiku"}


# --- binding validation ------------------------------------------------------


def test_phase_runtimes_validate_against_the_sprint_palette() -> None:
    state = {"allowedRuntimes": [FABLE]}
    apply_phase_runtimes(state, json.dumps({"review": FABLE}))
    assert state["phaseRuntimes"] == {"review": {"cli": "claude-code", "model": "fable"}}

    with pytest.raises(SystemExit, match="runtime_not_allowed_for_run"):
        apply_phase_runtimes({"allowedRuntimes": [FABLE]}, json.dumps({"review": HAIKU}))


def test_phase_runtimes_reject_an_unknown_phase_and_a_missing_cli() -> None:
    with pytest.raises(SystemExit, match="unknown phase"):
        apply_phase_runtimes({}, json.dumps({"testing": FABLE}))
    # A binding with no CLI cannot spawn a session; accepting it would leave the
    # operator believing they had bought independent review.
    with pytest.raises(SystemExit, match="requires a cli"):
        apply_phase_runtimes({}, json.dumps({"review": {"model": "fable"}}))


def test_absent_phase_runtimes_leaves_the_key_off() -> None:
    state: dict = {}
    apply_phase_runtimes(state, None)
    apply_phase_runtimes(state, "  ")
    apply_phase_runtimes(state, "{}")
    assert "phaseRuntimes" not in state


def test_phase_runtimes_round_trip_through_run_yaml_and_projection(tmp_path: Path) -> None:
    fixture = create_team(tmp_path, "pr-roundtrip", [task("T1", "Work", "developer")])
    state = read_state(fixture.state_path)
    state["phaseRuntimes"] = {"review": FABLE}
    write_state(fixture.state_path, state)

    assert folder_store.load_run_yaml(fixture.team_dir)["phaseRuntimes"] == {"review": FABLE}
    assert read_state(fixture.state_path)["phaseRuntimes"] == {"review": FABLE}
    projection = json.loads((fixture.team_dir / folder_store.PROJECTION_FILE).read_text(encoding="utf-8"))
    assert projection["run"]["phaseRuntimes"] == {"review": FABLE}


# --- the cost invariant ------------------------------------------------------


def test_no_binding_means_no_handoff() -> None:
    """MC-1542 default: absent the key, zero extra sessions."""
    assert phase_needs_own_session({}, {"cli": "claude-code", "model": "haiku"}, "review") is False


def test_a_binding_equal_to_the_owners_runtime_means_no_handoff() -> None:
    """The operator pays only for a genuinely different runtime."""
    state = {"phaseRuntimes": {"review": FABLE}}
    assert phase_needs_own_session(state, {"cli": "claude-code", "model": "fable"}, "review") is False


def test_a_different_binding_means_a_handoff() -> None:
    state = {"phaseRuntimes": {"review": FABLE}}
    assert phase_needs_own_session(state, {"cli": "claude-code", "model": "haiku"}, "review") is True
    # An unstamped task (CLI default) is also different from an explicit binding.
    assert phase_needs_own_session(state, {}, "review") is True


# --- publish handoff ---------------------------------------------------------


def _team(tmp_path: Path, name: str, tasks: list[dict], **run_keys):
    fixture = create_team(tmp_path, name, tasks)
    state = read_state(fixture.state_path)
    state["sprintengine"]["rosterConfigured"] = True
    state["agents"] = {
        "developer-1": {"role": "developer", "status": "idle"},
        # The bound phase session is a fresh task-scoped id.
        "developer-2": {"role": "developer", "status": "idle"},
    }
    state.update(run_keys)
    write_state(fixture.state_path, state)
    return fixture


def _owned(status: str = "in_progress", owner: str = "developer-1", **extra) -> dict:
    record = task("T1", "Work", "developer", status=status, owner=owner)
    record["startedAt"] = "2026-07-08T00:00:00Z"
    record.update(extra)
    return record


def _mutate(fixture, fn):
    return with_locked_state(fixture.state_path, lambda state: {"ok": True, **(fn(state) or {})})


def _publish(fixture, *, produced: bool = True):
    import sprintengine_core.tool.tasks as tasks_module

    original = tasks_module.task_produced_changes
    tasks_module.task_produced_changes = lambda *_a, **_k: produced
    try:
        return _mutate(fixture, lambda state: {
            "result": publish_task(state, fixture.state_path, get_task(state, "T1"), "developer-1", "done it")
        })
    finally:
        tasks_module.task_produced_changes = original


def test_publish_releases_the_task_to_a_bound_phase_session(tmp_path: Path) -> None:
    fixture = _team(
        tmp_path, "handoff-publish",
        [_owned(cli="claude-code", model="haiku")],
        phaseRuntimes={"review": FABLE},
    )
    result = _publish(fixture)["result"]

    assert result["nextStatus"] == "review"
    assert result["awaitingPhaseSession"] == {"phase": "review", "runtime": FABLE}

    record = read_state(fixture.state_path)["tasks"][0]
    assert record["status"] == "review"
    # Released from the implementer — the bound session becomes the owner.
    assert record["ownerAgentId"] is None
    # Attribution survives the handoff.
    assert record["lastImplementedByAgentId"] == "developer-1"


def test_publish_keeps_the_owner_when_the_binding_matches(tmp_path: Path) -> None:
    fixture = _team(
        tmp_path, "handoff-match",
        [_owned(cli="claude-code", model="fable")],
        phaseRuntimes={"review": FABLE},
    )
    result = _publish(fixture)["result"]

    assert result["awaitingPhaseSession"] is None
    record = read_state(fixture.state_path)["tasks"][0]
    assert record["ownerAgentId"] == "developer-1"
    assert "awaitingPhaseSession" not in record


def test_publish_with_no_binding_keeps_the_owner(tmp_path: Path) -> None:
    fixture = _team(tmp_path, "handoff-none", [_owned(cli="claude-code", model="haiku")])
    assert _publish(fixture)["result"]["awaitingPhaseSession"] is None
    assert read_state(fixture.state_path)["tasks"][0]["ownerAgentId"] == "developer-1"


# --- the phase session claims the task ---------------------------------------


def test_a_phase_session_takes_over_ownership_without_rewinding_the_task(tmp_path: Path) -> None:
    fixture = _team(
        tmp_path, "handoff-claim",
        [_owned(status="review", cli="claude-code", model="haiku")],
        phaseRuntimes={"review": FABLE},
    )

    def prepare(state):
        record = get_task(state, "T1")
        record["ownerAgentId"] = None
        record["lastImplementedByAgentId"] = "developer-1"
        record["awaitingPhaseSession"] = {"phase": "review", "runtime": FABLE}
        return {}

    _mutate(fixture, prepare)
    state = read_state(fixture.state_path)
    assert task_awaiting_phase_session(get_task(state, "T1")) == "review"

    claimed = _mutate(fixture, lambda st: {"claim": claim_phase_session(st, get_task(st, "T1"), "developer-2")})
    assert claimed["claim"]["phase"] == "review"

    record = read_state(fixture.state_path)["tasks"][0]
    # Never rewound to in_progress: the diff is published, the task is mid-walk.
    assert record["status"] == "review"
    assert record["ownerAgentId"] == "developer-2"
    # Re-stamped to the phase runtime — that is what the operator is paying for.
    assert record["cli"] == "claude-code"
    assert record["model"] == "fable"
    # The implementer stays identifiable for attribution.
    assert record["lastImplementedByAgentId"] == "developer-1"
    assert "awaitingPhaseSession" not in record


def test_an_owned_task_is_not_awaiting_a_phase_session() -> None:
    record = {"status": "review", "ownerAgentId": "developer-1", "awaitingPhaseSession": {"phase": "review"}}
    assert task_awaiting_phase_session(record) is None


def test_a_stale_marker_for_another_phase_is_ignored() -> None:
    record = {"status": "in_progress", "ownerAgentId": None, "awaitingPhaseSession": {"phase": "review"}}
    assert task_awaiting_phase_session(record) is None


def test_claiming_a_task_that_is_not_awaiting_a_session_is_rejected(tmp_path: Path) -> None:
    fixture = _team(tmp_path, "handoff-bad-claim", [_owned(status="review")])
    with pytest.raises(SystemExit, match="not awaiting a phase session"):
        _mutate(fixture, lambda st: {"x": claim_phase_session(st, get_task(st, "T1"), "developer-2")})


# --- the phase session is a full owner ---------------------------------------


def test_the_phase_session_advances_the_task_exactly_like_any_owner(tmp_path: Path) -> None:
    """All MC-1542 invariants hold: strictly forward, no re-entry, owner-only."""
    fixture = _team(
        tmp_path, "handoff-advance",
        [_owned(status="review", owner="developer-2", cli="claude-code", model="fable")],
        phaseRuntimes={"review": FABLE},
    )
    result = _mutate(fixture, lambda st: {
        "r": advance_task(st, get_task(st, "T1"), "developer-2", "review", "pass_with_fixes", "Fixed a null deref.")
    })["r"]

    assert result["nextStatus"] == "done"
    record = read_state(fixture.state_path)["tasks"][0]
    assert record["status"] == "done"
    assert record["ownerAgentId"] is None


def test_escalating_clears_the_awaiting_marker(tmp_path: Path) -> None:
    fixture = _team(tmp_path, "handoff-escalate", [_owned(status="review", owner="developer-2")])

    def go(state):
        record = get_task(state, "T1")
        record["awaitingPhaseSession"] = {"phase": "review", "runtime": FABLE}
        return {"r": advance_task(
            state, record, "developer-2", "review", "escalate", "Scope is wrong.",
            needs_input={"kind": "architect", "question": "Which contract?"},
        )}

    assert _mutate(fixture, go)["r"]["nextStatus"] == "needs_input"
    record = read_state(fixture.state_path)["tasks"][0]
    assert "awaitingPhaseSession" not in record


def test_advancing_to_done_clears_the_awaiting_marker(tmp_path: Path) -> None:
    fixture = _team(tmp_path, "handoff-done", [_owned(status="review", owner="developer-2")])

    def go(state):
        record = get_task(state, "T1")
        record["awaitingPhaseSession"] = {"phase": "review", "runtime": FABLE}
        return {"r": advance_task(state, record, "developer-2", "review", "pass", "Clean.")}

    _mutate(fixture, go)
    assert "awaitingPhaseSession" not in read_state(fixture.state_path)["tasks"][0]


# --- task.next routes the bound session to its phase --------------------------


def test_task_next_hands_the_bound_session_its_diff_seeded_brief(tmp_path: Path) -> None:
    from sprintengine_core.tool.commands.task import cmd_task_next

    record = _owned(status="review", cli="claude-code", model="haiku")
    record["evidence"]["summary"] = "Rewired the panel."
    record["evidence"]["touchedFiles"] = ["src/panel.tsx"]
    fixture = _team(tmp_path, "handoff-next", [record], phaseRuntimes={"review": FABLE})

    def prepare(state):
        candidate = get_task(state, "T1")
        candidate["ownerAgentId"] = None
        candidate["lastImplementedByAgentId"] = "developer-1"
        candidate["awaitingPhaseSession"] = {"phase": "review", "runtime": FABLE}
        return {}

    _mutate(fixture, prepare)

    class Args:
        state = fixture.state_path
        role = "developer"
        id = "developer-2"
        model = None
        cli = None

    result = cmd_task_next(Args())
    assert result["claimed"] is True
    assert result["phase"] == "review"
    prompt = result["prompt"]
    assert "Sprint Engine Phase Handover" in prompt
    assert "Rewired the panel." in prompt          # the diff-seeded brief
    assert "src/panel.tsx" in prompt
    assert "read it as if a stranger wrote it" in prompt

    claimed = read_state(fixture.state_path)["tasks"][0]
    assert claimed["ownerAgentId"] == "developer-2"
    assert claimed["model"] == "fable"


def test_a_spent_worker_id_cannot_run_a_phase_session(tmp_path: Path) -> None:
    """The per_task capacity guard still holds: a fresh id must run the phase."""
    from sprintengine_core.tool.commands.task import cmd_task_next

    fixture = _team(tmp_path, "handoff-capacity", [_owned(status="review")], phaseRuntimes={"review": FABLE})

    def prepare(state):
        candidate = get_task(state, "T1")
        candidate["ownerAgentId"] = None
        candidate["awaitingPhaseSession"] = {"phase": "review", "runtime": FABLE}
        # `developer-2` already spent its single claim on another task.
        state["agents"]["developer-2"]["ownedTaskIds"] = ["T9"]
        return {}

    _mutate(fixture, prepare)

    class Args:
        state = fixture.state_path
        role = "developer"
        id = "developer-2"
        model = None
        cli = None

    result = cmd_task_next(Args())
    assert result["claimed"] is False
    assert result["reason"] == "worker_task_capacity_reached"
    assert read_state(fixture.state_path)["tasks"][0]["ownerAgentId"] is None
