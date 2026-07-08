"""Artifact write-budget regression tests.

Artifact length budgets are guidance-only by decision (2026-06-12): the
prompts and skills direct agents to write terse summaries, but the server
never rejects an oversized write — `task.publish` and `task.advance` are the
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


def reviewing_task() -> dict[str, object]:
    """A published task sitting in its review phase, still owned by its implementer."""
    record = task("T1", "Implement feature", "developer", status="review", owner="developer-a")
    record["evidence"]["summary"] = "Working summary"
    record["startedAt"] = "2026-07-08T00:00:00Z"
    return record


def test_oversized_advance_summary_is_accepted(tmp_path) -> None:
    fixture = create_team(tmp_path, "budget-advance-summary", [reviewing_task()])
    server = make_server(tmp_path)

    long_summary = "x" * 10_000
    advanced = server.call_tool(
        "sprintengine.task.advance",
        {
            "statePath": str(fixture.state_path),
            "taskId": "T1",
            "id": "developer-a",
            "phase": "review",
            "outcome": "pass_with_fixes",
            "summary": long_summary,
        },
        actor("developer-a", "developer"),
    )

    assert advanced["ok"] is True
    persisted = get_task(read_state(fixture.state_path), "T1")
    assert persisted["status"] == "done"
    assert persisted["comments"][-1]["body"] == long_summary


def test_oversized_escalation_question_is_accepted(tmp_path) -> None:
    # `escalate` is the other autonomous exit from a phase; an oversized question
    # or suggested resolution must park the task, never reject the transition.
    fixture = create_team(tmp_path, "budget-advance-escalate", [reviewing_task()])
    server = make_server(tmp_path)

    long_question = "why " * 3_000
    advanced = server.call_tool(
        "sprintengine.task.advance",
        {
            "statePath": str(fixture.state_path),
            "taskId": "T1",
            "id": "developer-a",
            "phase": "review",
            "outcome": "escalate",
            "summary": "Blocked on a product call.",
            "needsInputKind": "user",
            "needsInputQuestion": long_question,
            "needsInputSuggestedResolution": "z" * 5_000,
        },
        actor("developer-a", "developer"),
    )

    assert advanced["ok"] is True
    persisted = get_task(read_state(fixture.state_path), "T1")
    assert persisted["status"] == "needs_input"
    assert persisted["needsInput"]["question"] == long_question.strip()


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
    advance_properties = TOOL_SCHEMAS["sprintengine.task.advance"]["properties"]
    assert "maxLength" not in advance_properties["summary"]
    assert "maxLength" not in advance_properties["needsInputQuestion"]
    assert "maxLength" not in advance_properties["needsInputSuggestedResolution"]
    publish_properties = TOOL_SCHEMAS["sprintengine.task.publish"]["properties"]
    assert "maxLength" not in publish_properties["summary"]


PROMPT_BYTE_CEILINGS = {
    # Ceilings are ratcheted tight to the current green sizes: each one sits at the
    # next 250-byte step above the real file, so any growth has to be argued for
    # (and the ceiling re-ratcheted DOWN, never up). architect.md is the outlier by
    # content, not by slack — it carries the mandatory architect-picks-the-team
    # roster-composition guidance.
    "architect.md": 22_250,
    "cross_platform.md": 3_500,
    "developer.md": 3_000,
    "frontend.md": 4_750,
    "performance.md": 3_000,
    "product.md": 8_000,
    "production_readiness_reviewer.md": 6_000,
    "security.md": 3_000,
    "tester.md": 2_750,
}

SKILL_BYTE_CEILINGS = {
    # `sprintengine_gate_feedback` was deleted with the gate protocol (MC-1542); its
    # phase-walk guidance moved into `sprintengine_workflow`. Ceilings still only ever
    # ratchet DOWN — a consolidation is not a licence to grow the surviving file.
    "sprintengine_workflow": 4_000,
    "sprintengine_publish_feedback": 1_000,
    "sprintengine_architect_workflow": 750,
    # MC-1542: the shared review base pack every phase directive is composed from.
    "sprintengine_phase_review": 4_800,
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
