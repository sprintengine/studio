"""End-to-end smoke for soulless-General sprint runs (backlog 131 §Verification).

Tool-level harness driving the real MCP server (`SprintEngineMcpServer`) end to
end for a `general` roster: join → plan-approval gate self-approval → claim →
publish → self-review/testing gates → done, plus the structural roster fence.

Scope boundary (kept honest):
- The managed-runtime *dispatch ordering* (an idle General taking its own pending
  gate ahead of new ready work) is a renderer concern proven by
  `sprintengineAutoRunGeneralOrdering.test.ts` (task T4). Here we prove the
  tool-level facts that ordering relies on: a General's own self-review gate is
  claimable, a published task's gate is claimable by another General while a
  second task is still being implemented (review/implement interleave), and work
  is shared purely by claiming with no coordinator.
- A General-only roster derives *no* default quality gates (see
  `test_general_quality_gates.py`); the General authors its own `role: general`
  review/testing gates per the orchestration skill. No dedicated MCP tool exists
  to attach those gates, so the harness seeds them onto the General-authored task
  exactly as `store.normalize_quality_gate` produces them, then exercises the
  real claim/publish/verdict lifecycle over them.
"""

from __future__ import annotations

from pathlib import Path

from helpers import create_team, get_task, read_state, task, write_state
from sprintengine_core import store
from sprintengine_core.tool.plans import ensure_plan_approval_gate, find_architect_plan_gate
from sprintengine_mcp import SprintEngineMcpServer


def actor(agent_id: str, role: str) -> dict[str, object]:
    return {"id": agent_id, "role": role, "mcpAuthorized": True}


def general_gate(gate_id: str, phase: str) -> dict[str, object]:
    """A General-authored, self-reviewable quality gate (role `general`)."""
    gate = store.normalize_quality_gate(
        {"id": gate_id, "phase": phase, "role": "general", "status": "pending"},
        gate_id,
    )
    assert gate is not None
    assert gate["allowSelfReview"] is True  # default: the General can self-approve
    return gate


def general_impl_task(task_id: str, plan_gate_task_id: str) -> dict[str, object]:
    """An implementation task as a General plans it: role `general`, rooted on the
    plan gate, carrying its own self-review + testing gates."""
    record = task(task_id, f"Implement {task_id}", "general", depends_on=[plan_gate_task_id])
    record["producesImplementation"] = True
    record["qualityGates"] = [
        general_gate("general_review", "review"),
        general_gate("general_testing", "testing"),
    ]
    return record


def seed_general_run(tmp_path: Path, name: str, agent_ids: list[str], impl_task_ids: list[str]):
    """Create a roster of soulless Generals, seed the plan-approval gate the way
    `sprintengine run` does, and add General-authored implementation tasks rooted
    on that gate. Returns (fixture, plan_task_id, plan_artifact_id)."""
    fixture = create_team(tmp_path, name, [])
    state = read_state(fixture.state_path)
    state.setdefault("sprintengine", {})["rosterConfigured"] = True
    state["agents"] = {
        agent_id: {"role": "general", "status": "idle", "currentTaskId": None}
        for agent_id in agent_ids
    }
    ensure_plan_approval_gate(state, fixture.state_path, "sprintengine", start_active=False)
    write_state(fixture.state_path, state)

    seeded = read_state(fixture.state_path)
    gate = find_architect_plan_gate(seeded, fixture.state_path)
    plan_task_id = gate["task"]["id"]
    plan_artifact_id = gate["artifact"]["id"]
    assert gate["task"]["role"] == "general"  # planner role is the General

    for impl_id in impl_task_ids:
        seeded["tasks"].append(general_impl_task(impl_id, plan_task_id))
    # The General has written and readied its plan; mark it ready for self-approval.
    for artifact in seeded["artifacts"]:
        if artifact["id"] == plan_artifact_id:
            artifact["status"] = "ready_for_review"
    write_state(fixture.state_path, seeded)
    (fixture.team_dir / "plan.md").write_text("# General Plan\n", encoding="utf-8")
    return fixture, plan_task_id, plan_artifact_id


