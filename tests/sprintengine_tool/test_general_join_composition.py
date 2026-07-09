"""Soulless `general` join composition.

A General has no role-personality Soul, but it must still carry the full Sprint
Engine quality bar: the universal norm + Multicode product skills every agent
receives, plus the full-loop orchestration skill. These tests guard the
dropped-universal-norms bug — the manifest-less `general` role used to fall
through the no-soul fallback and silently lose half the norms — and confirm the
architect/specialist composition is untouched.
"""

from __future__ import annotations

from helpers import create_team, task
from sprintengine_core.skill_layers import (
    MULTICODE_LAYER_SKILLS,
    SPRINTENGINE_GENERAL_WORKFLOW_SKILL,
    SPRINTENGINE_NORM_SKILLS,
)
from sprintengine_core.tool.prompts import load_general_soul_prompt, load_prompt, load_soul_prompt
from sprintengine_mcp import SprintEngineMcpServer

# The universal layer a General must carry (acceptance: norms + orchestration).
UNIVERSAL_NORM_SKILLS = (*MULTICODE_LAYER_SKILLS, *SPRINTENGINE_NORM_SKILLS)


def actor(agent_id: str, role: str) -> dict[str, object]:
    return {"id": agent_id, "role": role, "mcpAuthorized": True}


def join_prompt(server: SprintEngineMcpServer, state_path, role: str, agent_id: str) -> str:
    result = server.call_tool(
        "sprintengine.agent.join",
        {"statePath": str(state_path), "role": role, "agentId": agent_id},
        actor(agent_id, role),
    )
    assert result["ok"] is True, result.get("error")
    return result["result"]["prompt"]


def test_general_join_carries_norms_and_orchestration_but_no_role_soul(tmp_path) -> None:
    fixture = create_team(tmp_path, "gen-join", [task("T1", "Work", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    prompt = join_prompt(server, fixture.state_path, "general", "general-1")

    # Every universal norm + the orchestration skill is present (the bug guard).
    for skill_id in (*UNIVERSAL_NORM_SKILLS, SPRINTENGINE_GENERAL_WORKFLOW_SKILL):
        assert f'<skill name="{skill_id}">' in prompt, skill_id

    # No role-personality Soul: a specialist's identity skill must not leak in.
    for role_skill in ("developer", "architect", "tester", "security"):
        assert f'<skill name="{role_skill}">' not in prompt, role_skill

    # The orchestration skill's two reinforced rules are present.
    assert "before claiming new ready work" in prompt
    assert "keep the team exactly as the user set it" in prompt


def test_general_join_succeeds_without_a_role_manifest(tmp_path) -> None:
    fixture = create_team(tmp_path, "gen-join-manifest", [task("T1", "Work", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    result = server.call_tool(
        "sprintengine.agent.join",
        {"statePath": str(fixture.state_path), "role": "general", "agentId": "general-1"},
        actor("general-1", "general"),
    )
    assert result["ok"] is True, result.get("error")
    manifest = result["result"]["roleManifest"]
    assert manifest["id"] == "general"
    # `general` composes its brief from SPRINTENGINE_GENERAL_SKILLS, not a manifest,
    # so it carries no directive packs and is not a sweep role. The v2 keys are still
    # present so the payload shape matches a real role manifest.
    assert manifest["directives"] == {}
    assert manifest["sweep"] is None
    assert "soul" not in manifest and "capabilities" not in manifest
    assert result["result"]["role"] == "general"


def test_load_general_soul_prompt_includes_every_universal_norm() -> None:
    prompt = load_general_soul_prompt()
    assert prompt is not None
    for skill_id in (*UNIVERSAL_NORM_SKILLS, SPRINTENGINE_GENERAL_WORKFLOW_SKILL):
        assert f'<skill name="{skill_id}">' in prompt, skill_id


def test_general_prompt_chokepoints_keep_the_norms() -> None:
    """The CLI cmd_join / plan-review composition path runs through
    load_soul_prompt -> load_prompt. For `general` that chokepoint must render the
    soulless layer, not the no-soul fallback that drops half the norms."""
    soul = load_soul_prompt("general")
    assert soul is not None
    for skill_id in (*UNIVERSAL_NORM_SKILLS, SPRINTENGINE_GENERAL_WORKFLOW_SKILL):
        assert f'<skill name="{skill_id}">' in soul, skill_id

    prompt = load_prompt("general")
    for skill_id in (*UNIVERSAL_NORM_SKILLS, SPRINTENGINE_GENERAL_WORKFLOW_SKILL):
        assert f'<skill name="{skill_id}">' in prompt, skill_id
    # Soul present means compose_prompt took the soul branch, not the degraded one.
    assert "# Soul Personality And Quality Bar" in prompt


def test_specialist_join_composition_is_unchanged(tmp_path) -> None:
    """The general branch must not alter specialist composition: a developer
    still renders its role soul + the same norms, and never the General
    orchestration skill."""
    fixture = create_team(tmp_path, "spec-join", [task("T1", "Work", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    prompt = join_prompt(server, fixture.state_path, "developer", "developer-1")

    assert '<skill name="developer">' in prompt  # role-personality soul present
    for skill_id in UNIVERSAL_NORM_SKILLS:
        assert f'<skill name="{skill_id}">' in prompt, skill_id
    assert f'<skill name="{SPRINTENGINE_GENERAL_WORKFLOW_SKILL}">' not in prompt
