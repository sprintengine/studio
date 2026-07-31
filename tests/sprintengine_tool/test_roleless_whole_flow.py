"""Whole-flow validation for roleless sprints (MC-2056, epic `roleless-sprints`).

The per-item suites each prove one seam. These prove the seams compose, and
prove the two things this epic is most likely to break quietly: **role-based
runs**, and **runs that already exist on disk**.

Why the assertions read `dispatch.jsonl` rather than the projection: the original
serialisation bug was diagnosed from that ledger, and the projection is derived —
it can agree with itself while the ledger tells the truth. `store.append_dispatch_records`
is append-only, so the file is the run's dispatch history rather than its current
opinion of it.

Where the seam between the two halves of dispatch falls:

- **Who to wake** is decided in the renderer/main planner (`auto-run.ts`). Its
  roleless fan-out, its unchanged architect routing, and its wake/revival
  task-scoping are proven by `src/shared/sprintengine/auto-run.test.ts`
  (`npm run test:shared:sprintengine-auto-run-planner`).
- **What the run records when those agents arrive** is the engine, and that is
  what these tests own: the claims the planner's decision produces, the ledger
  they write, and whether the graph really ran concurrently.

Both halves are needed. A planner that fans out onto an engine that serialises,
or an engine that would allow concurrency but a planner that never asks for it,
each reproduce the observed bug.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest

from helpers import REPO_ROOT, create_team, get_task, read_state, task, write_state
from sprintengine_core import store as folder_store
from sprintengine_core.tool.plans import (
    ensure_plan_approval_gate,
    find_architect_plan_gate,
    task_is_coordination,
)
from sprintengine_core.tool.state import mint_lease
from sprintengine_mcp import SprintEngineMcpServer


# --- harness ------------------------------------------------------------------


def actor(agent_id: str, actor_role: str = "") -> dict[str, Any]:
    return {"id": agent_id, "role": actor_role, "mcpAuthorized": True}


def call(server: SprintEngineMcpServer, state_path: Path, name: str, agent_id: str, actor_role: str = "", **args):
    """One MCP tool call. `actor_role` types the CALLER; a `role=` keyword rides
    the payload, and the two are deliberately separate — the mistyped-role tests
    depend on the payload role reaching the engine unaltered."""
    return server.call_tool(name, {"statePath": str(state_path), **args}, actor(agent_id, actor_role))


def ok(response: dict[str, Any]) -> dict[str, Any]:
    """The transport succeeded AND the command inside it did.

    `ok` is answered at two levels: the MCP envelope reports whether the call was
    dispatched, and a refusal the command chose (not ready, capacity, module held)
    rides back as `result.ok: False` inside a successful envelope. Asserting only
    the envelope reads every such refusal as a pass.
    """
    assert response["ok"] is True, response.get("error")
    result = response["result"]
    assert result.get("ok", True) is True, result
    return result


def ledger(fixture) -> list[dict[str, Any]]:
    """The run's dispatch ledger, in the order the engine appended it."""
    return folder_store.read_jsonl_file(fixture.team_dir / folder_store.DISPATCH_FILE)


def claim_records(fixture) -> list[dict[str, Any]]:
    return [record for record in ledger(fixture) if record.get("reason") == "task_claimed"]


def dispatch_sequence(fixture) -> list[tuple[str, str | None, str, str]]:
    """`(agentId, role, taskId, reason)` per ledger record — the comparable shape.

    `role` is `None` for a roleless dispatch, which is how the record spells it:
    an omitted key, never `''` (MC-2057).
    """
    return [
        (
            str(record.get("agentId") or ""),
            record.get("role"),
            str((record.get("target") or {}).get("taskId") or ""),
            str(record.get("reason") or ""),
        )
        for record in ledger(fixture)
    ]


def in_progress_owners(fixture) -> dict[str, str]:
    """Every task holding an active in_progress lease, mapped to its worker.

    Concurrency is what this measures: leases are exclusive, so N tasks holding
    N distinct leases at one instant is N workers running at once. A serialised
    run can never show more than one.
    """
    state = read_state(fixture.state_path)
    return {
        str(entry["id"]): str((entry.get("lease") or {}).get("workerId") or "")
        for entry in state["tasks"]
        if entry.get("status") == "in_progress" and (entry.get("lease") or {}).get("workerId")
    }


