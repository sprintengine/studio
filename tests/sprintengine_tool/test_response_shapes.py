"""Response-shape regression tests for the Sprint Engine MCP token contract.

These tests fail the build when state echoes return to the MCP surface:
mutation tools must answer with acks, read tools with slim cards, and
directives with stubs. The run store stays the source of truth, so every
test also verifies the mutation actually persisted.
"""

from __future__ import annotations

import json

from helpers import create_team, get_task, read_state, task, write_state
from sprintengine_mcp import SprintEngineMcpServer
from sprintengine_mcp.response_shapes import (
    COMMENT_LIST_DEFAULT_LIMIT,
    MUTATION_ACK_TOOLS,
    SLIM_CARD_TOOLS,
)
from sprintengine_mcp.schemas import TOOL_SCHEMAS
from sprintengine_mcp.tool_contracts import MCP_TOOL_CONTRACTS


def actor(agent_id: str, role: str = "product") -> dict[str, object]:
    return {"id": agent_id, "role": role, "mcpAuthorized": True}


def make_server(tmp_path) -> SprintEngineMcpServer:
    return SprintEngineMcpServer(allowed_roots=[tmp_path])


def seeded_in_progress_task() -> dict[str, object]:
    record = task("T1", "Implement feature", "developer", status="in_progress", owner="developer-a")
    record["evidence"] = {
        "summary": "Working summary",
        "touchedFiles": ["src/a.ts"],
        "commandsRan": [f"command-{index}" for index in range(30)],
        "results": [f"result-{index}" for index in range(30)],
        "scopeExpansions": [],
        "diffs": [{"path": "src/a.ts", "diff": "+" * 5000}],
    }
    record["activity"] = [
        {"kind": "evidence", "actor": "developer-a", "message": f"activity {index}"}
        for index in range(20)
    ]
    record["comments"] = [
        {
            "id": f"C{index}",
            "type": "user_note",
            "actor": "user",
            "body": f"note {index}",
            "data": {"status": "open"},
        }
        for index in range(30)
    ]
    return record


def test_mutation_tools_never_echo_the_task(tmp_path) -> None:
    fixture = create_team(tmp_path, "shape-mutation-ack", [seeded_in_progress_task()])
    server = make_server(tmp_path)

    logged = server.call_tool(
        "sprintengine.task.log",
        {
            "statePath": str(fixture.state_path),
            "taskId": "T1",
            "id": "developer-a",
            "summary": "Implemented the change.",
            "command": ["npm test"],
            "result": ["tests green"],
        },
        actor("developer-a", "developer"),
    )

    assert logged["ok"] is True
    assert "task" not in logged["result"]
    assert logged["result"]["taskId"] == "T1"
    assert logged["result"]["taskStatus"] == "in_progress"
    # Open feedback still reaches the working agent as an explicit delta.
    assert logged["result"]["openFeedback"]
    assert all("body" in comment for comment in logged["result"]["openFeedback"])
    # The mutation persisted even though the response is an ack.
    persisted = get_task(read_state(fixture.state_path), "T1")
    assert "npm test" in persisted["evidence"]["commandsRan"]

    published = server.call_tool(
        "sprintengine.task.publish",
        {
            "statePath": str(fixture.state_path),
            "taskId": "T1",
            "id": "developer-a",
            "summary": "Done.",
        },
        actor("developer-a", "developer"),
    )

    assert published["ok"] is True
    assert "task" not in published["result"]
    assert published["result"]["taskId"] == "T1"
    assert published["result"]["nextStatus"]
    assert "progression" in published["result"]


def test_slim_card_excludes_bulk_evidence_and_activity(tmp_path) -> None:
    record = seeded_in_progress_task()
    fixture = create_team(tmp_path, "shape-slim-card", [record])
    server = make_server(tmp_path)

    resumed = server.call_tool(
        "sprintengine.task.next",
        {"statePath": str(fixture.state_path), "role": "developer", "id": "developer-a"},
        actor("developer-a", "developer"),
    )

    assert resumed["ok"] is True
    card = resumed["result"]["task"]
    assert card["id"] == "T1"
    assert card["status"] == "in_progress"
    assert card["evidence"] == {"summary": "Working summary", "touchedFiles": ["src/a.ts"]}
    assert "activity" not in card
    assert "comments" not in card
    assert "diffs" not in card["evidence"]
    assert "commandsRan" not in card["evidence"]
    assert "results" not in card["evidence"]
    assert len(card["openFeedback"]) == 10
    # The rework prompt beside the card is server-composed and untouched.
    assert resumed["result"]["prompt"]


