"""A run with no architect must still route: triage, escalation, plan review, comments.

MC-1585: the default product is a pool of plain Generals, so `general` plans its own
run (`resolve_planning_role`). Every path that asked "is this role literally
`architect`?" silently dead-ended such a run — the blocked task queued forever with
nobody allowed to triage it. These pin the planner-routed behavior end to end through
the real CLI, not through hand-built state.
"""

from __future__ import annotations

import json

from helpers import SwarmCli, create_team, read_state, task, write_state
from sprintengine_mcp import SprintEngineMcpServer


def general_run(tmp_path, name: str, tasks=None):
    """A real general-only run: configuredRoles == ['general'], one seated general."""
    fixture = create_team(tmp_path, name, tasks or [])
    state = read_state(fixture.state_path)
    state["configuredRoles"] = ["general"]
    state.setdefault("sprintengine", {})["rosterConfigured"] = True
    state["agents"] = {"general": {"role": "general", "status": "idle", "currentTaskId": None}}
    write_state(fixture.state_path, state)
    return fixture


def block_task(fixture, task_id: str, kind: str = "architect") -> dict:
    return fixture.cli.run(
        "task", "status",
        "--task-id", task_id,
        "--id", "general",
        "--status", "needs_input",
        "--needs-input-kind", kind,
        "--needs-input-question", "The acceptance criteria contradict the owned paths.",
    )


def test_general_receives_the_triage_directive_on_join(tmp_path) -> None:
    # run.py gated the triage directive on `args.role == "architect"`, so a general
    # joining a run with queued planner-actionable work was told there was nothing to
    # triage — the blocked task queued forever.
    fixture = general_run(tmp_path, "general-triage-join", [task("T1", "Build it", "general")])
    block_task(fixture, "T1")

    joined = fixture.cli.run("join", "--role", "general", "--id", "general")

    assert joined["action"] == "needs_input_triage"
    assert "triage needs-input" in joined["prompt"]


def test_general_can_triage_without_an_architect_seat(tmp_path) -> None:
    # cmd_triage_needs_input hardcoded ensure_agent_in_roster(state, id, "architect"),
    # which forced an off-roster architect seat that add_roster_agent then rejected.
    fixture = general_run(tmp_path, "general-triage-run", [task("T1", "Build it", "general")])
    block_task(fixture, "T1")

    triaged = fixture.cli.run("triage", "needs-input", "--id", "general")

    assert [entry["id"] for entry in triaged["tasks"]] == ["T1"]
    assert "You are the Sprint Engine general" in triaged["prompt"]
    # The triage prompt must hand the agent its OWN id, not the literal `architect`.
    assert "--id general" in triaged["prompt"]
    assert "--id architect " not in triaged["prompt"]
    # No architect seat was conjured into a general-only roster.
    assert set(read_state(fixture.state_path)["agents"]) == {"general"}


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


def test_planner_kind_alias_stores_the_canonical_kind(tmp_path) -> None:
    # `planner` is the vocabulary a general-only run reaches for. It is accepted and
    # folded to the canonical wire kind, so it routes like any planner-routed block
    # and the renderer (which reads `architect`) keeps working.
    fixture = general_run(tmp_path, "planner-alias", [task("T1", "Build it", "general")])

    block_task(fixture, "T1", kind="planner")

    blocked = read_state(fixture.state_path)["tasks"][0]
    assert blocked["needsInput"]["kind"] == "architect"
    assert fixture.cli.run("join", "--role", "general", "--id", "general")["action"] == "needs_input_triage"


def test_a_generals_note_is_typed_as_planner_feedback(tmp_path) -> None:
    # A general planning its own run wrote `user_note`, so its direction to a worker
    # read as if a human had typed it.
    fixture = general_run(tmp_path, "general-note", [task("T1", "Build it", "general")])

    fixture.cli.run("task", "note", "--task-id", "T1", "--id", "general", "--note", "Use the existing helper.")

    comments = read_state(fixture.state_path)["tasks"][0]["comments"]
    assert [comment["type"] for comment in comments] == ["architect_feedback"]


def test_a_non_planner_note_stays_a_user_note(tmp_path) -> None:
    # Only the PLANNER's direction is planner feedback. On an architect run the
    # architect is the planner, so a general there is an ordinary worker — its note
    # must not be promoted, or every worker aside would read as planner direction.
    fixture = create_team(tmp_path, "worker-note", [task("T1", "Build it", "general")])
    state = read_state(fixture.state_path)
    state["configuredRoles"] = ["architect", "general"]
    state["agents"] = {
        "architect": {"role": "architect", "status": "idle", "currentTaskId": None},
        "general-1": {"role": "general", "status": "idle", "currentTaskId": None},
    }
    write_state(fixture.state_path, state)

    fixture.cli.run("task", "note", "--task-id", "T1", "--id", "general-1", "--note", "Worker aside.")
    fixture.cli.run("task", "note", "--task-id", "T1", "--id", "architect", "--note", "Planner direction.")

    comments = read_state(fixture.state_path)["tasks"][0]["comments"]
    assert [comment["type"] for comment in comments] == ["user_note", "architect_feedback"]