def seed_roleless_run(tmp_path: Path, name: str, work: list[dict[str, Any]]):
    """A roleless run: no roles enabled, a plan gate the coordinator must claim,
    and `work` rooted on that gate. Returns `(fixture, gateTaskId, planArtifactId)`."""
    fixture = create_team(tmp_path, name, [])
    state = read_state(fixture.state_path)
    state.setdefault("sprintengine", {})["rosterConfigured"] = True
    state["configuredRoles"] = []
    # `start_active=False` leaves the gate as ready, unowned work: the coordinator
    # reaches it by claiming, which is what puts the coordination dispatch in the
    # ledger. A pre-assigned gate is seeded straight into a lease and records none.
    ensure_plan_approval_gate(state, fixture.state_path, "coordinator", start_active=False)
    write_state(fixture.state_path, state)

    seeded = read_state(fixture.state_path)
    gate = find_architect_plan_gate(seeded, fixture.state_path)
    gate_task_id = str(gate["task"]["id"])
    assert "role" not in gate["task"], "a roleless run's coordination task carries no role"
    for entry in work:
        entry["dependsOn"] = [gate_task_id, *entry.get("dependsOn", [])]
        seeded["tasks"].append(entry)
    write_state(fixture.state_path, seeded)
    (fixture.team_dir / "plan.md").write_text("# Plan\n", encoding="utf-8")
    return fixture, gate_task_id, str(gate["artifact"]["id"])


def approve_plan(server, fixture, artifact_id: str, agent_id: str = "coordinator") -> None:
    state = read_state(fixture.state_path)
    for artifact in state["artifacts"]:
        if artifact["id"] == artifact_id:
            artifact["status"] = "ready_for_review"
    write_state(fixture.state_path, state)
    ok(call(server, fixture.state_path, "sprintengine.artifact.approve", agent_id,
            artifactId=artifact_id, id=agent_id))


# --- AC1: a roleless sprint runs in parallel -----------------------------------


def test_a_roleless_run_dispatches_one_worker_per_ready_task_concurrently(tmp_path: Path) -> None:
    """The epic's headline claim, read off the ledger.

    The observed defect (`first-run-without-a-wizard`): four independent tasks,
    five dispatches, every one to a single bare `general` id, strictly sequential.

    Owned modules are DISJOINT on purpose. `active_module_conflict` legitimately
    serialises tasks with overlapping `ownedPaths` — the commit sweep would
    otherwise fold two half-finished tasks into one commit — so a graph that
    shares a module proves nothing about this fix.
    """
    fixture, gate_task_id, plan_artifact_id = seed_roleless_run(
        tmp_path,
        "roleless-fanout",
        [
            task("T1", "Build A", owned_paths=["src/a"]),
            task("T2", "Build B", owned_paths=["src/b"]),
            task("T3", "Build C", owned_paths=["src/c"]),
        ],
    )
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    # The coordination task: claimed by the seat, adjudicated, done.
    claimed_gate = ok(call(server, fixture.state_path, "sprintengine.task.claim", "coordinator",
                           taskId=gate_task_id, id="coordinator"))
    assert claimed_gate["task"]["id"] == gate_task_id
    approve_plan(server, fixture, plan_artifact_id)
    assert get_task(read_state(fixture.state_path), gate_task_id)["status"] == "done"

    # Three minted workers take the three ready tasks. Each claim is a separate
    # agent arriving, exactly as the planner dispatched them.
    for agent_id, task_id in (("agent-1", "T1"), ("agent-2", "T2"), ("agent-3", "T3")):
        claimed = ok(call(server, fixture.state_path, "sprintengine.task.next", agent_id, id=agent_id))
        assert claimed["claimed"] is True, f"{agent_id} found no work"
        assert claimed["task"]["id"] == task_id, f"{agent_id} claimed {claimed['task']['id']}"

    # Concurrency, not just distinctness: all three leases are held at once.
    assert in_progress_owners(fixture) == {"T1": "agent-1", "T2": "agent-2", "T3": "agent-3"}

    work_records = [
        record for record in claim_records(fixture)
        if (record.get("target") or {}).get("taskId") != gate_task_id
    ]
    assert [str((record.get("target") or {}).get("taskId")) for record in work_records] == ["T1", "T2", "T3"]
    assert len({str(record["agentId"]) for record in work_records}) == 3, (
        f"one distinct worker per task, not one id repeated; ledger={work_records}"
    )
    assert all(record["agentId"] != "coordinator" for record in work_records), (
        "work never queues behind the coordinator seat"
    )
    assert all("role" not in record for record in ledger(fixture)), (
        "a roleless dispatch omits `role` entirely rather than recording a stand-in"
    )


