"""Multi-repo vcs seam: pass-through + single-source discipline (MC-1615).

The seam lets a future schema-v4 multi-repo run carry an unknown `vcs.repos`
array end-to-end without any surface stripping it. The TS normalizer
(`normalizeSprintEngineVcs`) and the mobile snapshot (`buildVcsState`) preserve
it verbatim (covered by their own TS tests); these tests pin the Python half —
`build_projection` and the state round-trip through `sync` — and the phase-prompt
worktree discipline being emitted from a single template site.
"""
from __future__ import annotations

from pathlib import Path

from helpers import base_state, read_state, write_state
from sprintengine_core import store as folder_store
from sprintengine_core.tool import phase_prompts

# A representative multi-repo array the engine does not interpret yet: the seam
# must carry it through unread, so the assertions compare it verbatim.
REPOS = [
    {"repoRoot": "packages/api", "branchName": "sprintengine/checkout-api", "baseRef": "main"},
    {"repoRoot": "packages/web", "branchName": "sprintengine/checkout-web", "baseRef": "main"},
]


def _vcs_with_repos() -> dict:
    return {
        "mode": "run_worktree",
        "repoRoot": ".",
        "worktreePath": ".multi-code/sprintengine/alpha/worktree",
        "branchName": "sprintengine/alpha",
        "baseRef": "main",
        "status": "ready",
        "repos": REPOS,
    }


def _hand_write_run_yaml(tmp_path: Path, vcs: dict) -> Path:
    """Initialize the folder store, then hand-write run.yaml carrying `vcs`.

    `initialize_run_store` lays down the status folders `build_projection`
    requires; overwriting run.yaml afterwards is the "hand-written run.yaml" the
    acceptance criteria call for — a store the projection never itself produced.
    """
    team_dir = tmp_path / ".multi-code" / "sprintengine" / "alpha"
    folder_store.initialize_run_store(team_dir, name="alpha", goal="seam", status="executing")
    run = folder_store.load_run_yaml(team_dir)
    run["schemaVersion"] = folder_store.RUN_SCHEMA_VERSION
    run["sprintengine"]["vcs"] = vcs
    folder_store.atomic_write_yaml(team_dir / folder_store.RUN_FILE, run)
    return team_dir


def test_build_projection_preserves_vcs_repos(tmp_path) -> None:
    # AC1: a hand-written run.yaml with vcs.repos survives build_projection whole.
    team_dir = _hand_write_run_yaml(tmp_path, _vcs_with_repos())

    projection = folder_store.build_projection(team_dir, state_path=team_dir / folder_store.RUN_FILE)

    projected_vcs = projection["run"]["vcs"]
    assert projected_vcs is not None
    assert projected_vcs["repos"] == REPOS, "vcs.repos preserved verbatim in projection"
    # The known fields still ride through alongside the unknown array.
    assert projected_vcs["branchName"] == "sprintengine/alpha"
    assert projected_vcs["worktreePath"] == ".multi-code/sprintengine/alpha/worktree"


def test_build_projection_omits_repos_when_absent(tmp_path) -> None:
    # No `repos` key must not synthesize one — absence round-trips as absence, so a
    # legacy single-repo run stays byte-identical through the seam.
    vcs = _vcs_with_repos()
    del vcs["repos"]
    team_dir = _hand_write_run_yaml(tmp_path, vcs)

    projection = folder_store.build_projection(team_dir, state_path=team_dir / folder_store.RUN_FILE)

    assert "repos" not in projection["run"]["vcs"]


def test_vcs_repos_round_trips_through_sync_and_projection(tmp_path) -> None:
    # AC4: state carrying vcs.repos survives sync (write) -> reload -> projection with
    # no field loss. The mobile snapshot half of the round-trip is a TS surface
    # (buildVcsState) with its own test; this pins the Python projection it reads.
    state = base_state("alpha", [])
    state["sprintengine"]["vcs"] = _vcs_with_repos()
    team_dir = tmp_path / ".multi-code" / "sprintengine" / "alpha"
    state_path = team_dir / "run.yaml"

    write_state(state_path, state)

    # Reloaded semantic state keeps the array (state -> run.yaml -> state).
    reloaded = read_state(state_path)
    assert reloaded["sprintengine"]["vcs"]["repos"] == REPOS

    # And the projection the renderer/mobile read carries it too.
    projection = folder_store.build_projection(team_dir, state_path=state_path)
    assert projection["run"]["vcs"]["repos"] == REPOS


def test_worktree_discipline_emitted_from_single_template_site() -> None:
    # AC2: the worktree-discipline text has one source. Both the no-worktree and
    # shared-worktree prompts compose from `_execution_workspace_discipline_block`,
    # so the shared header and owned-paths rules are written exactly once.
    source = Path(phase_prompts.__file__).read_text(encoding="utf-8")
    for line in (
        "## Execution Workspace Discipline",
        "- Treat task-owned paths as the primary edit surface and collision boundary.",
        "- The canonical plan is normally `.multi-code/sprintengine/<team>/plan.md`; do not use any other `plan.md` found by search.",
    ):
        assert source.count(line) == 1, f"discipline line duplicated (not single-sourced): {line!r}"

    # Both public blocks still emit the shared discipline through the one template.
    plan_block = phase_prompts.worker_plan_worktree_block()
    assert "## Execution Workspace Discipline" in plan_block
    assert "- Do not create Sprint Engine worktrees." in plan_block

    vcs_state = base_state("alpha", [])
    vcs_state["sprintengine"]["vcs"] = _vcs_with_repos()
    worktree_block = phase_prompts.worker_execution_workspace_block(
        vcs_state, Path("/tmp/ws/.multi-code/sprintengine/alpha/run.yaml")
    )
    assert "## Execution Workspace Discipline" in worktree_block
    assert "## Committing Your Work" in worktree_block
    # The shared owned-paths rule is byte-identical in both — proof of one source.
    shared = "- Treat task-owned paths as the primary edit surface and collision boundary."
    assert shared in plan_block and shared in worktree_block
