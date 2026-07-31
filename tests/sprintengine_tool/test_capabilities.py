"""Role-scoped tool capability tests for the Sprint Engine MCP surface.

Visibility and authorization share one capability table
(`sprintengine_mcp/capabilities.py`): a tool hidden from a role's
`tools/list` must also fail when called by name, and the listed surface must
match the table exactly so the two can never drift apart.

MC-1542 collapsed the `reviewer` classification into `owner`. The classifications
are now `operator | architect | roleless | owner`, and there is no tool a reviewer
needs that an owner must not have: one agent owns a task from claim to `done`,
closing its own phases with `sprintengine.task.advance`. These tests pin that the
owner surface is exactly `AGENT_COMMON_TOOLS`, that a reviewer role gets the same
surface as any other worker, and that the retired gate / `task.request_changes`
tool names are unknown rather than merely hidden.
"""

from __future__ import annotations

import json
import threading
from contextlib import contextmanager

import urllib.request

from helpers import create_team, create_workspace_team, read_state, task, write_state, write_workspace_role
from sprintengine_mcp import McpRequestContext, SprintEngineMcpServer
from sprintengine_mcp.auth import ActorContext
from sprintengine_mcp.capabilities import (
    AGENT_COMMON_TOOLS,
    PLANNING_TOOLS,
    allowed_tools_for_classification,
    classify_role,
    classify_session,
    clear_role_classification_cache,
)
from sprintengine_mcp.http_server import SESSION_HEADER, SprintEngineHttpMcpServer
from sprintengine_mcp.schemas import TOOL_SCHEMAS
from sprintengine_mcp.tool_contracts import MCP_TOOL_CONTRACTS

# Every tool name MC-1542 and MC-1591 deleted. They must be gone from the
# contracts, the schemas, and every classification's surface — hiding them is not
# enough, because a hidden-but-live tool is a live tool for an operator session.
# MC-1591 (leases replace the roster) retired the roster-growth and dispatch-cursor
# surfaces: membership is `configuredRoles`, assignment is a claim-minted lease, so
# there is nothing to add/retire/replenish/list and no cursor to subscribe/ack.
RETIRED_TOOL_NAMES = (
    "sprintengine.gate.list",
    "sprintengine.gate.next",
    "sprintengine.gate.claim",
    "sprintengine.gate.verdict",
    "sprintengine.gate.publish",
    "sprintengine.gate.skip",
    "sprintengine.task.request_changes",
    "sprintengine.roster.add",
    "sprintengine.roster.retire",
    "sprintengine.roster.replenish",
    "sprintengine.roster.list",
    "sprintengine.dispatch.next",
    "sprintengine.dispatch.ack",
    "sprintengine.subscribe",
)


def actor(agent_id: str, role: str) -> dict[str, object]:
    return {"id": agent_id, "role": role, "mcpAuthorized": True}


def make_context(fixture, tmp_path, role: str = "", agent_id: str = "") -> McpRequestContext:
    return McpRequestContext(
        actor=ActorContext(id="multicode-app", role="user"),
        state_path=fixture.state_path,
        workspace_root=tmp_path,
        allowed_roots=(tmp_path,),
        role=role,
        agent_id=agent_id,
    )


def listed_names(server: SprintEngineMcpServer, context: McpRequestContext | None) -> set[str]:
    return {schema["name"] for schema in server.list_tools(context)}


def owned_review_task(task_id: str, role: str, owner: str) -> dict:
    record = task(task_id, "Reviewable change", role, "review", owner=owner)
    record["startedAt"] = "2026-07-08T00:00:00Z"
    return record


def test_capability_table_stays_within_active_contracts() -> None:
    all_tools = set(MCP_TOOL_CONTRACTS)
    assert AGENT_COMMON_TOOLS <= all_tools
    assert PLANNING_TOOLS <= all_tools
    # Every active tool is reachable by some classification (operator gets all).
    assert allowed_tools_for_classification("operator", all_tools) == all_tools