def test_task_get_defaults_to_slim_card_and_supports_include(tmp_path) -> None:
    fixture = create_team(tmp_path, "shape-task-get", [seeded_in_progress_task()])
    server = make_server(tmp_path)

    slim = server.call_tool(
        "sprintengine.task.get",
        {"statePath": str(fixture.state_path), "taskId": "T1"},
        actor("workspace-user", "user"),
    )
    assert slim["ok"] is True
    assert "activity" not in slim["result"]["task"]
    assert "comments" not in slim["result"]["task"]
    assert "diffs" not in slim["result"]["task"]["evidence"]

    deep = server.call_tool(
        "sprintengine.task.get",
        {
            "statePath": str(fixture.state_path),
            "taskId": "T1",
            "include": ["activity", "comments", "evidence_log", "diffs"],
        },
        actor("workspace-user", "user"),
    )
    assert deep["ok"] is True
    deep_card = deep["result"]["task"]
    assert len(deep_card["activity"]) == 20
    assert len(deep_card["comments"]) == 30
    assert len(deep_card["evidence"]["commandsRan"]) == 30
    assert len(deep_card["evidence"]["results"]) == 30
    assert deep_card["evidence"]["diffs"]


def test_directive_returns_stubs_not_cards(tmp_path) -> None:
    fixture = create_team(tmp_path, "shape-directive-stub", [seeded_in_progress_task()])
    server = make_server(tmp_path)

    directive = server.call_tool(
        "sprintengine.agent.next_directive",
        {"statePath": str(fixture.state_path), "role": "developer", "agentId": "developer-a"},
        actor("developer-a", "developer"),
    )

    assert directive["ok"] is True
    stub = directive["result"].get("task")
    if stub is not None:
        assert set(stub) <= {"id", "title", "status", "role"}


def test_gate_review_keeps_prompt_but_slims_payloads(tmp_path) -> None:
    record = seeded_in_progress_task()
    record["status"] = "review"
    record["ownerAgentId"] = None
    record["qualityGates"] = [
        {
            "id": "code_reviewer",
            "role": "code_reviewer",
            "phase": "review",
            "status": "pending",
            "required": True,
            "allowSelfReview": False,
            "focus": "Review the change.",
            "attempts": [],
        }
    ]
    fixture = create_team(tmp_path, "shape-gate-review", [record])
    server = make_server(tmp_path)

    claimed = server.call_tool(
        "sprintengine.gate.next",
        {"statePath": str(fixture.state_path), "role": "code_reviewer", "id": "reviewer-a"},
        actor("reviewer-a", "code_reviewer"),
    )

    assert claimed["ok"] is True
    assert claimed["result"]["claimed"] is True
    # The reviewer contract lives in the server-composed prompt, which still
    # carries the implementation evidence.
    assert "Working summary" in claimed["result"]["prompt"]
    card = claimed["result"]["task"]
    assert "activity" not in card
    assert "diffs" not in card["evidence"]
    gate_payload = claimed["result"]["gate"]
    assert "attempts" not in gate_payload

    verdict = server.call_tool(
        "sprintengine.gate.verdict",
        {
            "statePath": str(fixture.state_path),
            "taskId": "T1",
            "gateId": "code_reviewer",
            "id": "reviewer-a",
            "role": "code_reviewer",
            "verdict": "approved",
            "summary": "Looks correct.",
        },
        actor("reviewer-a", "code_reviewer"),
    )

    assert verdict["ok"] is True
    assert "task" not in verdict["result"]
    assert verdict["result"]["taskId"] == "T1"
    gate_ack = verdict["result"].get("gate")
    if gate_ack is not None:
        assert "attempts" not in gate_ack
    persisted_gate = get_task(read_state(fixture.state_path), "T1")["qualityGates"][0]
    assert persisted_gate["status"] == "approved"
    assert persisted_gate["attempts"]


def test_run_subscribe_without_cursor_is_capped(tmp_path) -> None:
    fixture = create_team(tmp_path, "shape-subscribe-cap", [task("T1", "Eventful", "developer")])
    state = read_state(fixture.state_path)
    state["events"] = [
        {"id": f"E{index}", "kind": "note", "message": f"event {index}"}
        for index in range(120)
    ]
    write_state(fixture.state_path, state)
    server = make_server(tmp_path)

    cold = server.call_tool(
        "sprintengine.run.subscribe",
        {"statePath": str(fixture.state_path)},
        actor("workspace-user", "user"),
    )
    assert cold["ok"] is True
    assert len(cold["result"]["events"]) == SprintEngineMcpServer.RUN_SUBSCRIBE_NO_CURSOR_LIMIT
    assert cold["result"]["truncated"] is True
    assert cold["result"]["oldestReturnedEventId"] == "E70"
    assert cold["result"]["latestEventId"] == "E119"

    warm = server.call_tool(
        "sprintengine.run.subscribe",
        {"statePath": str(fixture.state_path), "lastEventId": "E117"},
        actor("workspace-user", "user"),
    )
    assert warm["ok"] is True
    assert [event["id"] for event in warm["result"]["events"]] == ["E118", "E119"]
    assert warm["result"]["truncated"] is False


