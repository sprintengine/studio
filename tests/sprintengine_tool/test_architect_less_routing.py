"""A run with no architect must still route: triage, escalation, plan review, comments.

MC-1585: the default product is a pool of plain agents, so such a run coordinates
itself. Every path that asked "is this role literally `architect`?" silently
dead-ended it — the blocked task queued forever with nobody allowed to triage it.
The answer is now a SEAT (`resolve_coordinator_seat`), roleless whenever the run
staffs no architect, and reached by id (`actor_is_coordinator`). These pin the
planner-routed behavior end to end through the real CLI, not hand-built state.
"""

from __future__ import annotations

import json

from helpers import SwarmCli, create_team, read_state, task, write_state
from sprintengine_core import store as folder_store
from sprintengine_mcp import ActorContext, McpRequestContext, SprintEngineMcpServer


def worker_roles(fixture) -> set[str]:
    """The roles present in the run's lease-derived workers view (no agents map)."""
    projection = folder_store.build_projection(fixture.team_dir, state_path=fixture.state_path)
    return {str(worker.get("role") or "") for worker in projection["workers"].values()}


COORDINATOR = "coordinator"


def roleless_run(tmp_path, name: str, tasks=None, roles=()):
    """A run with no architect: its coordinator seat therefore carries no role.

    `roles=()` is the genuinely roleless run — `configuredRoles: []`, tasks with
    no role at all. Pass a specialist list for the other architect-less shape: a
    rostered team that simply staffs no architect.
    """
    fixture = create_team(tmp_path, name, tasks or [])
    state = read_state(fixture.state_path)
    state["configuredRoles"] = list(roles)
    state.setdefault("sprintengine", {})["rosterConfigured"] = True
    write_state(fixture.state_path, state)
    return fixture


def block_task(fixture, task_id: str, kind: str = "architect", agent_id: str = "agent-1") -> dict:
    return fixture.cli.run(
        "task", "status",
        "--task-id", task_id,
        "--id", agent_id,
        "--status", "needs_input",
        "--needs-input-kind", kind,
        "--needs-input-question", "The acceptance criteria contradict the owned paths.",
    )


def test_the_coordinator_receives_the_triage_directive_on_join(tmp_path) -> None:
    # run.py gated the triage directive on `args.role == "architect"`, so the agent
    # coordinating a run with queued planner-actionable work was told there was
    # nothing to triage — the blocked task queued forever.
    fixture = roleless_run(tmp_path, "roleless-triage-join", [task("T1", "Build it")])
    block_task(fixture, "T1")

    joined = fixture.cli.run("join", "--id", COORDINATOR)

    assert joined["action"] == "needs_input_triage"
    assert "triage needs-input" in joined["prompt"]


def test_the_coordinator_can_triage_without_an_architect_seat(tmp_path) -> None:
    # cmd_triage_needs_input hardcoded ensure_agent_in_roster(state, id, "architect"),
    # which forced an off-roster architect seat that add_roster_agent then rejected.
    fixture = roleless_run(tmp_path, "roleless-triage-run", [task("T1", "Build it")])
    block_task(fixture, "T1")

    triaged = fixture.cli.run("triage", "needs-input", "--id", COORDINATOR)

    assert [entry["id"] for entry in triaged["tasks"]] == ["T1"]
    assert "You are the Sprint Engine coordinator" in triaged["prompt"]
    # The triage prompt must hand the agent its OWN id, not the literal `architect`.
    assert f"--id {COORDINATOR}" in triaged["prompt"]
    assert "--id architect " not in triaged["prompt"]
    # No architect worker was conjured onto a run that staffs none (leases derive
    # the worker set; there is no agents map to seat a phantom architect into).
    assert "architect" not in worker_roles(fixture)
    assert read_state(fixture.state_path)["configuredRoles"] == []


def test_a_run_whose_coordinator_has_no_role_at_all_still_triages(tmp_path) -> None:
    # The seat that answered `general` was still a ROLE, so `ensure_role_in_roster`
    # always had something to validate. A specialist roster with no architect has a
    # coordinator with no role at all: passing that to `require_configured_role`
    # would raise on the very run this path exists to serve.
    fixture = roleless_run(
        tmp_path,
        "roleless-triage",
        [task("T1", "Build it", "developer")],
        roles=("developer", "tester"),
    )
    block_task(fixture, "T1", agent_id="developer-1")

    triaged = fixture.cli.run("triage", "needs-input", "--id", COORDINATOR)

    assert [entry["id"] for entry in triaged["tasks"]] == ["T1"]
    assert "You are the Sprint Engine coordinator" in triaged["prompt"]
    # No architect was conjured onto the roster to hold the seat.
    assert read_state(fixture.state_path)["configuredRoles"] == ["developer", "tester"]
    assert "architect" not in worker_roles(fixture)

    joined = fixture.cli.run("join", "--role", "developer", "--id", COORDINATOR)
    assert joined["action"] == "needs_input_triage"
    # A worker that is not the coordinator is not handed the triage directive.
    assert fixture.cli.run("join", "--role", "developer", "--id", "developer-2")["action"] != "needs_input_triage"


