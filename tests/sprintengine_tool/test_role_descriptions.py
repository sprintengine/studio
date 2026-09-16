"""Role capabilities are prose (MC-1831).

A role manifest carries no capability flags. What a role can do — and when a
sprint should staff it — lives in one `description` field, which the architect
reads verbatim while planning. Nothing in the engine derives behaviour from its
text, so these tests pin the two things that must hold: the description reaches
the architect intact, and a manifest that carries nothing but id/label/
description/directives is a first-class, plannable role.
"""

from __future__ import annotations

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
    """A third-party role skill plans on its description alone."""
    workspace = tmp_path / "minimal-ws"
    write_workspace_role(
        workspace,
        "compliance",
        label="Compliance",
        description="Checks regulated data handling. Staff it when the run touches personal data.",
        body="# compliance\n\nYou check regulated data handling.",
    )

    discovery = discover_role_registry(workspace_root=workspace)
    role = discovery.get_role("compliance")
    assert role.description.startswith("Checks regulated data handling.")

    fixture = create_workspace_team(tmp_path, "minimal-ws", "minimal-role", [])
    staff(fixture.state_path, ["architect", "compliance"])
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


def test_a_role_skill_without_a_description_still_loads(tmp_path) -> None:
    workspace = tmp_path / "legacy-ws"
    skill_dir = workspace / ".claude" / "skills" / "legacy-marketer"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: legacy-marketer\nmetadata:\n  sprintengine-role: legacy_marketer\n  role-label: Marketer\n---\n\nYou own positioning.\n",
        encoding="utf-8",
    )

    discovery = discover_role_registry(workspace_root=workspace)
    role = discovery.get_role("legacy_marketer")
    assert role.description is None
    assert role.label == "Marketer"
