from __future__ import annotations

from pathlib import Path

import pytest

from sprintengine_core.role_registry import (
    HARNESS_DIRECTORIES,
    MissingRoleError,
    RoleSkillRegistry,
    SOUL_LEGEND,
    SoulRenderError,
    discover_role_registry,
    normalize_role_id,
)
from workflow_roles import WORKFLOW_ROLE_IDS, install_workflow_roles, write_workspace_role


def test_discover_role_registry_takes_a_workspace_root_and_nothing_else() -> None:
    assert discover_role_registry.__code__.co_varnames[: discover_role_registry.__code__.co_argcount] == ()
    # Keyword-only: workspace_root. No plugin_roots / user_root / bundled_root.
    assert discover_role_registry.__kwdefaults__ == {"workspace_root": None}


def test_sixteen_roles_from_claude_skills(tmp_path: Path) -> None:
    workspace = install_workflow_roles(tmp_path / "workspace")
    discovery = discover_role_registry(workspace_root=workspace)
    assert set(discovery.roles) == WORKFLOW_ROLE_IDS
    for role_id, entry in discovery.roles.items():
        assert ".claude/skills" in str(entry.source.path).replace("\\", "/")
        assert entry.source.layer.name == "workspace"


def test_sixteen_roles_from_agents_skills_when_claude_is_empty(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    dest = workspace / ".agents" / "skills"
    dest.parent.mkdir(parents=True)
    install_workflow_roles(tmp_path / "seed")
    seed = tmp_path / "seed" / ".claude" / "skills"
    dest.mkdir(parents=True)
    for child in seed.iterdir():
        child.rename(dest / child.name)
    discovery = discover_role_registry(workspace_root=workspace)
    assert set(discovery.roles) == WORKFLOW_ROLE_IDS
    tester = discovery.role_entry("tester")
    assert ".agents/skills" in str(tester.source.path).replace("\\", "/")


def test_first_harness_wins_and_roles_list_reports_the_claude_path(tmp_path: Path) -> None:
    workspace = install_workflow_roles(tmp_path / "workspace")
    write_workspace_role(
        workspace,
        "architect",
        label="Agents Architect",
        body="Agents copy of architect.",
        harness=".agents",
    )
    discovery = discover_role_registry(workspace_root=workspace)
    entry = discovery.role_entry("architect")
    assert entry.source.layer.name == "workspace"
    assert ".claude/skills" in str(entry.source.path).replace("\\", "/")
    rendered = discovery.render_soul("architect", workspace_root=workspace)
    assert "Agents copy of architect." not in rendered.content


def test_unknown_role_names_the_known_set_and_never_falls_back(tmp_path: Path) -> None:
    workspace = install_workflow_roles(tmp_path / "workspace")
    discovery = discover_role_registry(workspace_root=workspace)
    with pytest.raises(MissingRoleError) as exc_info:
        discovery.get_role("not-a-role")
    message = str(exc_info.value)
    assert "not-a-role" in message
    assert "architect" in message
    with pytest.raises(MissingRoleError) as alias_info:
        discovery.get_role("qa-test")
    alias_message = str(alias_info.value)
    assert "Unknown role 'qa-test'" in alias_message
    assert "no skill declaring it is installed in this workspace" in alias_message
    assert "workflow-roles" in alias_message
    assert "skills folder" in alias_message


def test_hyphen_and_underscore_are_the_same_name(tmp_path: Path) -> None:
    workspace = install_workflow_roles(tmp_path / "workspace")
    discovery = discover_role_registry(workspace_root=workspace)
    assert discovery.get_role("spec_reviewer").id == "spec_reviewer"
    assert discovery.get_role("spec-reviewer").id == "spec_reviewer"


def test_a_skill_without_role_metadata_is_not_a_role(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    skill_dir = workspace / ".claude" / "skills" / "frontend-design"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: frontend-design\ndescription: A craft skill.\n---\n\nNot a role.\n",
        encoding="utf-8",
    )
    write_workspace_role(workspace, "marketer", label="Marketer")
    discovery = discover_role_registry(workspace_root=workspace)
    assert "frontend_design" not in discovery.roles
    assert "marketer" in discovery.roles
    assert "frontend_design" in discovery.skills


def test_two_workspaces_from_one_hub_process_resolve_independently(tmp_path: Path) -> None:
    workspace_a = tmp_path / "alpha"
    workspace_b = tmp_path / "beta"
    write_workspace_role(workspace_a, "alpha_writer", label="Alpha Writer", body="Alpha body.")
    write_workspace_role(workspace_b, "beta_writer", label="Beta Writer", body="Beta body.")

    from sprintengine_mcp import SprintEngineMcpServer

    server = SprintEngineMcpServer(allowed_roots=[tmp_path])
    actor = {"id": "workspace-user", "role": "user", "mcpAuthorized": True}

    listed_a = server.call_tool(
        "sprintengine.roles.list",
        {"workspaceRoot": str(workspace_a)},
        actor,
    )
    listed_b = server.call_tool(
        "sprintengine.roles.list",
        {"workspaceRoot": str(workspace_b)},
        actor,
    )
    ids_a = {role["id"] for role in listed_a["result"]["roles"]}
    ids_b = {role["id"] for role in listed_b["result"]["roles"]}
    assert "alpha_writer" in ids_a
    assert "alpha_writer" not in ids_b
    assert "beta_writer" in ids_b
    assert "beta_writer" not in ids_a
    alpha_source = next(role["source"]["path"] for role in listed_a["result"]["roles"] if role["id"] == "alpha_writer")
    assert str(workspace_a) in alpha_source


def test_harness_walk_order_matches_the_spec() -> None:
    assert HARNESS_DIRECTORIES == (
        ".claude",
        ".agents",
        ".codex",
        ".cursor",
        ".gemini",
        ".opencode",
        ".grok",
    )


def test_bundled_default_resolves_without_a_workspace_install() -> None:
    discovery = discover_role_registry(workspace_root=Path("/unused/workspace"))
    assert set(discovery.roles) >= WORKFLOW_ROLE_IDS
    tester = discovery.role_entry("tester")
    assert tester.source.layer.name == "bundled"
    assert "workflow-roles/skills" in str(tester.source.path).replace("\\", "/")


def test_rendered_soul_strips_frontmatter_and_wraps_the_body(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    write_workspace_role(
        workspace,
        "developer",
        label="Developer",
        body="First body for {{role}}.",
    )
    rendered = RoleSkillRegistry(workspace_root=workspace).discover().render_soul(
        "developer", workspace_root=workspace, run_id="run-123"
    )
    assert rendered.content.startswith(SOUL_LEGEND)
    assert '<skill name="developer">\nFirst body for developer.\n</skill>' in rendered.content
    assert "---" not in rendered.content.split("<skill", 1)[1]
    assert rendered.content.count("<soul-legend>") == 1


def test_rendered_soul_substitutes_allow_list_only(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    write_workspace_role(
        workspace,
        "marketer",
        label="Growth Marketer",
        body=(
            "Role {{ role }} / {{role_label}} / {{workspace_root}} / {{run_id}}\n"
            "Keep unsupported {{env.HOME}} and {{ role | upper }}."
        ),
    )
    rendered = RoleSkillRegistry(workspace_root=workspace).discover().render_soul(
        "marketer", workspace_root=workspace, run_id="run-456"
    )
    assert f"Role marketer / Growth Marketer / {workspace} / run-456" in rendered.content
    assert "{{env.HOME}}" in rendered.content
    assert "{{ role | upper }}" in rendered.content
    unsupported = [warning for warning in rendered.warnings if warning.code == "unsupported_template_variable"]
    assert [warning.role_id for warning in unsupported] == ["marketer", "marketer"]


def test_empty_skill_body_is_skipped_with_a_warning(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    skill_dir = workspace / ".claude" / "skills" / "empty-body"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: empty-body\nmetadata:\n  sprintengine-role: empty_body\n  role-label: Empty\n---\n",
        encoding="utf-8",
    )
    discovery = RoleSkillRegistry(workspace_root=workspace).discover()
    assert "empty_body" not in discovery.roles
    assert any(warning.code == "broken_skill_document" for warning in discovery.warnings)


def test_normalize_maps_hyphen_to_underscore() -> None:
    assert normalize_role_id("spec-reviewer") == "spec_reviewer"
    assert normalize_role_id("UI-UX-Reviewer") == "ui_ux_reviewer"


def test_souls_get_resolves_workspace_role_skill(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    workspace = write_workspace_role(
        tmp_path / "workspace",
        "marketer",
        label="Marketer",
        body="Launch campaigns.",
    ).parents[3]
    monkeypatch.chdir(workspace)
    from souls.registry import get_soul, render_soul

    soul = get_soul("marketer")
    assert soul.role == "marketer"
    assert soul.label == "Marketer"
    content = render_soul("marketer")
    assert "Launch campaigns." in content