def test_an_artifact_review_block_routes_to_the_general_planner(tmp_path) -> None:
    # `mark_task_needs_input_for_artifact` wrote the planner-routed kind but the
    # ROUTING resolved it to a literal architect, so on a general-only run a readied
    # artifact parked its task against an agent that cannot exist. The block must
    # reach the general — the only agent able to adjudicate it.
    fixture = general_run(tmp_path, "general-artifact-block", [task("T1", "Draft the notes", "general")])
    (fixture.team_dir / "notes.md").write_text("# Design notes\n", encoding="utf-8")

    fixture.cli.run(
        "artifact", "add",
        "--task-id", "T1", "--kind", "design_notes", "--title", "Design Notes",
        "--path", "notes.md", "--created-by", "general", "--actor", "general",
    )
    fixture.cli.run("artifact", "ready", "--artifact-id", "A1", "--id", "general")

    blocked = read_state(fixture.state_path)["tasks"][0]
    assert blocked["status"] == "needs_input"
    assert blocked["needsInput"]["reason"] == "artifact_review"

    # It lands in the lane the general is routed to, and triage reaches it.
    triaged = fixture.cli.run("triage", "needs-input", "--id", "general")
    assert [entry["id"] for entry in triaged["tasks"]] == ["T1"]
    assert set(read_state(fixture.state_path)["agents"]) == {"general"}


def test_a_general_cannot_review_its_own_plan(tmp_path) -> None:
    # The self-review guard follows the run's planning role: a general that planned
    # the run may not sign off on that plan just by not being literally an architect.
    fixture = general_run(tmp_path, "general-self-review")

    failure = fixture.cli.run_failure("plan", "start-review", "--role", "general", "--id", "general")

    assert failure.returncode != 0
    assert "does not review its own Sprint Engine plan" in failure.stderr


def test_a_non_planner_role_may_still_review_the_plan(tmp_path) -> None:
    # The guard bars the AUTHOR, not everyone: on a run the general planned, a
    # rostered specialist can still review that plan. Otherwise the guard would have
    # closed plan review entirely instead of moving it off the architect's name.
    fixture = create_team(tmp_path, "general-plan-reviewed", [])
    state = read_state(fixture.state_path)
    state["configuredRoles"] = ["general", "developer"]
    state.setdefault("sprintengine", {})["rosterConfigured"] = True
    state["agents"] = {
        "general": {"role": "general", "status": "idle", "currentTaskId": None},
        "developer-1": {"role": "developer", "status": "idle", "currentTaskId": None},
    }
    write_state(fixture.state_path, state)
    (fixture.team_dir / "plan.md").write_text("# General Plan\n", encoding="utf-8")

    reviewed = fixture.cli.run("plan", "start-review", "--role", "developer", "--id", "developer-1")

    assert reviewed["ok"] is True
    assert reviewed["role"] == "developer"


def test_help_offers_triage_to_every_role_that_may_call_it(tmp_path) -> None:
    # Help filtered its triage line on `role == "architect"`, so the general — which
    # IS authorized for the tool and is the only agent able to clear its run's
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
    assert "sprintengine.triage.needs_input" in tools_help("general")
    # A worker role is not authorized for triage and must not be pointed at it.
    assert "sprintengine.triage.needs_input" not in tools_help("developer")


def test_a_general_only_init_opens_no_unclaimable_product_gate(tmp_path) -> None:
    # The product-intake gate keyed off SEATED agents, but init runs before any agent
    # is seated — so a general-only run opened a `product` task that no agent could
    # ever claim (the role is off-roster) while the plan gate dependsOn it. Dead on
    # arrival. The run's enabled roles decide it now.
    state_path = tmp_path / ".multi-code" / "sprintengine" / "general-only-init" / "run.yaml"
    cli = SwarmCli(state_path)

    payload = cli.run(
        "init",
        "--name", "general-only-init",
        "--goal", "Ship it with plain agents",
        "--configured-roles-json", json.dumps(["general"]),
    )

    assert payload["productTask"] is None
    assert payload["planTask"]["role"] == "general"
    assert payload["planTask"]["dependsOn"] == []
    assert [t["role"] for t in read_state(state_path)["tasks"]] == ["general"]


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