def test_tasks_sharing_a_module_still_serialise(tmp_path: Path) -> None:
    """The negative control for the test above, and the reason its modules are disjoint.

    Overlapping `ownedPaths` serialise on purpose: a task's commit stages
    everything dirty inside its modules, so two tasks sharing one would sweep each
    other's half-finished work into a single commit. Without this, the fan-out
    assertion could pass on a run that never had a choice — and a future change
    that removed module exclusion would look like an improvement.
    """
    fixture, gate_task_id, plan_artifact_id = seed_roleless_run(
        tmp_path,
        "roleless-shared-module",
        [task("T1", "Build A", owned_paths=["src/shared"]), task("T2", "Build B", owned_paths=["src/shared"])],
    )
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])
    ok(call(server, fixture.state_path, "sprintengine.task.claim", "coordinator",
            taskId=gate_task_id, id="coordinator"))
    approve_plan(server, fixture, plan_artifact_id)

    ok(call(server, fixture.state_path, "sprintengine.task.next", "agent-1", id="agent-1"))
    blocked = ok(call(server, fixture.state_path, "sprintengine.task.next", "agent-2", id="agent-2"))

    assert blocked["claimed"] is False, "a task sharing a live module is not handed out"
    assert list(in_progress_owners(fixture)) == ["T1"], "one at a time, by design"


def test_the_projection_carries_what_the_dispatch_planner_routes_on(tmp_path: Path) -> None:
    """The contract between the two halves of dispatch.

    The planner never calls Python: it reads `projection.json`. Its routing rule
    is composed entirely from four things this file has to carry — the run's
    `configuredRoles` (which answers the seat question), the plan artifact's
    `taskId` binding (which marks the coordination task), each task's absent role,
    and each task's `ownedPaths`. Drop any one and the planner still runs, silently
    routing everything the wrong way, which is exactly the failure this epic fixed.
    """
    fixture, gate_task_id, _plan_artifact_id = seed_roleless_run(
        tmp_path,
        "roleless-projection-contract",
        [task("T1", "Build A", owned_paths=["src/a"]), task("T2", "Build B", owned_paths=["src/b"])],
    )
    projection = folder_store.build_projection(fixture.team_dir, state_path=fixture.state_path)

    assert projection["run"]["configuredRoles"] == [], "the seat question is answered by an explicit empty set"
    plan_artifacts = [
        artifact for artifact in projection["artifacts"]
        if artifact.get("kind") == "architect_plan" and artifact.get("status") != "superseded"
    ]
    assert [artifact["taskId"] for artifact in plan_artifacts] == [gate_task_id], (
        "the coordination task is marked only by the plan artifact's binding"
    )
    work = {entry["id"]: entry for entry in projection["tasks"] if entry["id"] != gate_task_id}
    assert all("role" not in entry for entry in projection["tasks"])
    assert [work["T1"]["ownedPaths"], work["T2"]["ownedPaths"]] == [["src/a"], ["src/b"]]


def test_the_coordination_work_of_a_roleless_run_carries_one_id(tmp_path: Path) -> None:
    """Sequential coordination dispatches share ONE identity (MC-1454), while the
    work beside them does not — the two halves of the routing rule, in the ledger.

    Persistence is proven by re-dispatch: the seat departs mid-job and comes back
    to it. The proof is the identity that returns, not a second ledger row — a
    dispatch id is a content hash over `(agentId, role, target, reason)` with no
    timestamp, so a re-claim of the same task by the same agent is deduped away
    forever (pinned by `test_the_ledger_dedups_a_repeat_claim_but_never_two_workers`).
    """
    fixture, gate_task_id, plan_artifact_id = seed_roleless_run(
        tmp_path, "roleless-coordination", [task("T1", "Build A", owned_paths=["src/a"])]
    )
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    ok(call(server, fixture.state_path, "sprintengine.task.claim", "coordinator",
            taskId=gate_task_id, id="coordinator"))
    # The seat departs mid-job and the run re-dispatches it: MC-1454's persistent
    # identity says the SAME id comes back, not a freshly minted worker.
    ok(call(server, fixture.state_path, "sprintengine.task.release", "coordinator",
            taskId=gate_task_id, id="coordinator", reason="Coordinator session ended."))
    assert get_task(read_state(fixture.state_path), gate_task_id)["ownerAgentId"] is None
    ok(call(server, fixture.state_path, "sprintengine.task.claim", "coordinator",
            taskId=gate_task_id, id="coordinator"))
    reclaimed = get_task(read_state(fixture.state_path), gate_task_id)
    assert reclaimed["ownerAgentId"] == "coordinator", "the seat comes back under its own id"
    assert reclaimed["lease"]["workerId"] == "coordinator" and "role" not in reclaimed["lease"]
    approve_plan(server, fixture, plan_artifact_id)

    ok(call(server, fixture.state_path, "sprintengine.task.next", "agent-1", id="agent-1"))

    state = read_state(fixture.state_path)
    coordination_ids = {
        str(record["agentId"]) for record in claim_records(fixture)
        if task_is_coordination(state, fixture.state_path, str((record.get("target") or {}).get("taskId") or ""))
    }
    work_ids = {
        str(record["agentId"]) for record in claim_records(fixture)
        if not task_is_coordination(state, fixture.state_path, str((record.get("target") or {}).get("taskId") or ""))
    }
    assert coordination_ids == {"coordinator"}, f"coordination is one persistent id; ledger={ledger(fixture)}"
    assert work_ids and "coordinator" not in work_ids, "ordinary work is task-scoped, never the seat"


