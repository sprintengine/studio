"""Artifact write-budget regression tests.

Verdict summaries, publish summaries, and required actions are re-read into
every later rework/gate prompt, so the server rejects oversized writes before
any state mutates. The prompt/skill byte ceilings keep the writing-side style
contract from silently bloating back.
"""

from __future__ import annotations

from pathlib import Path

from helpers import REPO_ROOT, create_team, get_task, read_state, task
from sprintengine_core.tool.constants import (
    GATE_VERDICT_SUMMARY_LIMIT,
    PUBLISH_SUMMARY_LIMIT,
    REQUIRED_ACTION_LIMIT,
)
from sprintengine_mcp import SprintEngineMcpServer
from sprintengine_mcp.schemas import TOOL_SCHEMAS


def actor(agent_id: str, role: str) -> dict[str, object]:
    return {"id": agent_id, "role": role, "mcpAuthorized": True}


def make_server(tmp_path) -> SprintEngineMcpServer:
    return SprintEngineMcpServer(allowed_roots=[tmp_path])


def review_task_with_pending_gate() -> dict[str, object]:
    record = task("T1", "Implement feature", "developer", status="review")
    record["evidence"]["summary"] = "Working summary"
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
    return record


def claim_gate(server: SprintEngineMcpServer, state_path, reviewer: str) -> None:
    claimed = server.call_tool(
        "sprintengine.gate.next",
        {"statePath": str(state_path), "role": "code_reviewer", "id": reviewer},
        actor(reviewer, "code_reviewer"),
    )
    assert claimed["ok"] is True
    assert claimed["result"]["claimed"] is True


def verdict_payload(state_path, reviewer: str, **overrides) -> dict[str, object]:
    payload: dict[str, object] = {
        "statePath": str(state_path),
        "taskId": "T1",
        "gateId": "code_reviewer",
        "id": reviewer,
        "role": "code_reviewer",
        "verdict": "approved",
        "summary": "Looks correct.",
    }
    payload.update(overrides)
    return payload


def test_oversized_verdict_summary_rejected_before_mutation(tmp_path) -> None:
    fixture = create_team(tmp_path, "budget-verdict-summary", [review_task_with_pending_gate()])
    server = make_server(tmp_path)
    claim_gate(server, fixture.state_path, "reviewer-a")

    rejected = server.call_tool(
        "sprintengine.gate.verdict",
        verdict_payload(fixture.state_path, "reviewer-a", summary="x" * (GATE_VERDICT_SUMMARY_LIMIT + 1)),
        actor("reviewer-a", "code_reviewer"),
    )

    assert rejected["ok"] is False
    assert str(GATE_VERDICT_SUMMARY_LIMIT) in rejected["error"]["message"]
    gate = get_task(read_state(fixture.state_path), "T1")["qualityGates"][0]
    assert gate["status"] == "in_progress"
    assert gate["attempts"][-1]["status"] == "in_progress"

    accepted = server.call_tool(
        "sprintengine.gate.verdict",
        verdict_payload(fixture.state_path, "reviewer-a", summary="x" * GATE_VERDICT_SUMMARY_LIMIT),
        actor("reviewer-a", "code_reviewer"),
    )
    assert accepted["ok"] is True
    assert get_task(read_state(fixture.state_path), "T1")["qualityGates"][0]["status"] == "approved"


def test_oversized_required_action_rejected_before_mutation(tmp_path) -> None:
    fixture = create_team(tmp_path, "budget-required-action", [review_task_with_pending_gate()])
    server = make_server(tmp_path)
    claim_gate(server, fixture.state_path, "reviewer-a")

    rejected = server.call_tool(
        "sprintengine.gate.verdict",
        verdict_payload(
            fixture.state_path,
            "reviewer-a",
            verdict="changes_requested",
            requiredAction=["fix " + "y" * REQUIRED_ACTION_LIMIT],
        ),
        actor("reviewer-a", "code_reviewer"),
    )

    assert rejected["ok"] is False
    assert str(REQUIRED_ACTION_LIMIT) in rejected["error"]["message"]
    persisted = get_task(read_state(fixture.state_path), "T1")
    assert persisted["status"] == "review"
    assert persisted["qualityGates"][0]["status"] == "in_progress"
    assert not persisted.get("comments")

    accepted = server.call_tool(
        "sprintengine.gate.verdict",
        verdict_payload(
            fixture.state_path,
            "reviewer-a",
            verdict="changes_requested",
            requiredAction=["src/a.ts — null deref — guard the lookup"],
        ),
        actor("reviewer-a", "code_reviewer"),
    )
    assert accepted["ok"] is True
    assert get_task(read_state(fixture.state_path), "T1")["status"] == "changes_requested"