def test_an_architect_run_still_triages_exactly_as_before(tmp_path) -> None:
    # The planner is the architect whenever one is rostered — unchanged path.
    fixture = create_team(tmp_path, "architect-triage", [task("T1", "Build it", "developer")])
    state = read_state(fixture.state_path)
    state["configuredRoles"] = ["architect", "developer"]
    state["agents"] = {
        "architect": {"role": "architect", "status": "idle", "currentTaskId": None},
        "developer-1": {"role": "developer", "status": "idle", "currentTaskId": None},
    }
    write_state(fixture.state_path, state)
    fixture.cli.run(
        "task", "status", "--task-id", "T1", "--id", "developer-1", "--status", "needs_input",
        "--needs-input-kind", "architect", "--needs-input-question", "Scope conflict.",
    )

    triaged = fixture.cli.run("triage", "needs-input", "--id", "architect")

    assert [entry["id"] for entry in triaged["tasks"]] == ["T1"]
    assert "You are the Sprint Engine architect" in triaged["prompt"]

    # The join directive is now asked of the AGENT, not its declared role, so the
    # named seat must still answer for every id the spawner mints into it.
    for agent_id in ("architect", "architect-2"):
        joined = fixture.cli.run("join", "--role", "architect", "--id", agent_id)
        assert joined["action"] == "needs_input_triage", agent_id
    assert fixture.cli.run("join", "--role", "developer", "--id", "developer-2")["action"] != "needs_input_triage"


def test_planner_kind_alias_stores_the_canonical_kind(tmp_path) -> None:
    # `planner` is the vocabulary a run with no architect reaches for. It is accepted and
    # folded to the canonical wire kind, so it routes like any planner-routed block
    # and the renderer (which reads `architect`) keeps working.
    fixture = roleless_run(tmp_path, "planner-alias", [task("T1", "Build it")])

    block_task(fixture, "T1", kind="planner")

    blocked = read_state(fixture.state_path)["tasks"][0]
    assert blocked["needsInput"]["kind"] == "architect"
    assert fixture.cli.run("join", "--id", COORDINATOR)["action"] == "needs_input_triage"


def test_a_roleless_coordinators_note_is_typed_as_planner_feedback(tmp_path) -> None:
    # A run planning itself with no architect wrote `user_note`, so its direction to
    # a worker read as if a human had typed it.
    fixture = roleless_run(tmp_path, "roleless-note", [task("T1", "Build it")])

    fixture.cli.run("task", "note", "--task-id", "T1", "--id", COORDINATOR, "--note", "Use the existing helper.")

    comments = read_state(fixture.state_path)["tasks"][0]["comments"]
    assert [comment["type"] for comment in comments] == ["architect_feedback"]


def test_a_non_planner_note_stays_a_user_note(tmp_path) -> None:
    # Only the PLANNER's direction is planner feedback. On an architect run the
    # architect is the planner, so any other agent is an ordinary worker — its note
    # must not be promoted, or every worker aside would read as planner direction.
    fixture = create_team(tmp_path, "worker-note", [task("T1", "Build it", "developer")])
    state = read_state(fixture.state_path)
    state["configuredRoles"] = ["architect", "developer"]
    state["agents"] = {
        "architect": {"role": "architect", "status": "idle", "currentTaskId": None},
        "developer-1": {"role": "developer", "status": "idle", "currentTaskId": None},
    }
    write_state(fixture.state_path, state)

    fixture.cli.run("task", "note", "--task-id", "T1", "--id", "developer-1", "--note", "Worker aside.")
    fixture.cli.run("task", "note", "--task-id", "T1", "--id", "architect", "--note", "Planner direction.")

    comments = read_state(fixture.state_path)["tasks"][0]["comments"]
    assert [comment["type"] for comment in comments] == ["user_note", "architect_feedback"]


