"""Plan-approval gate is owned by the run's planning role.

The plan-approval "gate" survives MC-1542: it is an ARTIFACT-approval task (the
user approves `plan.md`), not a quality gate, so deleting quality gates left it
untouched. The architect owns it on every architect/specialist run (those stay
byte-for-byte identical); a roster of soulless Generals with no architect plans
the run itself, so it is a `general` plan gate the General self-approves.

Also pinned here: no artifact may stay `draft` while its task is `done`. The gate
placeholder is seeded as `draft` at run creation, and a gate task can reach `done`
by four routes that never touch artifact approval — `task status`, `task publish`
(no diff), `task advance` (the phase walk's terminal `pass`), and artifact
approval itself. Each must resolve the placeholder.
"""

from __future__ import annotations

import subprocess

from helpers import create_team, get_artifact, get_task, read_state, task, write_state
from sprintengine_core.tool.plans import (
    apply_plan_gate_dependency,
    ensure_plan_approval_gate,
    find_architect_plan_gate,
    plan_path_artifact_value,
    resolve_planning_role,
)
from sprintengine_mcp import SprintEngineMcpServer


def actor(agent_id: str, role: str) -> dict[str, object]:
    return {"id": agent_id, "role": role, "mcpAuthorized": True}


def roster_state(fixture, *roles: str) -> dict:
    state = read_state(fixture.state_path)
    state.setdefault("sprintengine", {})["rosterConfigured"] = True
    state["agents"] = {
        f"{role}-1": {"role": role, "status": "idle", "currentTaskId": None} for role in roles
    }
    return state


def seed_plan_gate(fixture, *roles: str) -> dict:
    """Build a roster of the given roles and seed its plan-approval gate the way
    `sprintengine run` does, returning the persisted state."""
    state = roster_state(fixture, *roles)
    ensure_plan_approval_gate(state, fixture.state_path, "sprintengine", start_active=False)
    write_state(fixture.state_path, state)
    return read_state(fixture.state_path)


def start_plan_task(fixture, state: dict, owner: str) -> dict:
    """Hand the seeded plan task to `owner` in `in_progress` and persist."""
    plan_task = find_architect_plan_gate(state, fixture.state_path)["task"]
    plan_task["status"] = "in_progress"
    plan_task["ownerAgentId"] = owner
    write_state(fixture.state_path, state)
    return plan_task


def test_resolve_planning_role_matrix(tmp_path) -> None:
    fixture = create_team(tmp_path, "plan-role-matrix", [])
    assert resolve_planning_role(roster_state(fixture, "architect", "developer")) == "architect"
    assert resolve_planning_role(roster_state(fixture, "general")) == "general"
    # Architect wins when both are somehow present; a planner-less roster stays
    # on the architect path so existing runs are unaffected.
    assert resolve_planning_role(roster_state(fixture, "architect", "general")) == "architect"
    assert resolve_planning_role(roster_state(fixture, "developer", "tester")) == "architect"


def test_general_roster_seeds_a_general_plan_gate(tmp_path) -> None:
    fixture = create_team(tmp_path, "gen-plan-gate", [])
    plan_path_value = plan_path_artifact_value(fixture.state_path)
    state = seed_plan_gate(fixture, "general")

    gate = find_architect_plan_gate(state, fixture.state_path)
    plan_task = gate["task"]
    plan_artifact = gate["artifact"]
    assert plan_task is not None and plan_artifact is not None

    assert plan_task["role"] == "general"
    assert plan_task["title"] == "Review general plan artifact"
    assert plan_task["description"].startswith(f"General-authored active team plan at {plan_path_value}")
    assert plan_task["acceptanceCriteria"][0] == "General plan describes the execution approach and task graph."
    # The canonical plan-artifact kind is shared (renderer/find depend on it);
    # only the title/owner mark the general variant.
    assert plan_artifact["kind"] == "architect_plan"
    assert plan_artifact["title"] == "General Plan"