def test_oversized_publish_summary_rejected_before_mutation(tmp_path) -> None:
    record = task("T1", "Implement feature", "developer", status="in_progress", owner="developer-a")
    fixture = create_team(tmp_path, "budget-publish-summary", [record])
    server = make_server(tmp_path)

    rejected = server.call_tool(
        "sprintengine.task.publish",
        {
            "statePath": str(fixture.state_path),
            "taskId": "T1",
            "id": "developer-a",
            "summary": "x" * (PUBLISH_SUMMARY_LIMIT + 1),
        },
        actor("developer-a", "developer"),
    )

    assert rejected["ok"] is False
    assert str(PUBLISH_SUMMARY_LIMIT) in rejected["error"]["message"]
    persisted = get_task(read_state(fixture.state_path), "T1")
    assert persisted["status"] == "in_progress"
    assert not persisted.get("comments")

    accepted = server.call_tool(
        "sprintengine.task.publish",
        {"statePath": str(fixture.state_path), "taskId": "T1", "id": "developer-a", "summary": "Done."},
        actor("developer-a", "developer"),
    )
    assert accepted["ok"] is True


def test_budget_limits_are_visible_in_tool_schemas() -> None:
    verdict_properties = TOOL_SCHEMAS["sprintengine.gate.verdict"]["properties"]
    assert verdict_properties["summary"]["maxLength"] == GATE_VERDICT_SUMMARY_LIMIT
    assert verdict_properties["requiredAction"]["items"]["maxLength"] == REQUIRED_ACTION_LIMIT
    publish_properties = TOOL_SCHEMAS["sprintengine.task.publish"]["properties"]
    assert publish_properties["summary"]["maxLength"] == PUBLISH_SUMMARY_LIMIT


PROMPT_BYTE_CEILINGS = {
    "architect.md": 22_000,
    "code_reviewer.md": 12_000,
    "cross_platform.md": 12_000,
    "developer.md": 12_000,
    "frontend.md": 12_000,
    "performance.md": 12_000,
    "product.md": 12_000,
    "production_readiness_reviewer.md": 13_000,
    "security.md": 12_000,
    "spec_reviewer.md": 12_000,
    "tester.md": 12_000,
}

SKILL_BYTE_CEILINGS = {
    "sprintengine_workflow": 4_000,
    "sprintengine_gate_feedback": 4_000,
    "sprintengine_publish_feedback": 4_000,
    "sprintengine_architect_workflow": 4_000,
}


def test_prompt_sources_stay_within_byte_ceilings() -> None:
    prompts_dir = REPO_ROOT / ".agents" / "skills" / "sprintengine" / "prompts"
    for name, ceiling in PROMPT_BYTE_CEILINGS.items():
        size = (prompts_dir / name).stat().st_size
        assert size <= ceiling, f"{name} is {size} bytes (ceiling {ceiling}); trim before growing the prompt"
    listed = {path.name for path in prompts_dir.glob("*.md")}
    assert listed == set(PROMPT_BYTE_CEILINGS), "role prompt added/removed — update PROMPT_BYTE_CEILINGS"

    skills_dir = REPO_ROOT / "resources" / "sprintengine" / "skills"
    for skill_id, ceiling in SKILL_BYTE_CEILINGS.items():
        size = (skills_dir / skill_id / "SKILL.md").stat().st_size
        assert size <= ceiling, f"{skill_id} is {size} bytes (ceiling {ceiling}); trim before growing the skill"