# --- AC2: a role-based sprint is unchanged -------------------------------------


def test_a_role_based_run_dispatches_exactly_as_before(tmp_path: Path) -> None:
    """The quiet regression this epic risks.

    The shape reproduced here is the one real runs carry (`multi-repo-sprints`
    T5/T11/T14): an architect that owns work which is NOT the plan gate. The
    named-role clause of the routing rule is what keeps that work on the one warm
    architect; without it, an architect sign-off task would mint `architect-2`.

    The expected ledger is written out in full rather than spot-checked: the run's
    whole dispatch history is compared, so a change to what the engine records —
    an extra release, a lost role, a re-minted architect — fails here. Which agent
    the planner chooses to send is the other half of the seam, pinned by
    `testArchitectRunDispatchIsUnchanged` in `auto-run.test.ts`.

    The expected sequence below is not a guess at what "unchanged" means: this
    scenario was driven against the pre-epic tree (631ccff7, run store v4) and
    against this branch, and both produced this ledger and this final ownership
    byte for byte.
    """
    fixture = create_team(tmp_path, "role-based-dispatch", [])
    state = read_state(fixture.state_path)
    state.setdefault("sprintengine", {})["rosterConfigured"] = True
    state["configuredRoles"] = ["architect", "developer", "tester"]
    ensure_plan_approval_gate(state, fixture.state_path, "architect", start_active=False)
    write_state(fixture.state_path, state)

    seeded = read_state(fixture.state_path)
    gate = find_architect_plan_gate(seeded, fixture.state_path)
    gate_task_id = str(gate["task"]["id"])
    assert gate["task"]["role"] == "architect", "a named seat still names its gate"
    for entry in (
        task("T-dev", "Build it", "developer", depends_on=[gate_task_id], owned_paths=["src/app"]),
        task("T-test", "Verify it", "tester", depends_on=[gate_task_id], owned_paths=["tests"]),
        task("T-signoff", "Sign the sprint off", "architect", depends_on=[gate_task_id], owned_paths=["docs"]),
    ):
        seeded["tasks"].append(entry)
    write_state(fixture.state_path, seeded)
    (fixture.team_dir / "plan.md").write_text("# Plan\n", encoding="utf-8")

    server = SprintEngineMcpServer(allowed_roots=[tmp_path])
    ok(call(server, fixture.state_path, "sprintengine.task.claim", "architect", "architect",
            taskId=gate_task_id, id="architect"))
    approve_plan(server, fixture, str(gate["artifact"]["id"]), agent_id="architect")

    for agent_id, role, task_id in (
        ("developer-1", "developer", "T-dev"),
        ("tester-1", "tester", "T-test"),
        # The architect's own non-gate task: the SAME warm session, not `architect-2`.
        ("architect", "architect", "T-signoff"),
    ):
        claimed = ok(call(server, fixture.state_path, "sprintengine.task.next", agent_id,
                          actor_role=role, role=role, id=agent_id))
        assert claimed["claimed"] is True and claimed["task"]["id"] == task_id

    assert dispatch_sequence(fixture) == [
        ("architect", "architect", gate_task_id, "task_claimed"),
        ("developer-1", "developer", "T-dev", "task_claimed"),
        ("tester-1", "tester", "T-test", "task_claimed"),
        ("architect", "architect", "T-signoff", "task_claimed"),
    ]
    assert len({record[0] for record in dispatch_sequence(fixture)}) == 3, (
        "the architect's two dispatches are one warm session, never two seats"
    )
    # Specialists still run beside each other: role-based concurrency is untouched.
    assert set(in_progress_owners(fixture)) == {"T-dev", "T-test", "T-signoff"}


