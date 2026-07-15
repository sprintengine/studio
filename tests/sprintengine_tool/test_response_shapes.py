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
    CARD_NOTES_LIMIT,
    CARD_TEXT_LIMIT,
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
    record["phases"] = ["review"]
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
    # MC-1542: the card advertises the phase walk the owner will drive, not a
    # gate configuration a reviewer would have claimed.
    assert card["phases"] == ["review"]
    assert "qualityGates" not in card
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


def test_slim_card_caps_notes_and_needs_input_resolution(tmp_path) -> None:
    record = seeded_in_progress_task()
    long_resolution = "Architect ruling. " + ("verification context " * 200)
    record["notes"] = [f"note {index}" for index in range(CARD_NOTES_LIMIT + 2)]
    record["notes"].append("INPUT RESOLVED by architect: " + ("long note " * 200))
    record["needsInput"] = {
        "kind": "architect",
        "reason": "verification",
        "question": "Can this proceed?",
        "resolution": long_resolution,
    }
    fixture = create_team(tmp_path, "shape-card-caps", [record])
    server = make_server(tmp_path)

    slim = server.call_tool(
        "sprintengine.task.get",
        {"statePath": str(fixture.state_path), "taskId": "T1"},
        actor("workspace-user", "user"),
    )
    assert slim["ok"] is True
    card = slim["result"]["task"]
    assert len(card["notes"]) == CARD_NOTES_LIMIT
    assert card["notesTruncated"] is True
    assert len(card["needsInput"]["resolution"]) <= CARD_TEXT_LIMIT
    assert card["needsInputTruncated"] is True
    assert card["needsInput"]["resolution"] != long_resolution

    deep = server.call_tool(
        "sprintengine.task.get",
        {
            "statePath": str(fixture.state_path),
            "taskId": "T1",
            "include": ["notes", "needs_input"],
        },
        actor("workspace-user", "user"),
    )
    assert deep["ok"] is True
    deep_card = deep["result"]["task"]
    assert len(deep_card["notes"]) == CARD_NOTES_LIMIT + 3
    assert deep_card["needsInput"]["resolution"] == long_resolution
    assert "notesTruncated" not in deep_card
    assert "needsInputTruncated" not in deep_card


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


def test_publish_returns_the_review_directive_inline_without_echoing_the_task(tmp_path) -> None:
    """MC-1542: the review contract rides `nextDirective` on the publish ack, so
    the owner never needs a second round-trip to learn what to review. The ack is
    still an ack — no task echo, no bulk evidence."""
    fixture = create_team(tmp_path, "shape-phase-directive", [seeded_in_progress_task()])
    server = make_server(tmp_path)

    published = server.call_tool(
        "sprintengine.task.publish",
        {"statePath": str(fixture.state_path), "taskId": "T1", "id": "developer-a", "summary": "Done."},
        actor("developer-a", "developer"),
    )

    assert published["ok"] is True
    assert "task" not in published["result"]
    assert published["result"]["taskId"] == "T1"
    assert published["result"]["nextStatus"] == "review"
    assert published["result"]["producedChanges"] is True
    assert published["result"]["phases"] == ["review"]
    # The server-composed directive is the review contract; it is prose, not state.
    assert published["result"]["nextDirective"]


def test_advance_is_a_mutation_ack_not_a_state_echo(tmp_path) -> None:
    record = seeded_in_progress_task()
    record["status"] = "review"
    fixture = create_team(tmp_path, "shape-advance-ack", [record])
    server = make_server(tmp_path)

    advanced = server.call_tool(
        "sprintengine.task.advance",
        {
            "statePath": str(fixture.state_path),
            "taskId": "T1",
            "id": "developer-a",
            "phase": "review",
            "outcome": "pass",
            "summary": "Looks correct.",
        },
        actor("developer-a", "developer"),
    )

    assert advanced["ok"] is True
    assert "task" not in advanced["result"]
    assert advanced["result"]["taskId"] == "T1"
    assert advanced["result"]["nextStatus"] == "done"
    # The comment the advance wrote comes back as a delta, never a full echo.
    assert "activity" not in advanced["result"]
    # The mutation persisted even though the response is an ack.
    persisted = get_task(read_state(fixture.state_path), "T1")
    assert persisted["status"] == "done"
    assert persisted["ownerAgentId"] is None


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


def test_heartbeat_is_liveness_only_two_field_ack() -> None:
    """Heartbeat only renews the lease's heartbeatAt; it never observes a
    reassignment, so the shaper must not pretend otherwise: two fields, no worker
    echo, no assignment flags. Assignment state travels via task.next (MC-1591
    deleted the dispatch cursor). The shaper strips any lease-derived worker view
    the server hands it, so a fat input still collapses to `{ok, known}`."""
    from sprintengine_mcp.response_shapes import _heartbeat_response

    fat_agent = {
        "role": "developer",
        "status": "running",
        "currentTaskId": "T1",
        "currentDispatch": {"dispatchId": "d-1", "targetKind": "task", "taskId": "T1"},
    }
    known = _heartbeat_response({
        "ok": True,
        "known": True,
        "agent": fat_agent,
        "currentDispatch": fat_agent["currentDispatch"],
    })
    assert known == {"ok": True, "known": True}

    unknown = _heartbeat_response({"ok": True, "known": False, "agent": None, "previous": {}})
    assert unknown == {"ok": True, "known": False}