def test_retired_tool_names_are_unknown_not_merely_hidden(tmp_path) -> None:
    fixture = create_team(tmp_path, "cap-retired", [owned_review_task("T1", "developer", "developer-a")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    for name in RETIRED_TOOL_NAMES:
        assert name not in MCP_TOOL_CONTRACTS, name
        assert name not in TOOL_SCHEMAS, name
        assert name not in AGENT_COMMON_TOOLS, name
        assert name not in PLANNING_TOOLS, name
        removed = server.call_tool(
            name,
            {"statePath": str(fixture.state_path), "taskId": "T1", "id": "developer-a"},
            actor("developer-a", "developer"),
        )
        assert removed["ok"] is False, name
        assert removed["error"]["code"] == "unknown_tool", name


def test_listing_matches_capability_table_per_role(tmp_path) -> None:
    clear_role_classification_cache()
    fixture = create_team(tmp_path, "cap-listing", [task("T1", "Work", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    # The old `reviewer` classification is gone: a security and a product
    # role are owners with exactly the worker surface.
    expectations = {
        "developer": "owner",
        "security": "owner",
        "product": "owner",
        "architect": "architect",
    }
    for role, classification in expectations.items():
        assert classify_role(role, workspace_root=tmp_path) == classification
        listed = listed_names(server, make_context(fixture, tmp_path, role=role))
        assert listed == allowed_tools_for_classification(classification, TOOL_SCHEMAS), role

    # Owner surface: the whole lifecycle (claim -> publish -> advance -> done)
    # and nothing else. No planning, no run admin, no artifact adjudication,
    # no CLI-compatibility join.
    owner = listed_names(server, make_context(fixture, tmp_path, role="developer"))
    assert owner == AGENT_COMMON_TOOLS & set(TOOL_SCHEMAS)
    for hidden in (
        "sprintengine.plan.add_task",
        "sprintengine.summary",
        "sprintengine.join",
        "sprintengine.artifact.approve",
        "sprintengine.artifact.request_changes",
    ):
        assert hidden not in owner
    for granted in ("sprintengine.task.next", "sprintengine.task.publish", "sprintengine.task.advance", "sprintengine.agent.leave"):
        assert granted in owner

    # A reviewer role gets no extra privilege over any other owner.
    assert listed_names(server, make_context(fixture, tmp_path, role="security")) == owner

    # Architect gets planning (including artifact adjudication), but not the
    # operator-only CLI join.
    architect = listed_names(server, make_context(fixture, tmp_path, role="architect"))
    assert "sprintengine.plan.add_task" in architect
    assert "sprintengine.summary" in architect
    assert "sprintengine.artifact.request_changes" in architect
    assert "sprintengine.join" not in architect

    # Run-scoped sessions (no bound role) and stdio keep the full surface.
    assert listed_names(server, make_context(fixture, tmp_path)) == set(TOOL_SCHEMAS)
    assert listed_names(server, None) == set(TOOL_SCHEMAS)


def test_a_roleless_session_and_architect_share_one_planning_surface(tmp_path) -> None:
    """A roleless agent plans, builds, and reviews a run by itself. MC-1591 deleted
    the roster-growth tools that were the sole difference between it and the
    architect surface, so the two converge exactly: leases replaced the roster, so
    there is no team to grow and no fence to enforce.

    The discriminator is the SESSION, not the role name (MC-2057): a session with a
    bound agent id and no role is roleless, while a session with neither is the
    operator. Collapsing those two would hand every roleless worker the operator
    surface — `sprintengine.init`, `handover`, `recover` included."""
    clear_role_classification_cache()
    fixture = create_team(tmp_path, "cap-roleless", [task("T1", "Work", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    assert classify_session(bound_role="", bound_agent_id="agent-1") == "roleless"
    assert classify_session(bound_role="", bound_agent_id="") == "operator"
    assert classify_role("architect", workspace_root=tmp_path) == "architect"
    # The deleted fake role no longer classifies as anything special.
    assert classify_role("general", workspace_root=tmp_path) == "owner"

    expected = AGENT_COMMON_TOOLS | PLANNING_TOOLS
    roleless = listed_names(server, make_context(fixture, tmp_path, agent_id="agent-1"))
    architect = listed_names(server, make_context(fixture, tmp_path, role="architect", agent_id="architect"))
    assert roleless == allowed_tools_for_classification("roleless", TOOL_SCHEMAS)
    assert roleless == expected
    # The convergence: identical surfaces, no roster-growth tools on either.
    assert roleless == architect
    # And it is NOT the operator surface: run administration stays out.
    assert roleless != set(TOOL_SCHEMAS)
    assert "sprintengine.join" not in roleless

    # Planning + lifecycle + artifact adjudication surface is present.
    for granted in (
        "sprintengine.plan.add_task",
        "sprintengine.task.advance",
        "sprintengine.artifact.request_changes",
    ):
        assert granted in roleless, granted
    # The deleted roster tools are gone from every surface, not merely hidden:
    # MC-1591 took growth/list, MC-1889 took `configure` with the formation.
    for retired in (
        "sprintengine.roster.add",
        "sprintengine.roster.replenish",
        "sprintengine.roster.list",
        "sprintengine.roster.configure",
    ):
        assert retired not in roleless, retired
        assert retired not in architect, retired
        assert retired not in TOOL_SCHEMAS, retired


def test_a_roleless_session_can_plan_and_a_deleted_roster_tool_is_unknown(tmp_path) -> None:
    clear_role_classification_cache()
    fixture = create_team(tmp_path, "cap-roleless-calls", [task("T1", "Work", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])
    context = make_context(fixture, tmp_path, agent_id="agent-1")

    # The roster-growth tools are deleted, not merely withheld: a call to one is an
    # unknown tool for anyone (leases replaced the roster).
    unknown = server.call_tool(
        "sprintengine.roster.add",
        {"role": "developer"},
        actor("agent-1", ""),
        context=context,
    )
    assert unknown["ok"] is False
    assert unknown["error"]["code"] == "unknown_tool"

    # The planning surface is reachable for a roleless agent, and the task it plans
    # may itself carry no role.
    planned = server.call_tool(
        "sprintengine.plan.add_task",
        {"title": "Planned with no role"},  # statePath comes from the bound session
        actor("agent-1", ""),
        context=context,
    )
    assert planned["ok"] is True, planned.get("error")
    # `plan.add_task` acks rather than echoing the card, so read what it persisted.
    added = [t for t in read_state(fixture.state_path)["tasks"] if t["title"] == "Planned with no role"]
    assert len(added) == 1 and "role" not in added[0]


def test_hidden_tools_fail_when_called_by_name(tmp_path) -> None:
    clear_role_classification_cache()
    fixture = create_team(tmp_path, "cap-enforce", [task("T1", "Work", "developer")])
    state = read_state(fixture.state_path)
    state["sprintengine"]["rosterConfigured"] = True
    state["agents"] = {
        "architect": {"role": "architect", "status": "idle", "currentTaskId": None},
        "developer-a": {"role": "developer", "status": "idle", "currentTaskId": None},
        "reviewer-a": {"role": "security", "status": "idle", "currentTaskId": None},
    }
    write_state(fixture.state_path, state)
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    denied = server.call_tool(
        "sprintengine.plan.add_task",
        {"statePath": str(fixture.state_path), "title": "Sneaky", "role": "developer"},
        actor("developer-a", "developer"),
    )
    assert denied["ok"] is False
    assert denied["error"]["code"] == "tool_not_permitted_for_role"
    assert denied["error"]["details"]["role"] == "developer"
    assert "permittedAlternative" in denied["error"]["details"]
    assert len(read_state(fixture.state_path)["tasks"]) == 1

    reviewer_denied = server.call_tool(
        "sprintengine.summary",
        {"statePath": str(fixture.state_path)},
        actor("reviewer-a", "security"),
    )
    assert reviewer_denied["ok"] is False
    assert reviewer_denied["error"]["code"] == "tool_not_permitted_for_role"

    # Artifact adjudication is a planner/operator action, not a rework channel a
    # worker can pull on its own task.
    worker_artifact_denied = server.call_tool(
        "sprintengine.artifact.request_changes",
        {"statePath": str(fixture.state_path), "artifactId": "A1", "id": "developer-a", "feedback": "Not my call."},
        actor("developer-a", "developer"),
    )
    assert worker_artifact_denied["ok"] is False
    assert worker_artifact_denied["error"]["code"] == "tool_not_permitted_for_role"

    # The permitted side of the same roles keeps working.
    claimed = server.call_tool(
        "sprintengine.task.next",
        {"statePath": str(fixture.state_path), "role": "developer", "id": "developer-a"},
        actor("developer-a", "developer"),
    )
    assert claimed["ok"] is True
    assert claimed["result"]["claimed"] is True

    architect_plan = server.call_tool(
        "sprintengine.plan.add_task",
        {"statePath": str(fixture.state_path), "title": "Planned", "role": "developer"},
        actor("architect", "architect"),
    )
    assert architect_plan["ok"] is True


def test_plugin_reviewer_role_gets_the_plain_owner_surface(tmp_path) -> None:
    """A reviewer role is a full implementer: it claims its own task, fixes what it
    finds, and closes its phases with `task.advance`. It grants no tool a plain
    worker lacks."""
    clear_role_classification_cache()
    workspace = tmp_path / "plugin-ws"
    write_workspace_role(workspace, "compliance_reviewer")
    write_workspace_role(workspace, "data_engineer")
    fixture = create_workspace_team(tmp_path, "plugin-ws", "cap-plugin", [task("T1", "Work", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    assert classify_role("compliance_reviewer", workspace_root=workspace) == "owner"
    assert classify_role("data_engineer", workspace_root=workspace) == "owner"
    assert classify_role("never_registered_role", workspace_root=workspace) == "owner"

    def surface(role: str) -> set[str]:
        return listed_names(
            server,
            McpRequestContext(
                actor=ActorContext(id="multicode-app", role="user"),
                state_path=fixture.state_path,
                workspace_root=workspace,
                allowed_roots=(tmp_path,),
                role=role,
            ),
        )

    reviewer_surface = surface("compliance_reviewer")
    assert reviewer_surface == surface("data_engineer")
    assert "sprintengine.task.advance" in reviewer_surface
    assert "sprintengine.plan.add_task" not in reviewer_surface


def test_role_bound_session_cannot_impersonate_another_role(tmp_path) -> None:
    clear_role_classification_cache()
    fixture = create_team(tmp_path, "cap-impersonate", [task("T1", "Work", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])
    context = make_context(fixture, tmp_path, role="developer", agent_id="developer-a")

    mismatched = server.call_tool(
        "sprintengine.task.next",
        {"statePath": str(fixture.state_path), "role": "architect", "id": "developer-a"},
        context=context,
    )
    assert mismatched["ok"] is False
    assert mismatched["error"]["code"] == "tool_not_permitted_for_role"
    assert mismatched["error"]["details"]["payloadRole"] == "architect"

    matched = server.call_tool(
        "sprintengine.task.next",
        {"statePath": str(fixture.state_path), "role": "developer", "id": "developer-a"},
        context=context,
    )
    assert matched["ok"] is True


def _repo_bound_fixture(tmp_path, name: str):
    """A two-repo run with one ready developer task in each tree."""
    desktop = task("T-desktop", "Desktop work", "developer")
    mobile = task("T-mobile", "Phone work", "developer")
    mobile["repo"] = "mobile"
    fixture = create_team(tmp_path, name, [desktop, mobile])
    state = read_state(fixture.state_path)
    state.setdefault("sprintengine", {})["vcs"] = {
        "mode": "run_worktree",
        "worktreePath": ".multi-code/sprintengine/x/worktree",
        "branchName": "sprintengine/x",
        "repos": [
            {"id": "primary", "root": ".", "worktreePath": ".multi-code/sprintengine/x/worktree", "branchName": "sprintengine/x"},
            {"id": "mobile", "root": "../mobile", "worktreePath": ".multi-code/sprintengine/x/worktree-mobile", "branchName": "sprintengine/x"},
        ],
    }
    write_state(fixture.state_path, state)
    return fixture


def test_repo_bound_session_claims_its_own_repo_without_asking(tmp_path) -> None:
    """MC-1613: the session's repo comes from the worktree it was spawned into,
    so the server stamps it onto the claim. An agent that never mentions a repo —
    every agent, since the startup prompt does not name one — still only gets its
    own tree's work."""
    clear_role_classification_cache()
    fixture = _repo_bound_fixture(tmp_path, "cap-repo-bound")
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])
    context = McpRequestContext(
        actor=ActorContext(id="multicode-app", role="user"),
        state_path=fixture.state_path,
        workspace_root=tmp_path,
        allowed_roots=(tmp_path,),
        role="developer",
        agent_id="developer-a",
        repo="mobile",
    )

    claimed = server.call_tool(
        "sprintengine.task.next",
        {"statePath": str(fixture.state_path), "role": "developer", "id": "developer-a"},
        context=context,
    )
    assert claimed["ok"] is True
    assert claimed["result"]["task"]["id"] == "T-mobile", "the desktop task is first in the queue and must be skipped"


def test_repo_bound_session_cannot_claim_into_another_repo(tmp_path) -> None:
    """The repo mirror of role impersonation: a session cannot ask for another
    tree's queue. Its cwd is fixed at spawn, so a claim in another repo could
    only ever commit through the wrong index."""
    clear_role_classification_cache()
    fixture = _repo_bound_fixture(tmp_path, "cap-repo-impersonate")
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])
    context = McpRequestContext(
        actor=ActorContext(id="multicode-app", role="user"),
        state_path=fixture.state_path,
        workspace_root=tmp_path,
        allowed_roots=(tmp_path,),
        role="developer",
        agent_id="developer-a",
        repo="mobile",
    )

    mismatched = server.call_tool(
        "sprintengine.task.next",
        {"statePath": str(fixture.state_path), "role": "developer", "id": "developer-a", "repo": "primary"},
        context=context,
    )
    assert mismatched["ok"] is False
    assert mismatched["error"]["code"] == "tool_not_permitted_for_repo"
    assert mismatched["error"]["details"]["payloadRepo"] == "primary"
    assert read_state(fixture.state_path)["tasks"][0]["status"] == "todo", "no task was claimed"


def test_an_unbound_session_still_sees_every_repos_work(tmp_path) -> None:
    """Single-repo runs and operator sessions bind no repo, so nothing is
    filtered — the pre-multi-repo behavior, unchanged."""
    clear_role_classification_cache()
    fixture = _repo_bound_fixture(tmp_path, "cap-repo-unbound")
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    claimed = server.call_tool(
        "sprintengine.task.next",
        {"statePath": str(fixture.state_path), "role": "developer", "id": "developer-a"},
        context=make_context(fixture, tmp_path, role="developer", agent_id="developer-a"),
    )
    assert claimed["ok"] is True
    assert claimed["result"]["task"]["id"] == "T-desktop"


def test_a_worker_closes_its_own_review_phase(tmp_path) -> None:
    """Regression, restated for MC-1542: the frontend worker used to claim and
    verdict its own `frontend_review` gate. Now it simply advances out of its own
    `review` phase. `task.advance` must therefore live in the common surface with
    no reviewer classification behind it, and owner-only enforcement (not role
    matching) is what protects the transition."""
    clear_role_classification_cache()
    fixture = create_team(tmp_path, "cap-worker-review", [owned_review_task("T1", "frontend", "frontend")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    assert classify_role("frontend", workspace_root=tmp_path) == "owner"
    assert "sprintengine.task.advance" in listed_names(server, make_context(fixture, tmp_path, role="frontend"))

    advanced = server.call_tool(
        "sprintengine.task.advance",
        {
            "statePath": str(fixture.state_path),
            "taskId": "T1",
            "id": "frontend",
            "phase": "review",
            "outcome": "pass",
            "summary": "Reviewed my own change; looks right.",
        },
        actor("frontend", "frontend"),
    )
    assert advanced["ok"] is True, advanced.get("error")
    assert advanced["result"]["nextStatus"] == "done"
    assert read_state(fixture.state_path)["tasks"][0]["status"] == "done"


def test_a_non_owner_cannot_advance_someone_elses_review(tmp_path) -> None:
    """The capability table lets every owner call `task.advance`; owner-binding is
    what stops a stranger closing a phase on a task it does not hold."""
    clear_role_classification_cache()
    fixture = create_team(tmp_path, "cap-advance-owner", [owned_review_task("T1", "frontend", "frontend-1")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    denied = server.call_tool(
        "sprintengine.task.advance",
        {
            "statePath": str(fixture.state_path),
            "taskId": "T1",
            "id": "frontend-2",
            "phase": "review",
            "outcome": "pass",
            "summary": "Not mine to close.",
        },
        actor("frontend-2", "frontend"),
    )
    assert denied["ok"] is False
    assert "not_task_owner" in json.dumps(denied["error"])
    assert read_state(fixture.state_path)["tasks"][0]["status"] == "review"


def test_operator_keeps_cli_compatibility_join(tmp_path) -> None:
    fixture = create_team(tmp_path, "cap-cli-join", [task("T1", "Join", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    operator_join = server.call_tool(
        "sprintengine.join",
        {"statePath": str(fixture.state_path), "role": "developer", "id": "developer-a"},
        actor("workspace-user", "user"),
    )
    assert operator_join["ok"] is True

    agent_join = server.call_tool(
        "sprintengine.join",
        {"statePath": str(fixture.state_path), "role": "developer", "id": "developer-b"},
        actor("developer-b", "developer"),
    )
    assert agent_join["ok"] is False
    assert agent_join["error"]["code"] == "tool_not_permitted_for_role"
    assert agent_join["error"]["details"]["permittedAlternative"] == "sprintengine.agent.join"


def test_worker_tool_listing_stays_under_byte_budget(tmp_path) -> None:
    clear_role_classification_cache()
    fixture = create_team(tmp_path, "cap-budget", [task("T1", "Work", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    worker_listing = server.list_tools(make_context(fixture, tmp_path, role="developer"))
    serialized = len(json.dumps(worker_listing))
    # The token-efficiency plan targeted ~6k tokens (~24k chars) for workers.
    # Replacing the four gate tools with the single `task.advance` bought some of
    # that back; MC-1591 deleting the roster-growth/dispatch tools bought more
    # (measured ~25.5k), so the ceiling ratcheted from 28k to 26k. MC-1671 adds one
    # agent-common tool (`vcs.request_repo`, ~0.5k), a real new capability every
    # worker needs, nudging it to 27k. It still guards against regression toward the
    # old ~62k-char full listing.
    assert serialized < 27_000, f"worker tools/list serialized to {serialized} chars"
    full_listing = len(json.dumps(server.list_tools(None)))
    assert serialized < full_listing


@contextmanager
def run_http_server(server: SprintEngineMcpServer, token: str):
    httpd = SprintEngineHttpMcpServer(
        ("127.0.0.1", 0),
        server,
        actor=ActorContext(id="workspace-user", role="user", authenticated=True, mcp_authorized=True),
        auth_token=token,
    )
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    host, port = httpd.server_address
    try:
        yield f"http://{host}:{port}/mcp"
    finally:
        httpd.shutdown()
        thread.join(timeout=5)
        httpd.server_close()


def post(url: str, token: str, payload: dict, session_id: str | None = None) -> tuple[dict[str, str], dict]:
    data = json.dumps(payload).encode("utf-8")
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    if session_id:
        headers[SESSION_HEADER] = session_id
    request = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=5) as response:
        return dict(response.headers.items()), json.loads(response.read().decode("utf-8"))


def test_http_agent_scoped_registration_filters_listing_and_enforces_calls(tmp_path) -> None:
    clear_role_classification_cache()
    workspace = tmp_path / "workspace-a"
    fixture = create_workspace_team(tmp_path, "workspace-a", "cap-http", [task("T1", "Work", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[workspace])

    with run_http_server(server, token="admin-token") as base_url:
        _, run = post(f"{base_url}/runs", "admin-token", {
            "runId": "agent-run",
            "workspaceRoot": str(workspace),
            "statePath": str(fixture.state_path),
            "allowedRoots": [str(workspace)],
            "registryRoots": [],
            "actorId": "multicode-app",
            "agentId": "developer-a",
            "role": "developer",
        })
        headers, _ = post(base_url, run["runToken"], {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
        session_id = headers[SESSION_HEADER]

        _, listing = post(base_url, run["runToken"], {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, session_id)
        names = {tool["name"] for tool in listing["result"]["tools"]}
        assert "sprintengine.task.next" in names
        assert "sprintengine.task.advance" in names
        assert "sprintengine.plan.add_task" not in names
        assert "sprintengine.artifact.request_changes" not in names

        _, denied = post(base_url, run["runToken"], {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "sprintengine.plan.add_task", "arguments": {"title": "Sneaky", "role": "developer"}},
        }, session_id)
        denied_result = json.loads(denied["result"]["content"][0]["text"])
        assert denied_result["ok"] is False
        assert denied_result["error"]["code"] == "tool_not_permitted_for_role"

        _, claimed = post(base_url, run["runToken"], {
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {"name": "sprintengine.task.next", "arguments": {"role": "developer", "id": "developer-a"}},
        }, session_id)
        claimed_result = json.loads(claimed["result"]["content"][0]["text"])
        assert claimed_result["ok"] is True
        assert claimed_result["result"]["claimed"] is True

        # Run-scoped registrations (no agentId/role) keep the operator surface.
        _, run_scoped = post(f"{base_url}/runs", "admin-token", {
            "runId": "operator-run",
            "workspaceRoot": str(workspace),
            "statePath": str(fixture.state_path),
            "allowedRoots": [str(workspace)],
            "registryRoots": [],
            "actorId": "multicode-app",
        })
        op_headers, _ = post(base_url, run_scoped["runToken"], {"jsonrpc": "2.0", "id": 5, "method": "initialize", "params": {}})
        _, op_listing = post(base_url, run_scoped["runToken"], {"jsonrpc": "2.0", "id": 6, "method": "tools/list"}, op_headers[SESSION_HEADER])
        op_names = {tool["name"] for tool in op_listing["result"]["tools"]}
        assert op_names == set(TOOL_SCHEMAS)