# --- AC3: an in-flight run migrates --------------------------------------------


def seed_v4_general_store(tmp_path: Path, name: str):
    """A stored `configuredRoles: ['general']` run mid-flight, as one exists on disk:
    a finished coordination task with evidence, an owned in-flight task with a
    live lease, and a third task still waiting on its dependency."""
    fixture = create_team(
        tmp_path,
        name,
        [
            task("T0", "Review general plan artifact", "general", status="done", owner="general"),
            task("T1", "Build A", "general", status="in_progress", owner="general-2",
                 depends_on=["T0"], owned_paths=["src/a"]),
            task("T2", "Build B", "general", depends_on=["T0"], owned_paths=["src/b"]),
        ],
    )
    state = read_state(fixture.state_path)
    state["configuredRoles"] = ["general"]
    done = state["tasks"][0]
    done["evidence"] = {
        "summary": "Planned the graph.",
        "touchedFiles": [".multi-code/sprintengine/plan.md"],
        "commandsRan": ["sprintengine plan list"],
        "results": ["3 tasks"],
        "scopeExpansions": [],
    }
    done["completedAt"] = "2026-07-30T00:00:00Z"
    # The bare id: `general` was the seat, `general-N` its workers. Both spellings
    # of the fake role have to move, and they move to different ids.
    done["lastImplementedByAgentId"] = "general"
    in_flight = state["tasks"][1]
    in_flight["lastImplementedByAgentId"] = "general-2"
    in_flight["evidence"] = {
        "summary": "Half built.",
        "touchedFiles": ["src/a/thing.py"],
        "commandsRan": ["pytest tests/a"],
        "results": ["green"],
        "scopeExpansions": [],
    }
    seeded_lease = dict(mint_lease(in_flight, "general-2", "general"))
    write_state(fixture.state_path, state)

    run_path = fixture.team_dir / folder_store.RUN_FILE
    run = folder_store.load_run_yaml(fixture.team_dir)
    run["schemaVersion"] = 4
    folder_store.atomic_write_yaml(run_path, run)
    return fixture, seeded_lease


def test_a_stored_general_run_keeps_its_evidence_and_lease_through_migration(tmp_path: Path) -> None:
    """Migration renames the fake role out of the run. Everything the run has
    already earned — graph, dependencies, ownership, evidence, lease state — has
    to survive it, or an in-flight sprint loses work no one can recover."""
    fixture, before_lease = seed_v4_general_store(tmp_path, "v4-in-flight")

    state = read_state(fixture.state_path)

    assert state["configuredRoles"] == []
    assert [entry["id"] for entry in state["tasks"]] == ["T0", "T1", "T2"]
    assert all("role" not in entry for entry in state["tasks"])

    done = get_task(state, "T0")
    assert done["status"] == "done"
    assert done["evidence"]["summary"] == "Planned the graph."
    assert done["evidence"]["commandsRan"] == ["sprintengine plan list"]
    assert done["completedAt"] == "2026-07-30T00:00:00Z"
    assert done["ownerAgentId"] == "coordinator" and done["lastImplementedByAgentId"] == "coordinator"

    in_flight = get_task(state, "T1")
    assert in_flight["status"] == "in_progress"
    assert in_flight["dependsOn"] == ["T0"]
    assert in_flight["ownedPaths"] == ["src/a"]
    assert in_flight["evidence"]["touchedFiles"] == ["src/a/thing.py"]
    # The lease survives with only its identity rewritten: nothing is re-minted,
    # so the worker keeps its `since` and the run keeps its elapsed accounting.
    assert in_flight["ownerAgentId"] == "agent-2"
    assert in_flight["lastImplementedByAgentId"] == "agent-2"
    assert in_flight["lease"]["workerId"] == "agent-2"
    assert "role" not in in_flight["lease"]
    assert in_flight["lease"]["since"] == before_lease["since"]
    assert in_flight["lease"]["repo"] == before_lease["repo"]