def roster_role_ids(state: dict) -> set[str]:
    return {agent_id for agent_id in state.get("agents", {})}


def call(server: SprintEngineMcpServer, state_path: Path, name: str, agent_id: str, actor_role: str, **args):
    return server.call_tool(name, {"statePath": str(state_path), **args}, actor(agent_id, actor_role))


def test_one_general_run_bootstraps_plans_self_reviews_then_publishes_without_roster_growth(tmp_path) -> None:
    fixture, plan_task_id, plan_artifact_id = seed_general_run(
        tmp_path, "gen-e2e-one", ["general-1"], ["T-impl"]
    )
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])
    roster_before = roster_role_ids(read_state(fixture.state_path))

    # Join: the General receives a soulless surface (no role-personality soul).
    joined = call(server, fixture.state_path, "sprintengine.agent.join", "general-1", "general",
                  role="general", agentId="general-1")
    assert joined["ok"] is True, joined.get("error")
    assert joined["result"]["roleManifest"]["soul"] == []

    # Plan-approval gate: the General self-approves its own plan (no architect).
    approved = call(server, fixture.state_path, "sprintengine.artifact.approve", "general-1", "general",
                    artifactId=plan_artifact_id, id="general-1")
    assert approved["ok"] is True, approved.get("error")
    assert get_task(read_state(fixture.state_path), plan_task_id)["status"] == "done"

    # Claim → implement → publish.
    claimed = call(server, fixture.state_path, "sprintengine.task.next", "general-1", "general",
                   role="general", id="general-1")
    assert claimed["ok"] is True and claimed["result"]["claimed"] is True
    assert claimed["result"]["task"]["id"] == "T-impl"

    call(server, fixture.state_path, "sprintengine.task.log", "general-1", "general",
         taskId="T-impl", id="general-1", summary="Implemented behavior.",
         file=["sprintengine_core/x.py"], command=["pytest"], result=["green"])
    published = call(server, fixture.state_path, "sprintengine.task.publish", "general-1", "general",
                     taskId="T-impl", id="general-1", summary="Ready for self-review.")
    assert published["ok"] is True, published.get("error")
    assert get_task(read_state(fixture.state_path), "T-impl")["status"] == "review"

    # Self-review BEFORE any new work: the General claims and approves its own
    # review gate, then its testing gate, driving the task to done.
    for gate_id in ("general_review", "general_testing"):
        gate_claim = call(server, fixture.state_path, "sprintengine.gate.next", "general-1", "general",
                          role="general", id="general-1")
        assert gate_claim["ok"] is True and gate_claim["result"]["claimed"] is True, gate_id
        assert gate_claim["result"]["gate"]["id"] == gate_id
        verdict = call(server, fixture.state_path, "sprintengine.gate.verdict", "general-1", "general",
                       taskId="T-impl", gateId=gate_id, role="general", id="general-1",
                       verdict="approved", summary=f"{gate_id} self-approved.")
        assert verdict["ok"] is True, verdict.get("error")

    final = read_state(fixture.state_path)
    assert get_task(final, "T-impl")["status"] == "done"
    # No architect/specialist ever joined and the roster never grew.
    assert roster_role_ids(final) == roster_before == {"general-1"}
    assert all(agent["role"] == "general" for agent in final["agents"].values())


