"""Plan-approval gate is owned by the run's planning role.

The architect owns the plan gate on every architect/specialist run (those stay
byte-for-byte identical); a roster of soulless Generals with no architect plans
the run itself, so the gate is a `general` plan gate the General self-approves.
"""

from __future__ import annotations

from helpers import create_team, get_artifact, get_task, read_state, write_state
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


def test_gate_task_completion_supersedes_stuck_draft_placeholder(tmp_path) -> None:
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
    plan_task["status"] = "in_progress"
    plan_task["ownerAgentId"] = "architect-1"
    write_state(fixture.state_path, state)

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