def test_a_migrated_run_carries_on_as_a_roleless_run(tmp_path: Path) -> None:
    """Reading it forward is half the requirement; it has to keep RUNNING.

    The migrated owner finishes the task it already held, and a second roleless
    worker takes the next one — the fan-out this epic added, on a run created
    before it existed.
    """
    fixture, _lease = seed_v4_general_store(tmp_path, "v4-carries-on")
    read_state(fixture.state_path)  # first read migrates the store on disk
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    joined = ok(call(server, fixture.state_path, "sprintengine.agent.join", "agent-2", agentId="agent-2"))
    assert "role" not in joined and "roleManifest" not in joined, "it reads forward as roleless"

    resumed = ok(call(server, fixture.state_path, "sprintengine.task.next", "agent-2", id="agent-2"))
    assert resumed["task"]["id"] == "T1", "the migrated owner resumes its own task"

    ok(call(server, fixture.state_path, "sprintengine.task.publish", "agent-2",
            taskId="T1", id="agent-2", summary="Finished the half-built work."))
    ok(call(server, fixture.state_path, "sprintengine.task.advance", "agent-2",
            taskId="T1", id="agent-2", phase="review", outcome="pass", summary="Self-reviewed."))
    assert get_task(read_state(fixture.state_path), "T1")["status"] == "done"

    fresh = ok(call(server, fixture.state_path, "sprintengine.task.next", "agent-3", id="agent-3"))
    assert fresh["claimed"] is True and fresh["task"]["id"] == "T2"
    assert "role" not in fresh["task"]
    assert all("role" not in record for record in ledger(fixture)), (
        "the fake role is gone from the ledger the run keeps writing, not only from its history"
    )


# --- AC4: a minted roleless worker stays task-scoped ---------------------------


def test_a_minted_roleless_worker_cannot_take_or_advance_another_agents_task(tmp_path: Path) -> None:
    """The engine half of task-scoping.

    `auto-run.test.ts` proves the planner never wakes or revives a minted roleless
    worker onto work it does not own. This proves the engine would refuse it even
    if something did — the two sites are safe today only because no second roleless
    agent could exist, so neither guard has ever been exercised with one.

    One guard is missing and is NOT asserted here: `task.publish` has no owner
    check, so any agent can publish another's in_progress task and take it over.
    That predates this epic (`publish_task` is unchanged at 631ccff7) and is
    role-agnostic — `developer-1` can publish `tester-1`'s task on a role-based
    run just as easily. It is filed rather than pinned: a test asserting the
    current behaviour would cement it as intended.
    """
    fixture, gate_task_id, plan_artifact_id = seed_roleless_run(
        tmp_path,
        "roleless-task-scope",
        [task("T1", "Build A", owned_paths=["src/a"]), task("T2", "Build B", owned_paths=["src/b"])],
    )
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])
    ok(call(server, fixture.state_path, "sprintengine.task.claim", "coordinator",
            taskId=gate_task_id, id="coordinator"))
    approve_plan(server, fixture, plan_artifact_id)

    ok(call(server, fixture.state_path, "sprintengine.task.next", "agent-1", id="agent-1"))
    ok(call(server, fixture.state_path, "sprintengine.task.next", "agent-2", id="agent-2"))
    assert in_progress_owners(fixture) == {"T1": "agent-1", "T2": "agent-2"}

    # Neither worker can reach into the other's task, in either direction.
    stolen_claim = call(server, fixture.state_path, "sprintengine.task.claim", "agent-1",
                        taskId="T2", id="agent-1")["result"]
    assert stolen_claim["ok"] is False, stolen_claim
    assert stolen_claim["task"]["id"] == "T2" and stolen_claim["task"]["status"] == "in_progress"

    # Nor can it close a phase of the other's task once that task is in one.
    ok(call(server, fixture.state_path, "sprintengine.task.publish", "agent-2",
            taskId="T2", id="agent-2", summary="Built B."))
    advanced = call(server, fixture.state_path, "sprintengine.task.advance", "agent-1",
                    taskId="T2", id="agent-1", phase="review", outcome="pass", summary="Not mine.")
    assert advanced["ok"] is False and "not_task_owner" in advanced["error"]["message"]

    # And a worker already holding a lease is not offered a second task.
    ok(call(server, fixture.state_path, "sprintengine.task.publish", "agent-1",
            taskId="T1", id="agent-1", summary="Built A."))
    resumed = ok(call(server, fixture.state_path, "sprintengine.task.next", "agent-1", id="agent-1"))
    assert resumed["task"]["id"] == "T1", "a used worker resumes its own task, never picks up another"

    assert all(
        str((record.get("target") or {}).get("taskId")) != "T2"
        for record in claim_records(fixture) if record["agentId"] == "agent-1"
    ), f"agent-1 never appears in the ledger against T2; ledger={ledger(fixture)}"


# --- AC5: a mistyped role is still rejected ------------------------------------