def test_three_general_run_shares_work_and_interleaves_review_with_implementation(tmp_path) -> None:
    fixture, plan_task_id, plan_artifact_id = seed_general_run(
        tmp_path, "gen-e2e-three", ["general-1", "general-2", "general-3"], ["T-a", "T-b"]
    )
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])
    roster_before = roster_role_ids(read_state(fixture.state_path))

    call(server, fixture.state_path, "sprintengine.artifact.approve", "general-1", "general",
         artifactId=plan_artifact_id, id="general-1")
    assert get_task(read_state(fixture.state_path), plan_task_id)["status"] == "done"

    # Work is shared purely by claiming: two Generals take the two ready tasks,
    # the third finds none (no double-claim, no coordinator).
    claim_a = call(server, fixture.state_path, "sprintengine.task.next", "general-1", "general",
                   role="general", id="general-1")
    claim_b = call(server, fixture.state_path, "sprintengine.task.next", "general-2", "general",
                   role="general", id="general-2")
    claim_none = call(server, fixture.state_path, "sprintengine.task.next", "general-3", "general",
                      role="general", id="general-3")
    claimed_ids = {claim_a["result"]["task"]["id"], claim_b["result"]["task"]["id"]}
    assert claimed_ids == {"T-a", "T-b"}, "two Generals split the two ready tasks"
    assert claim_none["result"]["claimed"] is False, "no third claim — work is not double-assigned"

    # general-1 publishes T-a; general-3 reviews it while general-2 is still
    # implementing T-b — review and implementation interleave with no barrier.
    call(server, fixture.state_path, "sprintengine.task.log", "general-1", "general",
         taskId="T-a", id="general-1", summary="Impl done.", result=["green"])
    call(server, fixture.state_path, "sprintengine.task.publish", "general-1", "general",
         taskId="T-a", id="general-1", summary="Ready for review.")

    review_claim = call(server, fixture.state_path, "sprintengine.gate.next", "general-3", "general",
                        role="general", id="general-3")
    assert review_claim["ok"] is True and review_claim["result"]["claimed"] is True
    assert review_claim["result"]["task"]["id"] == "T-a"
    assert review_claim["result"]["gate"]["id"] == "general_review"

    mid = read_state(fixture.state_path)
    assert get_task(mid, "T-a")["status"] == "review"       # being reviewed by general-3
    assert get_task(mid, "T-b")["status"] == "in_progress"  # still implemented by general-2

    verdict = call(server, fixture.state_path, "sprintengine.gate.verdict", "general-3", "general",
                   taskId="T-a", gateId="general_review", role="general", id="general-3",
                   verdict="approved", summary="Peer review by another General.")
    assert verdict["ok"] is True, verdict.get("error")
    # T-a advanced past review to its testing gate; the team never grew.
    assert get_task(read_state(fixture.state_path), "T-a")["status"] == "testing"
    assert roster_role_ids(read_state(fixture.state_path)) == roster_before


def test_general_tool_surface_excludes_roster_growth(tmp_path) -> None:
    """AC3: a General can never expand the team — `roster.add` / `roster.replenish`
    are out of surface (denied by name), and the roster is unchanged after."""
    fixture, _plan_task_id, _plan_artifact_id = seed_general_run(
        tmp_path, "gen-e2e-fence", ["general-1"], ["T-impl"]
    )
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])
    roster_before = roster_role_ids(read_state(fixture.state_path))

    add_denied = call(server, fixture.state_path, "sprintengine.roster.add", "general-1", "general",
                      role="developer", id="developer-1")
    assert add_denied["ok"] is False
    assert add_denied["error"]["code"] == "tool_not_permitted_for_role"
    assert add_denied["error"]["details"]["role"] == "general"

    replenish_denied = call(server, fixture.state_path, "sprintengine.roster.replenish", "general-1", "general")
    assert replenish_denied["ok"] is False
    assert replenish_denied["error"]["code"] == "tool_not_permitted_for_role"

    # Authorization matches the documented surface: a General keeps read-only
    # roster *visibility* (`roster.list`) even though it cannot grow the team.
    listed = server.call_tool("sprintengine.roster.list", {"statePath": str(fixture.state_path)},
                              actor("general-1", "general"))
    assert listed["ok"] is True

    # The roster is byte-identical: no growth happened.
    assert roster_role_ids(read_state(fixture.state_path)) == roster_before == {"general-1"}
