"""Roleless join composition.

An agent with no role has no role-personality Soul, but it must still carry the
full Sprint Engine quality bar: the universal norm skills every agent receives,
plus the full-loop orchestration skill. These tests guard the
dropped-universal-norms bug — a manifest-less agent used to fall through the
no-soul fallback and silently lose half the norms — and confirm the
architect/specialist composition is untouched.

The Multicode product layer (`multicode_backlog`, `workspace_knowledge`) is
gated at compose time per run (backlog-sourced / knowledge root configured);
its gate behavior is covered here and in test_layer_skill_gating.py.
"""

from __future__ import annotations

from helpers import create_team, read_state, task, write_state
from sprintengine_core.skill_layers import (
    SPRINTENGINE_NORM_SKILLS,
    SPRINTENGINE_ROLELESS_WORKFLOW_SKILL,
)
from sprintengine_core.tool.prompts import load_prompt, load_roleless_soul_prompt, load_soul_prompt
from sprintengine_mcp import SprintEngineMcpServer

# The universal layer a roleless agent must always carry (acceptance: norms + orchestration).
UNIVERSAL_NORM_SKILLS = SPRINTENGINE_NORM_SKILLS


def mark_backlog_sourced(state_path) -> None:
    state = read_state(state_path)
    state["source"] = {"kind": "markdown", "origin": "reference", "originalPath": "backlog/example.md", "path": "backlog/example.md"}
    write_state(state_path, state)


def actor(agent_id: str, role: str = "") -> dict[str, object]:
    return {"id": agent_id, "role": role, "mcpAuthorized": True}


def join_prompt(server: SprintEngineMcpServer, state_path, role: str, agent_id: str) -> str:
    payload: dict[str, object] = {"statePath": str(state_path), "agentId": agent_id}
    if role:
        payload["role"] = role
    result = server.call_tool("sprintengine.agent.join", payload, actor(agent_id, role))
    assert result["ok"] is True, result.get("error")
    return result["result"]["prompt"]