def test_a_roleless_run_rejects_a_mistyped_role_at_the_claim_boundary(tmp_path: Path) -> None:
    """Absent is legal; wrong is not.

    `test_optional_task_role.py` pins this at the planning boundary. The claim
    boundary is the one that matters at runtime, and it is where a roleless run
    could have inherited the legacy `configuredRoles: null` permissiveness in
    which every role check no-ops.
    """
    fixture, gate_task_id, plan_artifact_id = seed_roleless_run(
        tmp_path, "roleless-role-boundary", [task("T1", "Build A", owned_paths=["src/a"])]
    )
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])
    ok(call(server, fixture.state_path, "sprintengine.task.claim", "coordinator",
            taskId=gate_task_id, id="coordinator"))
    approve_plan(server, fixture, plan_artifact_id)

    typo = call(server, fixture.state_path, "sprintengine.task.next", "agent-1", role="develper", id="agent-1")
    assert typo["ok"] is False
    assert "unknown role" in typo["error"]["message"].lower()

    off_roster = call(server, fixture.state_path, "sprintengine.task.next", "agent-1",
                      role="developer", id="agent-1")
    assert off_roster["ok"] is False
    assert "not enabled" in off_roster["error"]["message"].lower()

    # Absent is accepted, and it is the same run that just refused the other two.
    claimed = ok(call(server, fixture.state_path, "sprintengine.task.next", "agent-1", id="agent-1"))
    assert claimed["claimed"] is True and claimed["task"]["id"] == "T1"


# --- AC6: the schema bump, in the order it must land ---------------------------


def read_ts_constant(name: str) -> int:
    source = (REPO_ROOT / "src/shared/sprintengine/store-schema.ts").read_text(encoding="utf-8")
    match = re.search(rf"export const {name} = (\d+)", source)
    assert match, f"{name} not found in src/shared/sprintengine/store-schema.ts"
    return int(match.group(1))


def test_the_schema_bump_lands_before_a_run_is_created_and_a_run_created_early_still_opens(
    tmp_path: Path,
) -> None:
    """`land -> restart -> create runs` is a sequencing rule, so it is tested as one:
    each of the three states a run can be in relative to the bump is driven.

    The wedge it exists to prevent: a run created while one half of the app is
    still on the old schema is stamped by that half and rejected by the other.

    1. **Land.** Both halves agree — Python writes what TypeScript reads, and they
       agree on the migration floor too, not only the current version. The floor is
       a separate constant because the renderer judges `projection.json` off disk,
       where a store one read away from being migrated must not be called unopenable.
    2. **Restart.** A run stamped by the pre-bump engine — what a process that has
       not restarted still writes — opens, migrates, and stays workable rather than
       wedging.
    3. **Create.** A run created afterwards is stamped natively and needs no
       migration at all.

    The floor below still holds: v3 is rejected, not migrated.
    """
    # 1. Land.
    assert read_ts_constant("SPRINT_ENGINE_RUN_SCHEMA_VERSION") == folder_store.RUN_SCHEMA_VERSION
    assert (
        read_ts_constant("SPRINT_ENGINE_MIN_READABLE_RUN_SCHEMA_VERSION")
        == folder_store.MIGRATABLE_RUN_SCHEMA_VERSION
    )

    # 2. Restart: a run created before it, then opened after it.
    early = create_team(tmp_path, "created-before-restart", [task("T1", "Build A", owned_paths=["src/a"])])
    state = read_state(early.state_path)
    state["configuredRoles"] = []
    state.setdefault("sprintengine", {})["rosterConfigured"] = True
    write_state(early.state_path, state)
    stamped = folder_store.load_run_yaml(early.team_dir)
    stamped["schemaVersion"] = folder_store.MIGRATABLE_RUN_SCHEMA_VERSION
    folder_store.atomic_write_yaml(early.team_dir / folder_store.RUN_FILE, stamped)

    reopened = read_state(early.state_path)
    assert folder_store.load_run_yaml(early.team_dir)["schemaVersion"] == folder_store.RUN_SCHEMA_VERSION
    assert [entry["id"] for entry in reopened["tasks"]] == ["T1"]
    # Workable, not merely readable: the run it wedged is the run that has to finish.
    claimed = early.cli.run("task", "next", "--id", "agent-1")
    assert claimed["claimed"] is True and claimed["task"]["id"] == "T1"
    early.cli.run("task", "publish", "--task-id", "T1", "--id", "agent-1", "--summary", "Built it.")
    early.cli.run("task", "advance", "--task-id", "T1", "--id", "agent-1",
                  "--phase", "review", "--outcome", "pass", "--summary", "Self-reviewed.")
    assert get_task(read_state(early.state_path), "T1")["status"] == "done"

    # 3. Create: stamped natively, with nothing left to migrate.
    fresh = create_team(tmp_path, "created-after-restart", [task("T1", "Build A")])
    fresh_run = folder_store.load_run_yaml(fresh.team_dir)
    assert fresh_run["schemaVersion"] == folder_store.RUN_SCHEMA_VERSION
    assert folder_store.migrate_run_store(fresh.team_dir, fresh_run) is fresh_run

    # The floor below the one migrating step is unchanged.
    ancient = create_team(tmp_path, "pre-migration-floor", [task("T1", "Build A")])
    run = folder_store.load_run_yaml(ancient.team_dir)
    run["schemaVersion"] = folder_store.MIGRATABLE_RUN_SCHEMA_VERSION - 1
    folder_store.atomic_write_yaml(ancient.team_dir / folder_store.RUN_FILE, run)
    with pytest.raises(folder_store.RunStoreVersionError):
        folder_store.state_from_folder_store(ancient.team_dir)


