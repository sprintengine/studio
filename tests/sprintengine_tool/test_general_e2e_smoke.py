"""End-to-end smoke for soulless-General sprint runs (backlog 131 §Verification).

Tool-level harness driving the real MCP server (`SprintEngineMcpServer`) end to
end for a `general` roster: join → plan-approval gate self-approval → claim →
publish → self-review phase → done, plus the structural roster fence.

Scope boundary (kept honest):
- The managed-runtime *dispatch ordering* (an idle General resuming its own task
  in review ahead of new ready work) is a renderer concern proven by
  `sprintengineAutoRunGeneralOrdering.test.ts` (task T4). Here we prove the
  tool-level facts that ordering relies on: a published General task enters its
  review phase still owned by its author, a second General keeps implementing a
  different task while the first reviews its own (review/implement interleave),
  and work is shared purely by claiming with no coordinator.
- Post-MC-1542 there is no quality-gate configuration to seed: publish routes on
  change detection into the run's `phases`, and the task's own owner walks them
  with `task.advance`. No General ever reviews another General's task.
"""

from __future__ import annotations

from pathlib import Path

from helpers import create_team, get_task, read_state, task, write_state
from sprintengine_core import store as folder_store
from sprintengine_core.tool.plans import ensure_plan_approval_gate, find_architect_plan_gate
from sprintengine_mcp import SprintEngineMcpServer


def actor(agent_id: str, role: str) -> dict[str, object]:
    return {"id": agent_id, "role": role, "mcpAuthorized": True}


def general_impl_task(task_id: str, plan_gate_task_id: str) -> dict[str, object]:
    """An implementation task as a General plans it: role `general`, rooted on the
    plan gate. It carries no gate configuration — the review phase is the run's."""
    record = task(task_id, f"Implement {task_id}", "general", depends_on=[plan_gate_task_id])
    record["producesImplementation"] = True
    return record


def seed_general_run(tmp_path: Path, name: str, agent_ids: list[str], impl_task_ids: list[str]):
    """Create a roster of soulless Generals, seed the plan-approval gate the way
    `sprintengine run` does, and add General-authored implementation tasks rooted
    on that gate. Returns (fixture, plan_task_id, plan_artifact_id)."""
    fixture = create_team(tmp_path, name, [])
    state = read_state(fixture.state_path)
    state.setdefault("sprintengine", {})["rosterConfigured"] = True
    # `general` is the run's only enabled role, so the planner resolves to the
    # General (MC-1591: planning authority is configuredRoles, not a seated roster).
    state["configuredRoles"] = ["general"]
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


def present_worker_roles(fixture) -> set[str]:
    """The roles present in the run's lease-derived workers view (no agents map).

    The "roster never grew" invariant under leases: this set never contains a role
    outside `configuredRoles`, because a claim can only mint a lease for a role the
    run enabled — there is no roster-growth op to add another.
    """
    projection = folder_store.build_projection(fixture.team_dir, state_path=fixture.state_path)
    return {str(worker.get("role") or "") for worker in projection["workers"].values()}


def call(server: SprintEngineMcpServer, state_path: Path, name: str, agent_id: str, actor_role: str, **args):
    return server.call_tool(name, {"statePath": str(state_path), **args}, actor(agent_id, actor_role))


def test_one_general_run_bootstraps_plans_self_reviews_then_publishes_without_roster_growth(tmp_path) -> None:
    fixture, plan_task_id, plan_artifact_id = seed_general_run(
        tmp_path, "gen-e2e-one", ["general-1"], ["T-impl"]
    )
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    # Join: the General receives a soulless surface (no role-personality soul).
    joined = call(server, fixture.state_path, "sprintengine.agent.join", "general-1", "general",
                  role="general", agentId="general-1")
    assert joined["ok"] is True, joined.get("error")
    # `general` composes its brief from SPRINTENGINE_GENERAL_SKILLS, not a manifest.
    assert joined["result"]["roleManifest"]["directives"] == {}
    assert joined["result"]["roleManifest"]["sweep"] is None

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
    assert published["result"]["nextStatus"] == "review"
    # The review directive rides back inline; there is no second claim.
    assert published["result"]["nextDirective"]
    published_task = get_task(read_state(fixture.state_path), "T-impl")
    assert published_task["status"] == "review"
    assert published_task["ownerAgentId"] == "general-1"

    # Self-review: the General reviews the work it just made and closes the phase.
    advanced = call(server, fixture.state_path, "sprintengine.task.advance", "general-1", "general",
                    taskId="T-impl", id="general-1", phase="review", outcome="pass_with_fixes",
                    summary="Self-reviewed and fixed a null guard.")
    assert advanced["ok"] is True, advanced.get("error")
    assert advanced["result"]["nextStatus"] == "done"

    final = read_state(fixture.state_path)
    assert get_task(final, "T-impl")["status"] == "done"
    assert get_task(final, "T-impl")["ownerAgentId"] is None
    # No architect/specialist ever appeared and the enabled-role set never grew:
    # every worker the run ever had is a General.
    assert present_worker_roles(fixture) == {"general"}
    assert final["configuredRoles"] == ["general"]