def test_roleless_join_carries_norms_and_orchestration_but_no_role_soul(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("MULTICODE_KNOWLEDGE_ROOT", str(tmp_path / "knowledge"))
    fixture = create_team(tmp_path, "roleless-join", [task("T1", "Work", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    prompt = join_prompt(server, fixture.state_path, "", "agent-1")

    # Every universal norm + the orchestration skill is present (the bug guard).
    for skill_id in (*UNIVERSAL_NORM_SKILLS, SPRINTENGINE_ROLELESS_WORKFLOW_SKILL):
        assert f'<skill name="{skill_id}">' in prompt, skill_id

    # Product layer gates: a configured knowledge root injects workspace_knowledge;
    # a run that is not backlog-sourced pays nothing for multicode_backlog.
    assert '<skill name="workspace_knowledge">' in prompt
    assert '<skill name="multicode_backlog">' not in prompt

    # No role-personality Soul: a specialist's identity skill must not leak in.
    for role_skill in ("developer", "architect", "tester", "security"):
        assert f'<skill name="{role_skill}">' not in prompt, role_skill

    # The orchestration skill's two reinforced rules are present.
    assert "before claiming new ready work" in prompt
    assert "keep the team exactly as the user set it" in prompt

    # And it invents no persona to replace the deleted role (MC-2057).
    assert "general" not in prompt.lower()


def test_join_gates_product_layer_by_run_source_and_knowledge_root(tmp_path, monkeypatch) -> None:
    monkeypatch.delenv("MULTICODE_KNOWLEDGE_ROOT", raising=False)
    monkeypatch.delenv("MULTICODE_MEMORY_ROOT", raising=False)
    fixture = create_team(tmp_path, "gated-join", [task("T1", "Work", "developer")])
    mark_backlog_sourced(fixture.state_path)
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    prompt = join_prompt(server, fixture.state_path, "developer", "developer-1")

    # Backlog-sourced run injects the Backlog lifecycle skill; no knowledge root
    # configured means workspace_knowledge costs nothing.
    assert '<skill name="multicode_backlog">' in prompt
    assert '<skill name="workspace_knowledge">' not in prompt
    for skill_id in UNIVERSAL_NORM_SKILLS:
        assert f'<skill name="{skill_id}">' in prompt, skill_id


def test_roleless_join_reports_no_role_and_no_manifest(tmp_path) -> None:
    fixture = create_team(tmp_path, "roleless-join-manifest", [task("T1", "Work", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    result = server.call_tool(
        "sprintengine.agent.join",
        {"statePath": str(fixture.state_path), "agentId": "agent-1"},
        actor("agent-1"),
    )
    assert result["ok"] is True, result.get("error")
    # Absent is an OMITTED key, never '' and never a stand-in manifest (MC-2057).
    assert "role" not in result["result"]
    assert "roleManifest" not in result["result"]
    assert "role" not in result["result"]["promptContext"]


def test_a_named_role_must_still_resolve(tmp_path) -> None:
    """Absent is legal, wrong is not: the deleted `general` is now unknown."""
    fixture = create_team(tmp_path, "roleless-join-unknown", [task("T1", "Work", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    result = server.call_tool(
        "sprintengine.agent.join",
        {"statePath": str(fixture.state_path), "role": "general", "agentId": "general-1"},
        actor("general-1", "general"),
    )
    assert result["ok"] is False
    assert result["error"]["code"] == "unknown_role"


def test_load_roleless_soul_prompt_includes_every_universal_norm() -> None:
    # Gates forced open: the full layer renders regardless of this process env.
    prompt = load_roleless_soul_prompt(backlog_sourced=True, knowledge_root_configured=True)
    assert prompt is not None
    for skill_id in (
        *UNIVERSAL_NORM_SKILLS,
        "multicode_backlog",
        "workspace_knowledge",
        SPRINTENGINE_ROLELESS_WORKFLOW_SKILL,
    ):
        assert f'<skill name="{skill_id}">' in prompt, skill_id


def test_roleless_prompt_chokepoints_keep_the_norms() -> None:
    """The CLI cmd_join / plan-review composition path runs through
    load_soul_prompt -> load_prompt. With no role that chokepoint must render the
    roleless layer, not the no-soul fallback that drops half the norms."""
    soul = load_soul_prompt(None, knowledge_root_configured=True)
    assert soul is not None
    for skill_id in (*UNIVERSAL_NORM_SKILLS, SPRINTENGINE_ROLELESS_WORKFLOW_SKILL):
        assert f'<skill name="{skill_id}">' in soul, skill_id

    prompt = load_prompt(None, knowledge_root_configured=True)
    for skill_id in (*UNIVERSAL_NORM_SKILLS, SPRINTENGINE_ROLELESS_WORKFLOW_SKILL):
        assert f'<skill name="{skill_id}">' in prompt, skill_id
    # Soul present means compose_prompt took the soul branch, not the degraded one.
    assert "# Soul Personality And Quality Bar" in prompt


def test_specialist_join_composition_is_unchanged(tmp_path, monkeypatch) -> None:
    """The roleless branch must not alter specialist composition: a developer
    still renders its role soul + the same norms, and never the roleless
    orchestration skill."""
    monkeypatch.setenv("MULTICODE_KNOWLEDGE_ROOT", str(tmp_path / "knowledge"))
    fixture = create_team(tmp_path, "spec-join", [task("T1", "Work", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    prompt = join_prompt(server, fixture.state_path, "developer", "developer-1")

    assert '<skill name="developer">' in prompt  # role-personality soul present
    for skill_id in (*UNIVERSAL_NORM_SKILLS, "workspace_knowledge"):
        assert f'<skill name="{skill_id}">' in prompt, skill_id
    assert f'<skill name="{SPRINTENGINE_ROLELESS_WORKFLOW_SKILL}">' not in prompt
