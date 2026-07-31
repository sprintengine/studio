"""Plan-approval gate is owned by the run's coordinator seat.

The plan-approval "gate" survives MC-1542: it is an ARTIFACT-approval task (the
user approves `plan.md`), not a quality gate, so deleting quality gates left it
untouched. The architect fills the seat on every architect/specialist run (those
stay byte-for-byte identical); a run that staffs no architect coordinates through
a seat with NO role, and its gate copy carries no role noun.

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
    actor_is_coordinator,
    apply_plan_gate_dependency,
    ensure_plan_approval_gate,
    find_architect_plan_gate,
    plan_path_artifact_value,
    resolve_coordinator_seat,
    task_is_coordination,
)
from sprintengine_mcp import SprintEngineMcpServer


def actor(agent_id: str, role: str) -> dict[str, object]:
    return {"id": agent_id, "role": role, "mcpAuthorized": True}


def roster_state(fixture, *roles: str) -> dict:
    # Coordination authority is `configuredRoles`, the run's enabled-role set, not a
    # seated roster (MC-1591 deleted the agents map). `resolve_coordinator_seat`
    # reads it, so the enabled roles decide the seat at init, before anyone claims.
    state = read_state(fixture.state_path)
    state.setdefault("sprintengine", {})["rosterConfigured"] = True
    state["configuredRoles"] = list(roles)
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


def test_resolve_coordinator_seat_matrix(tmp_path) -> None:
    fixture = create_team(tmp_path, "plan-role-matrix", [])
    architect_seat = {"role": "architect", "agentId": "architect"}
    roleless_seat = {"role": None, "agentId": "coordinator"}

    assert resolve_coordinator_seat(roster_state(fixture, "architect", "developer")) == architect_seat
    # Every roster with no architect coordinates through a seat with NO role —
    # including a plain-agent run, which used to have to answer `general`.
    assert resolve_coordinator_seat(roster_state(fixture, "general")) == roleless_seat
    assert resolve_coordinator_seat(roster_state(fixture, "developer", "tester")) == roleless_seat
    # A recorded EMPTY set is a deliberate choice of no roles…
    assert resolve_coordinator_seat(roster_state(fixture)) == roleless_seat
    # …while a store that never recorded the set at all is legacy or headless: it
    # predates roleless runs and keeps the architect seat.
    assert resolve_coordinator_seat(read_state(fixture.state_path)) == architect_seat


def test_actor_is_coordinator_answers_by_id_for_both_seats(tmp_path) -> None:
    fixture = create_team(tmp_path, "coordinator-actor", [])
    architect_run = roster_state(fixture, "architect", "developer")
    roleless_run = roster_state(fixture, "developer", "tester")

    # A named seat answers for every worker the spawner mints into it.
    assert actor_is_coordinator(architect_run, "architect") is True
    assert actor_is_coordinator(architect_run, "architect-2") is True
    assert actor_is_coordinator(architect_run, "developer-1") is False
    assert actor_is_coordinator(architect_run, "coordinator") is False
    # A roleless seat has no role to interpolate, so only its id answers.
    assert actor_is_coordinator(roleless_run, "coordinator") is True
    assert actor_is_coordinator(roleless_run, "developer-1") is False
    assert actor_is_coordinator(roleless_run, "") is False


def test_a_roleless_roster_seeds_a_plan_gate_with_no_role_noun(tmp_path) -> None:
    fixture = create_team(tmp_path, "roleless-plan-gate", [])
    plan_path_value = plan_path_artifact_value(fixture.state_path)
    state = seed_plan_gate(fixture, "developer", "tester")

    gate = find_architect_plan_gate(state, fixture.state_path)
    plan_task = gate["task"]
    plan_artifact = gate["artifact"]
    assert plan_task is not None and plan_artifact is not None

    assert plan_task["title"] == "Review the plan"
    assert plan_task["description"] == (
        f"Active team plan at {plan_path_value} and task graph approval gate. "
        "Use this exact path; do not read, copy, or overwrite another team's plan.md."
    )
    assert plan_task["acceptanceCriteria"][0] == "Plan describes the execution approach and task graph."
    # No role noun survives anywhere in the card the coordinator reads.
    card = " ".join([plan_task["title"], plan_task["description"], *plan_task["acceptanceCriteria"]])
    assert "Architect" not in card and "General" not in card
    # The canonical plan-artifact kind is shared (renderer/find depend on it);
    # only the title/owner differ.
    assert plan_artifact["kind"] == "architect_plan"
    assert plan_artifact["title"] == "Plan"


def test_the_plan_artifact_binding_is_what_marks_the_coordination_task(tmp_path) -> None:
    """The gate is identified by the binding alone — not its `role`, not its `kind`."""
    fixture = create_team(tmp_path, "coordination-marker", [])
    state = seed_plan_gate(fixture, "architect", "developer")
    gate = find_architect_plan_gate(state, fixture.state_path)
    gate_id = gate["task"]["id"]

    # The gate looks exactly like ordinary work on both fields that might have
    # marked it, which is why neither can be the marker.
    assert gate["task"].get("kind") is None
    assert task_is_coordination(state, fixture.state_path, gate_id) is True
    assert task_is_coordination(state, fixture.state_path, "T9") is False
    assert task_is_coordination(state, fixture.state_path, "") is False

    # Rebinding the artifact moves the answer with it; the task's role does not.
    gate["artifact"]["taskId"] = "T9"
    assert task_is_coordination(state, fixture.state_path, gate_id) is False
    assert task_is_coordination(state, fixture.state_path, "T9") is True


def test_a_legacy_store_with_no_binding_still_finds_its_gate_at_t0(tmp_path) -> None:
    """The T0 fallback carries stores written before the artifact binding existed."""
    fixture = create_team(tmp_path, "legacy-gate-fallback", [])
    state = seed_plan_gate(fixture, "architect", "developer")
    assert find_architect_plan_gate(state, fixture.state_path)["task"]["id"] == "T0"

    state["artifacts"] = []
    state.pop("configuredRoles", None)

    fallback = find_architect_plan_gate(state, fixture.state_path)
    assert fallback["artifact"] is None
    assert fallback["task"]["id"] == "T0"


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
        "Architect plan pins every contract shared between tasks — named APIs, registry seams, component props and types, store fields, schemas, IPC channels — so no cross-task interface is left for an implementer to invent.",
        "Architect plan commits to one choice per load-bearing decision, with rationale and the rejected alternative recorded; no decision is left open as an either/or for the implementer.",
        "If autonomous planning or artifact auto-approval is active, plan records conservative defaults used, risks accepted by autonomy mode, and any questions intentionally not asked.",
        "Plan is reviewed by the user and either approved to done or sent back for changes.",
    ]
    assert plan_artifact["kind"] == "architect_plan"
    assert plan_artifact["title"] == "Architect Plan"


def test_dependency_free_tasks_root_on_a_roleless_plan_gate(tmp_path) -> None:
    fixture = create_team(tmp_path, "gen-plan-dep", [])
    state = seed_plan_gate(fixture, "general")
    assert resolve_coordinator_seat(state)["role"] is None
    gate_task_id = find_architect_plan_gate(state, fixture.state_path)["task"]["id"]

    new_task = {"id": "T9", "role": "general", "dependsOn": []}
    apply_plan_gate_dependency(new_task, state, fixture.state_path)
    assert new_task["dependsOn"] == [gate_task_id]

    # A task with explicit dependencies is left alone (covered transitively).
    pre_dep = {"id": "T8", "role": "general", "dependsOn": ["T9"]}
    apply_plan_gate_dependency(pre_dep, state, fixture.state_path)
    assert pre_dep["dependsOn"] == ["T9"]


def test_a_plain_agent_run_self_approves_its_plan_gate(tmp_path) -> None:
    fixture = create_team(tmp_path, "gen-plan-selfapprove", [])
    state = seed_plan_gate(fixture, "general")
    plan_task = find_architect_plan_gate(state, fixture.state_path)["task"]
    plan_artifact = get_artifact(state, "A1")
    assert plan_task["id"] == "T0" and plan_artifact["kind"] == "architect_plan"

    # The run has written and readied its plan; it now approves it itself.
    plan_artifact["status"] = "ready_for_review"
    write_state(fixture.state_path, state)
    (fixture.team_dir / "plan.md").write_text("# Plan\n", encoding="utf-8")

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


def test_the_plan_gate_holds_the_run_until_the_user_approves_the_plan(tmp_path) -> None:
    """End to end: no worker starts until the user approves `plan.md`.

    MC-1828 deleted the plan-review-FILE flow (`plan start-review` /
    `review-status` / `address-reviews`), leaving this as the ONLY plan review:
    the user reads the plan artifact and approves its gate task. Nothing else
    asserted that the gate actually BLOCKS implementation, so the walk is pinned
    here: gate roots the graph, the claim is refused while it is open, ready
    parks it on the human, approval completes it, and only then does work claim.
    """
    fixture = create_team(tmp_path, "plan-gate-e2e", [])
    seeded = seed_plan_gate(fixture, "architect", "developer")
    gate = find_architect_plan_gate(seeded, fixture.state_path)
    assert gate["task"]["id"] == "T0" and gate["artifact"]["id"] == "A1"

    # Every dependency-free planned card roots on the gate.
    added = fixture.cli.run(
        "plan", "add-task",
        "--title", "Implement it", "--role", "developer",
        "--description", "Build the thing.", "--acceptance", "It works.",
    )
    implementation_id = added["task"]["id"]
    assert added["task"]["dependsOn"] == ["T0"]

    # Blocked: an unapproved plan means the developer has nothing to claim.
    blocked = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")
    assert blocked["claimed"] is False

    # The architect writes and readies the plan; the gate parks on the human.
    (fixture.team_dir / "plan.md").write_text("# Architect Plan\n", encoding="utf-8")
    start_plan_task(fixture, read_state(fixture.state_path), "architect-1")
    fixture.cli.run("artifact", "ready", "--artifact-id", "A1", "--id", "architect-1")
    readied_state = read_state(fixture.state_path)
    assert get_artifact(readied_state, "A1")["status"] == "ready_for_review"
    assert get_task(readied_state, "T0")["status"] == "needs_input"
    assert get_task(readied_state, "T0")["needsInput"]["reason"] == "artifact_review"

    # The user approves the plan. That single approval completes the gate.
    approved = fixture.cli.run("artifact", "approve", "--artifact-id", "A1", "--id", "user")
    assert approved["taskCompleted"] is True
    approved_state = read_state(fixture.state_path)
    assert get_artifact(approved_state, "A1")["status"] == "approved"
    assert get_task(approved_state, "T0")["status"] == "done"

    # Only now is the implementation card claimable.
    claimed = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-1")
    assert claimed["claimed"] is True
    assert claimed["task"]["id"] == implementation_id


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