# --- the ledger is the ledger --------------------------------------------------


def test_the_dispatch_ledger_is_append_only_and_never_rewritten_by_a_later_claim(tmp_path: Path) -> None:
    """These tests are only worth anything if the file they read keeps its history.

    A ledger that were rebuilt from current state each write would agree with the
    projection by construction, and could not have shown the original bug.
    """
    fixture, gate_task_id, plan_artifact_id = seed_roleless_run(
        tmp_path,
        "roleless-ledger",
        [task("T1", "Build A", owned_paths=["src/a"]), task("T2", "Build B", owned_paths=["src/b"])],
    )
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])
    ok(call(server, fixture.state_path, "sprintengine.task.claim", "coordinator",
            taskId=gate_task_id, id="coordinator"))
    approve_plan(server, fixture, plan_artifact_id)

    ok(call(server, fixture.state_path, "sprintengine.task.next", "agent-1", id="agent-1"))
    after_first = dispatch_sequence(fixture)
    ok(call(server, fixture.state_path, "sprintengine.task.next", "agent-2", id="agent-2"))
    after_second = dispatch_sequence(fixture)

    assert after_second[: len(after_first)] == after_first, "earlier records are never rewritten"
    assert len(after_second) == len(after_first) + 1


def test_the_ledger_dedups_a_repeat_claim_but_never_two_workers(tmp_path: Path) -> None:
    """What a ledger ROW COUNT does and does not mean — the tests above depend on it.

    A dispatch id is a content hash over `(agentId, role, target, reason)` with no
    timestamp, so the same agent re-claiming the same task never adds a second row,
    however long the gap. Counting rows therefore counts distinct (worker, task)
    pairs, which is exactly what "one worker per task" needs and what a repetition
    claim must not be built on.
    """
    fixture, gate_task_id, plan_artifact_id = seed_roleless_run(
        tmp_path,
        "roleless-ledger-dedup",
        [task("T1", "Build A", owned_paths=["src/a"]), task("T2", "Build B", owned_paths=["src/b"])],
    )
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])
    ok(call(server, fixture.state_path, "sprintengine.task.claim", "coordinator",
            taskId=gate_task_id, id="coordinator"))
    approve_plan(server, fixture, plan_artifact_id)

    ok(call(server, fixture.state_path, "sprintengine.task.next", "agent-1", id="agent-1"))
    ok(call(server, fixture.state_path, "sprintengine.task.release", "agent-1",
            taskId="T1", id="agent-1", reason="Session ended."))
    ok(call(server, fixture.state_path, "sprintengine.task.claim", "agent-1",
            taskId="T1", id="agent-1"))
    assert [record for record in claim_records(fixture) if record["agentId"] == "agent-1"] != []
    assert len([
        record for record in claim_records(fixture)
        if record["agentId"] == "agent-1" and (record.get("target") or {}).get("taskId") == "T1"
    ]) == 1, "a repeat claim of the same task by the same worker collapses into its first row"

    # A DIFFERENT worker on a different task is a different pair, so fan-out counting
    # — which is what the concurrency assertions rely on — is unaffected.
    ok(call(server, fixture.state_path, "sprintengine.task.next", "agent-2", id="agent-2"))
    work_pairs = {
        (str(record["agentId"]), str((record.get("target") or {}).get("taskId")))
        for record in claim_records(fixture)
    }
    assert work_pairs == {("coordinator", gate_task_id), ("agent-1", "T1"), ("agent-2", "T2")}
