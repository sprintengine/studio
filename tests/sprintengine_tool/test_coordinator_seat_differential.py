"""The coordinator-seat contract, pinned to the matrix TypeScript answers too.

Three questions decide who coordinates a run, and each is answered twice — once
in the engine and once in the app. When the two answers differ, the run and the
board disagree about the same task: T11's audit found exactly that (`F3`), where
the app treated any live `architect_plan` as the run's plan while the engine
required the artifact to point at the run's own `plan.md`, so a second one bound
to another task made that task coordination app-side only.

The pairs, and what each answers:

| Question | Python | TypeScript |
|---|---|---|
| Who holds the seat? | `resolve_coordinator_seat` | `sprintEngineCoordinatorSeat` |
| Is this actor the seat? | `actor_is_coordinator` | `isSprintEngineCoordinatorAgent` |
| Is this task the coordination job? | `task_is_coordination` | `isSprintEngineCoordinationTask` |

Both sides answer ONE shared matrix — `tests/fixtures/coordinator-seat-matrix.json`
— whose recorded expectations are the contract. This file is its Python half;
`src/shared/sprintengine/state.test.ts` (`npm run test:shared:sprintengine-state`)
is its TypeScript half. A drift in either implementation fails its own gate, and
an intended change has to be written into the fixture, where the other half
immediately holds the other implementation to it.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from helpers import REPO_ROOT
from sprintengine_core.tool.plans import (
    actor_is_coordinator,
    resolve_coordinator_seat,
    task_is_coordination,
)

MATRIX_PATH = REPO_ROOT / "tests" / "fixtures" / "coordinator-seat-matrix.json"
MATRIX: dict[str, Any] = json.loads(MATRIX_PATH.read_text(encoding="utf-8"))


@pytest.fixture()
def state_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A run laid out the way a real one is: `<repoRoot>/.sprintengine/sprintengine/<team>/`.

    The layout is load-bearing for the path condition. `artifact_absolute_path`
    resolves an artifact path against the repository root first and the team
    folder second, so only under a real repo root do `plan.md` and the
    full-prefix `.sprintengine/sprintengine/<team>/plan.md` name the same file —
    which is what makes both spellings the run's plan. The marker directory and
    the chdir pin that root to the fixture instead of this checkout.
    """
    (tmp_path / ".git").mkdir()
    monkeypatch.chdir(tmp_path)
    team_dir = tmp_path / ".sprintengine" / "sprintengine" / MATRIX["team"]
    team_dir.mkdir(parents=True)
    return team_dir / "run.yaml"


def seat_case(name: str) -> dict[str, Any]:
    for case in MATRIX["seatCases"]:
        if case["name"] == name:
            return case
    raise AssertionError(f"Unknown seat case: {name}")


@pytest.mark.parametrize("case", MATRIX["seatCases"], ids=lambda case: case["name"])
def test_the_seat_matches_the_shared_matrix(case: dict[str, Any]) -> None:
    assert resolve_coordinator_seat(case["state"]) == {
        "role": case["seat"]["role"],
        "agentId": case["seat"]["agentId"],
    }


@pytest.mark.parametrize("case_name", sorted(MATRIX["actorIsCoordinator"]))
def test_actor_is_coordinator_matches_the_shared_matrix(case_name: str) -> None:
    """Every actor id against every seat. The two id shapes that matter both
    behave: a named seat answers for `architect-2`, and a minted roleless worker
    (`agent-1`) is never mistaken for the roleless seat."""
    state = seat_case(case_name)["state"]
    expected = MATRIX["actorIsCoordinator"][case_name]
    assert sorted(expected) == sorted(MATRIX["actorIds"]), "the matrix covers every actor id"
    assert {actor: actor_is_coordinator(state, actor) for actor in expected} == expected


@pytest.mark.parametrize("case", MATRIX["coordinationCases"], ids=lambda case: case["name"])
def test_task_is_coordination_matches_the_shared_matrix(case: dict[str, Any], state_path: Path) -> None:
    """`task_is_coordination` takes a task ID, not a task, so it structurally
    cannot read `role` or `kind` — the matrix passes tasks wearing both anyway,
    because its TypeScript half receives the whole task and could."""
    state = {"artifacts": case["artifacts"]}
    assert task_is_coordination(state, state_path, case["askTask"]["id"]) is case["isCoordination"]


def test_the_matrix_is_the_size_the_seam_review_specified() -> None:
    """A shrunk matrix is a silently weakened guard, so the shape is asserted:
    8 seat cases, 8 actor ids, 11 coordination cases."""
    assert len(MATRIX["seatCases"]) == 8
    assert len(MATRIX["actorIds"]) == 8
    assert len(MATRIX["coordinationCases"]) == 11
    assert sorted(MATRIX["actorIsCoordinator"]) == sorted(case["name"] for case in MATRIX["seatCases"])
