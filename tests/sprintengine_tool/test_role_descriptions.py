"""Role capabilities are prose (MC-1831).

A role manifest carries no capability flags. What a role can do — and when a
sprint should staff it — lives in one `description` field, which the architect
reads verbatim while planning. Nothing in the engine derives behaviour from its
text, so these tests pin the two things that must hold: the description reaches
the architect intact, and a manifest that carries nothing but id/label/
description/directives is a first-class, plannable role.
"""

from __future__ import annotations

import json

from helpers import create_workspace_team, read_state, task, write_state, write_workspace_role
from sprintengine_core.role_registry import discover_role_registry
from sprintengine_mcp import SprintEngineMcpServer

MARKETER_DESCRIPTION = (
    "Owns positioning, launch copy, and the words on every user-facing surface. "
    "Staff this role when the run ships something a customer reads."
)


def actor(agent_id: str, role: str) -> dict[str, object]:
    return {"id": agent_id, "role": role, "mcpAuthorized": True}


def staff(state_path, roles: list[str]) -> None:
    state = read_state(state_path)
    state["configuredRoles"] = roles
    write_state(state_path, state)


def join_prompt(server: SprintEngineMcpServer, state_path, workspace, role: str, agent_id: str) -> str:
    result = server.call_tool(
        "sprintengine.agent.join",
        {"statePath": str(state_path), "role": role, "agentId": agent_id, "workspaceRoot": str(workspace)},
        actor(agent_id, role),
    )
    assert result["ok"] is True, result.get("error")
    return result["result"]["prompt"]


def test_architect_join_prompt_renders_each_staffed_role_description_verbatim(tmp_path) -> None:
    workspace = tmp_path / "roles-ws"
    write_workspace_role(workspace, "marketer", label="Marketer", description=MARKETER_DESCRIPTION)
    write_workspace_role(workspace, "architect", label="Architect", description="Plans the run. Staff it always.")
    fixture = create_workspace_team(tmp_path, "roles-ws", "role-desc", [task("T1", "Work", "marketer")])
    staff(fixture.state_path, ["architect", "marketer"])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    prompt = join_prompt(server, fixture.state_path, workspace, "architect", "architect-1")

    assert "# Roles On This Run" in prompt
    # Verbatim: the architect plans from the author's words, not a summary of them.
    assert MARKETER_DESCRIPTION in prompt
    assert "**Marketer** (`marketer`)" in prompt


def test_only_the_planning_role_carries_the_roles_section(tmp_path) -> None:
    workspace = tmp_path / "roles-ws"
    write_workspace_role(workspace, "marketer", label="Marketer", description=MARKETER_DESCRIPTION)
    fixture = create_workspace_team(tmp_path, "roles-ws", "role-desc-worker", [task("T1", "Work", "marketer")])
    staff(fixture.state_path, ["architect", "marketer"])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    prompt = join_prompt(server, fixture.state_path, workspace, "marketer", "marketer-1")

    assert "# Roles On This Run" not in prompt


def test_a_role_with_only_id_label_description_and_skills_is_plannable(tmp_path, monkeypatch) -> None:
    """Zero capability JSON: a third-party role plans on its description alone."""
    workspace = tmp_path / "minimal-ws"
    roles_dir = workspace / ".sprintengine" / "roles"
    skill_dir = workspace / ".sprintengine" / "skills" / "compliance"
    roles_dir.mkdir(parents=True, exist_ok=True)
    skill_dir.mkdir(parents=True, exist_ok=True)
    (roles_dir / "compliance.json").write_text(
        json.dumps(
            {
                "id": "compliance",
                "label": "Compliance",
                "description": "Checks regulated data handling. Staff it when the run touches personal data.",
                "directives": {"implement": [{"skill": "compliance"}]},
            }
        ),
        encoding="utf-8",
    )
    (skill_dir / "SKILL.md").write_text("# compliance\n\nYou check regulated data handling.", encoding="utf-8")

    discovery = discover_role_registry(workspace_root=workspace, plugin_roots=[], user_root=tmp_path / "no-user")
    role = discovery.get_role("compliance")
    assert role.description.startswith("Checks regulated data handling.")
    assert not [warning for warning in discovery.warnings if warning.role_id == "compliance"]

    fixture = create_workspace_team(tmp_path, "minimal-ws", "minimal-role", [])
    staff(fixture.state_path, ["architect", "compliance"])
    # Role validation discovers the workspace layer from the process cwd, which for
    # a managed MCP server is the workspace root.
    monkeypatch.chdir(workspace)
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])

    added = server.call_tool(
        "sprintengine.plan.add_task",
        {
            "statePath": str(fixture.state_path),
            "workspaceRoot": str(workspace),
            "title": "Audit the export path",
            "role": "compliance",
        },
        actor("architect", "architect"),
    )
    assert added["ok"] is True, added.get("error")


def test_a_manifest_still_carrying_summary_loads_and_is_warned_about(tmp_path) -> None:
    """An installed pack predating the rename must keep staffing runs."""
    workspace = tmp_path / "legacy-ws"
    roles_dir = workspace / ".sprintengine" / "roles"
    skill_dir = workspace / ".sprintengine" / "skills" / "legacy_marketer"
    roles_dir.mkdir(parents=True, exist_ok=True)
    skill_dir.mkdir(parents=True, exist_ok=True)
    (roles_dir / "legacy_marketer.json").write_text(
        json.dumps(
            {
                "id": "legacy_marketer",
                "label": "Marketer",
                "summary": "Owns positioning.",
                "directives": {"implement": [{"skill": "legacy_marketer"}]},
            }
        ),
        encoding="utf-8",
    )
    (skill_dir / "SKILL.md").write_text("# legacy_marketer\n\nYou own positioning.", encoding="utf-8")

    discovery = discover_role_registry(workspace_root=workspace, plugin_roots=[], user_root=tmp_path / "no-user")

    role = discovery.get_role("legacy_marketer")
    # The old value is not read as the new field — the author renames it and writes
    # the fuller text `description` asks for.
    assert role.description is None
    renames = [warning for warning in discovery.warnings if warning.code == "renamed_manifest_key"]
    assert len(renames) == 1
    assert "'summary' was renamed to 'description'" in renames[0].message
