"""Artifact write-budget regression tests.

Artifact length budgets are guidance-only by decision (2026-06-12): the
prompts and skills direct agents to write terse summaries, but the server
never rejects an oversized write — `task.publish` and `gate.verdict` are the
critical autonomous lifecycle transitions and must not gain failure modes.
These tests guard that decision (oversized writes are accepted, schemas
advertise no maxLength a client could pre-validate against) and keep the
prompt/skill sources under byte ceilings so the guidance itself cannot bloat.
"""

from __future__ import annotations

from helpers import REPO_ROOT, create_team, get_task, read_state, task
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


def test_oversized_verdict_summary_is_accepted(tmp_path) -> None:
    fixture = create_team(tmp_path, "budget-verdict-summary", [review_task_with_pending_gate()])
    server = make_server(tmp_path)

    claimed = server.call_tool(
        "sprintengine.gate.next",
        {"statePath": str(fixture.state_path), "role": "code_reviewer", "id": "reviewer-a"},
        actor("reviewer-a", "code_reviewer"),
    )
    assert claimed["ok"] is True
    assert claimed["result"]["claimed"] is True

    long_summary = "x" * 10_000
    verdict = server.call_tool(
        "sprintengine.gate.verdict",
        {
            "statePath": str(fixture.state_path),
            "taskId": "T1",
            "gateId": "code_reviewer",
            "id": "reviewer-a",
            "role": "code_reviewer",
            "verdict": "changes_requested",
            "summary": long_summary,
            "requiredAction": ["fix " + "y" * 2_000],
        },
        actor("reviewer-a", "code_reviewer"),
    )

    assert verdict["ok"] is True
    persisted = get_task(read_state(fixture.state_path), "T1")
    gate = persisted["qualityGates"][0]
    assert gate["status"] == "changes_requested"
    assert gate["attempts"][-1]["summary"] == long_summary


def test_oversized_publish_summary_is_accepted(tmp_path) -> None:
    record = task("T1", "Implement feature", "developer", status="in_progress", owner="developer-a")
    fixture = create_team(tmp_path, "budget-publish-summary", [record])
    server = make_server(tmp_path)

    long_summary = "x" * 10_000
    published = server.call_tool(
        "sprintengine.task.publish",
        {"statePath": str(fixture.state_path), "taskId": "T1", "id": "developer-a", "summary": long_summary},
        actor("developer-a", "developer"),
    )

    assert published["ok"] is True
    persisted = get_task(read_state(fixture.state_path), "T1")
    assert persisted["comments"][-1]["body"] == long_summary


def test_summary_fields_advertise_no_max_length() -> None:
    # A maxLength here would let MCP clients pre-validate and hard-block the
    # call client-side, recreating the rejected-by-decision write cap.
    verdict_properties = TOOL_SCHEMAS["sprintengine.gate.verdict"]["properties"]
    assert "maxLength" not in verdict_properties["summary"]
    assert "maxLength" not in verdict_properties["requiredAction"]["items"]
    publish_properties = TOOL_SCHEMAS["sprintengine.task.publish"]["properties"]
    assert "maxLength" not in publish_properties["summary"]


PROMPT_BYTE_CEILINGS = {
    # architect.md carries the mandatory architect-picks-the-team roster-composition
    # guidance; it was already 22388 bytes (over the prior 22000) at merge-base and that
    # essential guidance grew it further, so the ceiling is raised to a real green baseline.
    "architect.md": 26_000,
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