def test_three_general_run_shares_work_and_interleaves_review_with_implementation(tmp_path) -> None:
    fixture, plan_task_id, plan_artifact_id = seed_general_run(
        tmp_path, "gen-e2e-three", ["general-1", "general-2", "general-3"], ["T-a", "T-b"]
    )
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

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

    # general-1 publishes T-a and reviews it itself while general-2 is still
    # implementing T-b — review and implementation interleave with no barrier.
    call(server, fixture.state_path, "sprintengine.task.log", "general-1", "general",
         taskId="T-a", id="general-1", summary="Impl done.", result=["green"])
    call(server, fixture.state_path, "sprintengine.task.publish", "general-1", "general",
         taskId="T-a", id="general-1", summary="Ready for review.")

    mid = read_state(fixture.state_path)
    assert get_task(mid, "T-a")["status"] == "review"       # self-reviewed by general-1
    assert get_task(mid, "T-a")["ownerAgentId"] == "general-1"
    assert get_task(mid, "T-b")["status"] == "in_progress"  # still implemented by general-2

    # A published task in review is NOT spare capacity: an idle General cannot pick
    # it up, and cannot advance a phase it does not own.
    idle_claim = call(server, fixture.state_path, "sprintengine.task.next", "general-3", "general",
                      role="general", id="general-3")
    assert idle_claim["result"]["claimed"] is False
    stolen = call(server, fixture.state_path, "sprintengine.task.advance", "general-3", "general",
                  taskId="T-a", id="general-3", phase="review", outcome="pass", summary="Peer review.")
    assert stolen["ok"] is False
    assert "not_task_owner" in stolen["error"]["message"]

    advanced = call(server, fixture.state_path, "sprintengine.task.advance", "general-1", "general",
                    taskId="T-a", id="general-1", phase="review", outcome="pass",
                    summary="Self-reviewed; nothing to fix.")
    assert advanced["ok"] is True, advanced.get("error")
    after = read_state(fixture.state_path)
    assert get_task(after, "T-a")["status"] == "done"
    assert get_task(after, "T-b")["status"] == "in_progress"
    # Only Generals ever worked the run; no other role appeared.
    assert present_worker_roles(fixture) == {"general"}
    assert after["configuredRoles"] == ["general"]


def test_general_cannot_grow_the_team_the_roster_ops_are_gone(tmp_path) -> None:
    """AC3: a General can never expand the team. MC-1591 replaced the roster with
    leases, so the growth ops (`roster.add` / `roster.replenish` / `roster.list`)
    no longer exist at all — a call to one is an unknown tool, for anyone. Membership
    is `configuredRoles`, which no agent tool can widen."""
    fixture, _plan_task_id, _plan_artifact_id = seed_general_run(
        tmp_path, "gen-e2e-fence", ["general-1"], ["T-impl"]
    )
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    for tool_name, args in (
        ("sprintengine.roster.add", {"role": "developer", "id": "developer-1"}),
        ("sprintengine.roster.replenish", {}),
        ("sprintengine.roster.list", {}),
    ):
        gone = call(server, fixture.state_path, tool_name, "general-1", "general", **args)
        assert gone["ok"] is False, tool_name
        assert gone["error"]["code"] == "unknown_tool", tool_name

    # The enabled-role set is untouched: no growth path exists.
    assert read_state(fixture.state_path)["configuredRoles"] == ["general"]