def test_comment_list_paginates_newest_last(tmp_path) -> None:
    fixture = create_team(tmp_path, "shape-comment-limit", [seeded_in_progress_task()])
    server = make_server(tmp_path)

    default_page = server.call_tool(
        "sprintengine.task.comment.list",
        {"statePath": str(fixture.state_path), "taskId": "T1"},
        actor("workspace-user", "user"),
    )
    assert default_page["ok"] is True
    assert len(default_page["result"]["comments"]) == COMMENT_LIST_DEFAULT_LIMIT
    assert default_page["result"]["totalCount"] == 30
    assert default_page["result"]["truncated"] is True
    assert default_page["result"]["comments"][-1]["id"] == "C29"

    explicit = server.call_tool(
        "sprintengine.task.comment.list",
        {"statePath": str(fixture.state_path), "taskId": "T1", "limit": 5},
        actor("workspace-user", "user"),
    )
    assert [comment["id"] for comment in explicit["result"]["comments"]] == ["C25", "C26", "C27", "C28", "C29"]


def test_summary_returns_counts_not_evidence_concatenation(tmp_path) -> None:
    record = seeded_in_progress_task()
    record["status"] = "done"
    record["ownerAgentId"] = None
    fixture = create_team(tmp_path, "shape-summary-counts", [record])
    server = make_server(tmp_path)

    summary = server.call_tool(
        "sprintengine.summary",
        {"statePath": str(fixture.state_path)},
        actor("workspace-user", "user"),
    )

    assert summary["ok"] is True
    body = summary["result"]["summary"]
    assert "results" not in body
    assert "commandsRan" not in body
    assert "touchedFiles" not in body
    assert body["resultsCount"] == 30
    assert body["commandsRanCount"] == 30
    assert body["touchedFilesCount"] == 1
    assert body["completedTasks"][0]["id"] == "T1"


def test_run_projection_is_not_an_mcp_tool(tmp_path) -> None:
    assert "sprintengine.run.projection" not in TOOL_SCHEMAS
    assert "sprintengine.run.projection" not in MCP_TOOL_CONTRACTS
    fixture = create_team(tmp_path, "shape-no-projection", [task("T1", "Hidden", "developer")])
    server = make_server(tmp_path)
    listed = {tool["name"] for tool in server.list_tools()}
    assert "sprintengine.run.projection" not in listed
    response = server.call_tool(
        "sprintengine.run.projection",
        {"statePath": str(fixture.state_path)},
        actor("workspace-user", "user"),
    )
    assert response["ok"] is False
    assert response["error"]["code"] == "unknown_tool"


def test_mutation_ack_and_card_tool_sets_stay_within_active_contracts() -> None:
    assert MUTATION_ACK_TOOLS <= set(MCP_TOOL_CONTRACTS)
    assert SLIM_CARD_TOOLS <= set(MCP_TOOL_CONTRACTS)


def test_claim_log_publish_cycle_stays_under_byte_budget(tmp_path) -> None:
    """End-to-end size regression: one claim→log→publish cycle on a task with
    heavy accumulated evidence must stay far below the old full-echo cost."""
    record = seeded_in_progress_task()
    record["status"] = "todo"
    record["ownerAgentId"] = None
    fixture = create_team(tmp_path, "shape-byte-budget", [record])
    server = make_server(tmp_path)

    total_bytes = 0
    claim = server.call_tool(
        "sprintengine.task.next",
        {"statePath": str(fixture.state_path), "role": "developer", "id": "developer-a"},
        actor("developer-a", "developer"),
    )
    total_bytes += len(json.dumps(claim))
    for index in range(3):
        logged = server.call_tool(
            "sprintengine.task.log",
            {
                "statePath": str(fixture.state_path),
                "taskId": "T1",
                "id": "developer-a",
                "command": [f"verify-{index}"],
                "result": [f"verified {index}"],
            },
            actor("developer-a", "developer"),
        )
        total_bytes += len(json.dumps(logged))
    published = server.call_tool(
        "sprintengine.task.publish",
        {"statePath": str(fixture.state_path), "taskId": "T1", "id": "developer-a", "summary": "Done."},
        actor("developer-a", "developer"),
    )
    total_bytes += len(json.dumps(published))

    # The seeded task alone serializes to >6k bytes of evidence/diffs, and the
    # old contract echoed it on every call. The new contract keeps the whole
    # cycle within a small fixed budget dominated by the rework prompt.
    assert total_bytes < 40_000, f"claim→log→publish cycle returned {total_bytes} bytes"