def test_architect_plan_gate_is_byte_for_byte_unchanged(tmp_path) -> None:
    """Regression: an architect roster must produce the exact pre-change plan
    task + artifact strings."""
    fixture = create_team(tmp_path, "arch-plan-gate", [])
    plan_path_value = plan_path_artifact_value(fixture.state_path)
    state = seed_plan_gate(fixture, "architect", "developer")

    gate = find_architect_plan_gate(state, fixture.state_path)
    plan_task = gate["task"]
    plan_artifact = gate["artifact"]

    assert plan_task["role"] == "architect"
    assert plan_task["title"] == "Review architect plan artifact"
    assert plan_task["description"] == (
        f"Architect-authored active team plan at {plan_path_value} and task graph approval gate. "
        "Use this exact path; do not read, copy, or overwrite another team's plan.md."
    )
    assert plan_task["acceptanceCriteria"] == [
        "Architect plan describes the execution approach and task graph.",
        f"Architect plan artifact is written at the active team path `{plan_path_value}`.",
        "Architect plan records confirmed decisions, repo-answered decisions, defaulted assumptions, and remaining open questions or blockers.",
        "If autonomous planning or artifact auto-approval is active, plan records conservative defaults used, risks accepted by autonomy mode, and any questions intentionally not asked.",
        "Plan is reviewed by the user and either approved to done or sent back for changes.",
    ]
    assert plan_artifact["kind"] == "architect_plan"
    assert plan_artifact["title"] == "Architect Plan"


def test_dependency_free_tasks_root_on_the_general_plan_gate(tmp_path) -> None:
    fixture = create_team(tmp_path, "gen-plan-dep", [])
    state = seed_plan_gate(fixture, "general")
    gate_task_id = find_architect_plan_gate(state, fixture.state_path)["task"]["id"]

    new_task = {"id": "T9", "role": "general", "dependsOn": []}
    apply_plan_gate_dependency(new_task, state, fixture.state_path)
    assert new_task["dependsOn"] == [gate_task_id]

    # A task with explicit dependencies is left alone (covered transitively).
    pre_dep = {"id": "T8", "role": "general", "dependsOn": ["T9"]}
    apply_plan_gate_dependency(pre_dep, state, fixture.state_path)
    assert pre_dep["dependsOn"] == ["T9"]


def test_general_self_approves_its_plan_gate(tmp_path) -> None:
    fixture = create_team(tmp_path, "gen-plan-selfapprove", [])
    state = seed_plan_gate(fixture, "general")
    plan_task = find_architect_plan_gate(state, fixture.state_path)["task"]
    plan_artifact = get_artifact(state, "A1")
    assert plan_task["id"] == "T0" and plan_artifact["kind"] == "architect_plan"

    # The General has written and readied its plan; it now approves it itself.
    plan_artifact["status"] = "ready_for_review"
    write_state(fixture.state_path, state)
    (fixture.team_dir / "plan.md").write_text("# General Plan\n", encoding="utf-8")

    server = SprintEngineMcpServer(allowed_roots=[tmp_path])
    approved = server.call_tool(
        "sprintengine.artifact.approve",
        {"statePath": str(fixture.state_path), "artifactId": "A1", "id": "general-1"},
        actor("general-1", "general"),
    )
    assert approved["ok"] is True, approved.get("error")
    assert approved["result"]["taskCompleted"] is True

    final_state = read_state(fixture.state_path)
    assert get_task(final_state, "T0")["status"] == "done"
    assert get_artifact(final_state, "A1")["approvedBy"] == "general-1"


# --- no artifact stays `draft` while its task is `done` -----------------------


def test_task_status_completion_supersedes_stuck_draft_placeholder(tmp_path) -> None:
    """Regression: a plan approval-gate placeholder seeded as `draft` must not
    survive as a live draft once its gate task is marked done directly. That is
    the task-completes-later path (the placeholder was never published or
    approved), which artifact approval never reaches."""
    fixture = create_team(tmp_path, "gate-stuck-draft", [])
    state = seed_plan_gate(fixture, "architect", "developer")
    plan_task = find_architect_plan_gate(state, fixture.state_path)["task"]
    assert plan_task["id"] == "T0"
    assert get_artifact(state, "A1")["kind"] == "architect_plan"
    assert get_artifact(state, "A1")["status"] == "draft"

    # The gate task is completed directly rather than via artifact approval,
    # leaving the placeholder unpublished.
    start_plan_task(fixture, state, "architect-1")

    done = fixture.cli.run(
        "task", "status", "--task-id", "T0", "--status", "done", "--id", "architect-1"
    )
    assert done["ok"] is True

    final_state = read_state(fixture.state_path)
    assert get_task(final_state, "T0")["status"] == "done"
    resolved = get_artifact(final_state, "A1")
    # No artifact may remain `draft` while its task is `done`.
    assert resolved["status"] == "superseded"
    assert any(entry.get("action") == "superseded" for entry in resolved["reviewHistory"])