def test_heartbeat_liveness_poll_stays_under_byte_budget(tmp_path) -> None:
    """Size regression for the liveness poll. MC-1591 deleted the dispatch cursor
    and its `dispatch.next` replay, so a working agent's highest-frequency payload
    is now the bare heartbeat ack: it renews the lease's heartbeatAt and returns
    two fields, nothing more. This guards that the poll stays a tiny fixed delta."""
    fixture = create_team(tmp_path, "shape-poll-budget", [task("T1", "Poll", "developer")])
    server = make_server(tmp_path)
    claimed = server.call_tool(
        "sprintengine.task.next",
        {"statePath": str(fixture.state_path), "role": "developer", "id": "dev-1"},
        actor("dev-1", "developer"),
    )
    assert claimed["result"]["claimed"] is True

    heartbeat = server.call_tool(
        "sprintengine.agent.heartbeat",
        {"statePath": str(fixture.state_path), "agentId": "dev-1", "role": "developer"},
        actor("dev-1", "developer"),
    )
    # The lease was renewed (the worker is known) and the ack is exactly two fields.
    assert heartbeat["result"] == {"ok": True, "known": True}
    assert len(json.dumps(heartbeat)) < 200, f"heartbeat poll returned {len(json.dumps(heartbeat))} bytes"


def test_over_limit_prose_flags_ack_and_truncates_on_cards(tmp_path) -> None:
    """Evidence style nudge (MC-1445): an over-limit comment body is flagged
    on the write ack, rides cards truncated, and stays full only in the
    explicit deep read (`task.comment.list`)."""
    record = task("T1", "Style", "developer", status="in_progress", owner="dev-1")
    fixture = create_team(tmp_path, "shape-evidence-style", [record])
    server = make_server(tmp_path)
    long_body = "finding detail " * 80  # ~1200 chars, over CARD_TEXT_LIMIT

    posted = server.call_tool(
        "sprintengine.task.comment",
        {
            "statePath": str(fixture.state_path),
            "taskId": "T1",
            "id": "reviewer-1",
            "body": long_body,
            "commentType": "review_feedback",
            "source": "agent",
        },
        actor("reviewer-1", "security"),
    )
    assert posted["ok"] is True
    # The comment ack carries the over-limit signal as bodyTruncated on the
    # comment delta itself — no duplicate exceedsCardLimit flag.
    assert "exceedsCardLimit" not in posted["result"]
    ack_comment = posted["result"]["comment"]
    assert ack_comment["bodyTruncated"] is True
    assert len(ack_comment["body"]) <= CARD_TEXT_LIMIT

    resumed = server.call_tool(
        "sprintengine.task.next",
        {"statePath": str(fixture.state_path), "role": "developer", "id": "dev-1"},
        actor("dev-1", "developer"),
    )
    feedback = resumed["result"]["task"]["openFeedback"]
    assert feedback and feedback[0]["bodyTruncated"] is True
    assert len(feedback[0]["body"]) <= CARD_TEXT_LIMIT

    listed = server.call_tool(
        "sprintengine.task.comment.list",
        {"statePath": str(fixture.state_path), "taskId": "T1"},
        actor("dev-1", "developer"),
    )
    full_bodies = [comment["body"] for comment in listed["result"]["comments"]]
    assert long_body.strip() in full_bodies


def test_under_limit_prose_gets_no_advisory(tmp_path) -> None:
    record = task("T1", "Style short", "developer", status="in_progress", owner="dev-1")
    fixture = create_team(tmp_path, "shape-evidence-style-short", [record])
    server = make_server(tmp_path)

    logged = server.call_tool(
        "sprintengine.task.log",
        {"statePath": str(fixture.state_path), "taskId": "T1", "id": "dev-1", "summary": "Wired the adapter; tests green."},
        actor("dev-1", "developer"),
    )
    assert logged["ok"] is True
    assert "exceedsCardLimit" not in logged["result"]

    long_logged = server.call_tool(
        "sprintengine.task.log",
        {"statePath": str(fixture.state_path), "taskId": "T1", "id": "dev-1", "summary": "step " * 200},
        actor("dev-1", "developer"),
    )
    assert long_logged["ok"] is True
    assert long_logged["result"]["exceedsCardLimit"] is True


def test_evidence_summary_truncates_on_cards_with_deep_read_intact(tmp_path) -> None:
    """The task.log exceedsCardLimit advisory is only honest if cards really
    do truncate evidence.summary; the full text stays on the evidence_log
    deep read."""
    record = task("T1", "Long summary", "developer", status="in_progress", owner="dev-1")
    fixture = create_team(tmp_path, "shape-summary-trunc", [record])
    server = make_server(tmp_path)
    long_summary = "outcome detail " * 80  # ~1200 chars

    logged = server.call_tool(
        "sprintengine.task.log",
        {"statePath": str(fixture.state_path), "taskId": "T1", "id": "dev-1", "summary": long_summary},
        actor("dev-1", "developer"),
    )
    assert logged["result"]["exceedsCardLimit"] is True

    card = server.call_tool(
        "sprintengine.task.next",
        {"statePath": str(fixture.state_path), "role": "developer", "id": "dev-1"},
        actor("dev-1", "developer"),
    )["result"]["task"]
    assert len(card["evidence"]["summary"]) <= CARD_TEXT_LIMIT
    assert card["evidence"]["summaryTruncated"] is True

    deep = server.call_tool(
        "sprintengine.task.get",
        {"statePath": str(fixture.state_path), "taskId": "T1", "include": ["evidence_log"]},
        actor("dev-1", "developer"),
    )["result"]["task"]
    assert long_summary.strip() in deep["evidence"]["summary"]
    assert "summaryTruncated" not in deep["evidence"]