def test_an_artifact_review_block_routes_to_the_roleless_coordinator(tmp_path) -> None:
    # `mark_task_needs_input_for_artifact` wrote the planner-routed kind but the
    # ROUTING resolved it to a literal architect, so on a run with no architect a readied
    # artifact parked its task against an agent that cannot exist. The block must
    # reach the coordinator — the only agent able to adjudicate it.
    fixture = roleless_run(tmp_path, "roleless-artifact-block", [task("T1", "Draft the notes")])
    (fixture.team_dir / "notes.md").write_text("# Design notes\n", encoding="utf-8")

    fixture.cli.run(
        "artifact", "add",
        "--task-id", "T1", "--kind", "design_notes", "--title", "Design Notes",
        "--path", "notes.md", "--created-by", COORDINATOR, "--actor", COORDINATOR,
    )
    fixture.cli.run("artifact", "ready", "--artifact-id", "A1", "--id", COORDINATOR)

    blocked = read_state(fixture.state_path)["tasks"][0]
    assert blocked["status"] == "needs_input"
    assert blocked["needsInput"]["reason"] == "artifact_review"

    # It lands in the lane the coordinator is routed to, and triage reaches it.
    triaged = fixture.cli.run("triage", "needs-input", "--id", COORDINATOR)
    assert [entry["id"] for entry in triaged["tasks"]] == ["T1"]
    # No architect worker was conjured to adjudicate it — only the coordinator can.
    assert "architect" not in worker_roles(fixture)
    assert read_state(fixture.state_path)["configuredRoles"] == []


def test_help_offers_triage_to_everyone_that_may_call_it(tmp_path) -> None:
    # Help filtered its triage line on `role == "architect"`, so a roleless agent —
    # which IS authorized for the tool and is the only agent able to clear its run's
    # blockers — was never told the tool exists. The line now follows the capability
    # table, so visibility and authorization cannot drift apart.
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    def tools_help(role: str) -> str:
        response = server.call_tool(
            "sprintengine.help",
            {"role": role, "agentId": f"{role}-1", "topic": "tools"},
            {"id": f"{role}-1", "role": role, "mcpAuthorized": True},
        )
        assert response["ok"] is True, response.get("error")
        return response["result"]["markdown"]

    assert "sprintengine.triage.needs_input" in tools_help("architect")
    # A worker role is not authorized for triage and must not be pointed at it.
    assert "sprintengine.triage.needs_input" not in tools_help("developer")

    # A ROLELESS agent session (agent id bound, no role) gets the planning surface.
    roleless_actor = {"id": "operator", "role": "user", "mcpAuthorized": True}
    context = McpRequestContext(
        actor=ActorContext.from_value(roleless_actor),
        state_path=tmp_path / "run.yaml",
        workspace_root=tmp_path,
        allowed_roots=(tmp_path,),
        agent_id="agent-1",
    )
    response = server.call_tool(
        "sprintengine.help",
        {"agentId": "agent-1", "topic": "tools"},
        roleless_actor,
        context=context,
    )
    assert response["ok"] is True, response.get("error")
    markdown = response["result"]["markdown"]
    assert "sprintengine.triage.needs_input" in markdown
    # It is told how to claim without a role, not handed a placeholder one.
    assert '{id: "agent-1"}' in markdown
    assert "role" not in response["result"]


def test_a_roleless_init_opens_no_unclaimable_product_gate(tmp_path) -> None:
    # The product-intake gate keyed off SEATED agents, but init runs before any agent
    # is seated — so a run of plain agents opened a `product` task that no agent could
    # ever claim (the role is off-roster) while the plan gate dependsOn it. Dead on
    # arrival. The run's enabled roles decide it now.
    state_path = tmp_path / ".multi-code" / "sprintengine" / "roleless-init" / "run.yaml"
    cli = SwarmCli(state_path)

    payload = cli.run(
        "init",
        "--name", "roleless-init",
        "--goal", "Ship it with plain agents",
        "--configured-roles-json", json.dumps([]),
    )

    assert payload["productTask"] is None
    # The plan gate carries NO role at all now — no stand-in to satisfy the schema.
    assert "role" not in payload["planTask"]
    assert payload["planTask"]["dependsOn"] == []
    assert [t.get("role") for t in read_state(state_path)["tasks"]] == [None]


def test_a_product_staffed_run_still_opens_its_intake_gate(tmp_path) -> None:
    # The other side of that guard: an enabled `product` role still gets its gate,
    # even though no product agent is seated at init.
    state_path = tmp_path / ".multi-code" / "sprintengine" / "product-staffed-init" / "run.yaml"
    cli = SwarmCli(state_path)

    payload = cli.run(
        "init",
        "--name", "product-staffed-init",
        "--goal", "Ship it with specialists",
        "--configured-roles-json", json.dumps(["product", "architect", "developer"]),
    )

    assert payload["productTask"] is not None
    assert payload["productTask"]["role"] == "product"
    assert payload["planTask"]["dependsOn"] == [payload["productTask"]["id"]]