def test_publishing_the_plan_approval_task_supersedes_stuck_draft_placeholder(tmp_path) -> None:
    """`task publish` on the plan-approval task lands it on `done`; that
    publish-driven completion must resolve the draft placeholder too.

    The plan-approval task carries `phases: []` — it is an approval surface, not
    implementation work, so its author never self-reviews a plan document. Without
    that it would inherit the run's `defaultPhases` and enter a review phase the
    moment it produced (or was assumed to have produced) a diff.
    """
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    fixture = create_team(tmp_path, "gate-publish-draft", [])
    state = seed_plan_gate(fixture, "architect", "developer")
    plan_task = start_plan_task(fixture, state, "architect-1")
    assert plan_task["id"] == "T0"
    assert plan_task["phases"] == []
    assert get_artifact(state, "A1")["status"] == "draft"

    published = fixture.cli.run(
        "task", "publish", "--task-id", "T0", "--id", "architect-1", "--summary", "Plan approved."
    )
    assert published["nextStatus"] == "done"

    final_state = read_state(fixture.state_path)
    assert get_task(final_state, "T0")["status"] == "done"
    assert get_artifact(final_state, "A1")["status"] == "superseded"


def test_advancing_a_gate_task_to_done_supersedes_stuck_draft_placeholder(tmp_path) -> None:
    """`task advance` is the done-writer that replaced `gate verdict`. A terminal
    `pass` routes the task to `done` ignoring artifact status, so without the hook
    the placeholder stays `draft` while the task is `done`."""
    gated = task("T1", "Plan work under review", "developer", "review", owner="developer-1")
    gated["startedAt"] = "2026-07-08T00:00:00Z"
    fixture = create_team(tmp_path, "gate-advance-draft", [gated])
    state = read_state(fixture.state_path)
    state.setdefault("sprintengine", {})["rosterConfigured"] = True
    state["configuredRoles"] = ["developer"]
    state["agents"] = {"developer-1": {"role": "developer", "status": "idle"}}
    state.setdefault("artifacts", []).append({
        "id": "A1",
        "kind": "architect_plan",
        "title": "Architect Plan",
        "path": "plan.md",
        "status": "draft",
        "createdBy": "architect-1",
        "taskId": "T1",
        "reviewHistory": [{"action": "created", "actor": "architect-1", "timestamp": "2026-07-05T00:00:00Z"}],
        "recommendedTasks": [],
    })
    write_state(fixture.state_path, state)

    advanced = fixture.cli.run(
        "task", "advance",
        "--task-id", "T1", "--id", "developer-1",
        "--phase", "review", "--outcome", "pass", "--summary", "Reviewed my own change.",
    )
    assert advanced["nextStatus"] == "done"

    final_state = read_state(fixture.state_path)
    assert get_task(final_state, "T1")["status"] == "done"
    assert get_artifact(final_state, "A1")["status"] == "superseded"


def test_gate_completion_leaves_unrelated_draft_artifacts_untouched(tmp_path) -> None:
    """The self-heal is bounded to the plan/product placeholder kinds: a draft
    artifact of an unrelated kind owned by the completed task is not superseded."""
    fixture = create_team(tmp_path, "gate-bounded-supersede", [])
    state = seed_plan_gate(fixture, "architect", "developer")
    plan_task = find_architect_plan_gate(state, fixture.state_path)["task"]
    plan_task["status"] = "in_progress"
    plan_task["ownerAgentId"] = "architect-1"
    state.setdefault("artifacts", []).append({
        "id": "A2",
        "kind": "design_notes",
        "title": "Design Notes",
        "path": "design.md",
        "status": "draft",
        "createdBy": "architect-1",
        "taskId": "T0",
        "reviewHistory": [{"action": "created", "actor": "architect-1", "timestamp": "2026-07-05T00:00:00Z"}],
        "recommendedTasks": [],
    })
    write_state(fixture.state_path, state)

    done = fixture.cli.run(
        "task", "status", "--task-id", "T0", "--status", "done", "--id", "architect-1"
    )
    assert done["ok"] is True

    final_state = read_state(fixture.state_path)
    assert get_artifact(final_state, "A1")["status"] == "superseded"
    # A non-placeholder draft artifact is out of scope and left as-is.
    assert get_artifact(final_state, "A2")["status"] == "draft"
