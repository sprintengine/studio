from __future__ import annotations

import json
from pathlib import Path

import pytest

from sprintengine_core.role_registry import RoleSkillRegistry, SoulRenderError, discover_role_registry


def write_role(root: Path, role_id: str, *, label: str | None = None, aliases: list[str] | None = None, soul: list[dict] | None = None) -> None:
    roles_dir = root / "roles"
    roles_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "id": role_id,
        "label": role_id.replace("_", " ").title() if label is None else label,
        "aliases": aliases or [],
        "soul": soul or [{"skill": role_id}],
    }
    (roles_dir / f"{role_id}.json").write_text(json.dumps(payload), encoding="utf-8")


def write_skill(root: Path, skill_id: str, body: str | None = None) -> None:
    skill_dir = root / "skills" / skill_id
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(body or f"# {skill_id}\n\nBody for {skill_id}.", encoding="utf-8")


def test_discovers_production_bundled_role_manifest_and_referenced_skill() -> None:
    discovery = discover_role_registry(workspace_root=Path("/unused/workspace"), user_root=Path("/unused/user"))

    role = discovery.get_role("qa-test")
    skills = discovery.referenced_skills("tester")

    assert role.id == "tester"
    assert discovery.role_entry("tester").source.layer.name == "bundled"
    assert [skill.id for skill in skills][:2] == ["tester", "project_relative_paths"]
    assert "production_reality_gate" in [skill.id for skill in skills]
    assert "sprintengine_workflow" in [skill.id for skill in skills]
    assert "principal QA engineer" in skills[0].body


def test_default_repo_discovery_excludes_validation_only_roles() -> None:
    discovery = discover_role_registry()

    assert "registry_probe" not in discovery.roles
    assert "registry_probe" not in discovery.skills
    assert "marketer" not in discovery.roles
    assert "marketer" not in discovery.skills


def test_layer_precedence_reports_winning_source_and_shadowed_entries(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    plugin = tmp_path / "plugin"
    user = tmp_path / "user"
    bundled = tmp_path / "bundled"
    write_role(workspace / ".sprintengine", "developer", label="Workspace Developer", aliases=["workspace-dev"])
    write_skill(workspace / ".sprintengine", "developer", "# Workspace\n")
    write_role(plugin, "developer", label="Plugin Developer")
    write_skill(plugin, "developer", "# Plugin\n")
    write_role(user / ".sprintengine", "developer", label="User Developer")
    write_skill(user / ".sprintengine", "developer", "# User\n")
    write_role(bundled, "developer", label="Bundled Developer")
    write_skill(bundled, "developer", "# Bundled\n")

    discovery = RoleSkillRegistry(
        workspace_root=workspace,
        plugin_roots=[plugin],
        user_root=user,
        bundled_root=bundled,
    ).discover()
    entry = discovery.role_entry("workspace-dev")
    skill_entry = discovery.skills["developer"]

    assert discovery.get_role("developer").label == "Workspace Developer"
    assert entry.source.layer.name == "workspace"
    assert [shadow.layer.name for shadow in entry.shadowed] == ["plugin:0", "user", "bundled"]
    assert skill_entry.source.layer.name == "workspace"
    assert [shadow.layer.name for shadow in skill_entry.shadowed] == ["plugin:0", "user", "bundled"]


def test_broken_entries_are_skipped_with_structured_warnings(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    root = workspace / ".sprintengine"
    (root / "roles").mkdir(parents=True)
    (root / "roles" / "not-json.json").write_text("{", encoding="utf-8")
    write_role(root, "missing_label", label="")
    write_role(root, "bad_soul", soul=[{"text": "not supported yet"}])
    write_role(root, "valid", soul=[{"skill": "broken"}, {"skill": "missing"}])
    (root / "skills" / "broken").mkdir(parents=True)
    (root / "skills" / "broken" / "SKILL.md").write_text("---\nname: broken\n", encoding="utf-8")

    discovery = RoleSkillRegistry(
        workspace_root=workspace,
        user_root=tmp_path / "user",
        bundled_root=tmp_path / "bundled",
    ).discover()

    assert sorted(discovery.roles) == ["valid"]
    assert discovery.skills == {}
    warning_codes = [warning.code for warning in discovery.warnings]
    assert "malformed_role_manifest" in warning_codes
    assert warning_codes.count("invalid_role_manifest") == 1
    assert "invalid_soul_entry" in warning_codes
    assert "broken_skill_document" in warning_codes
    assert warning_codes.count("missing_referenced_skill") == 2


def test_alias_lookup_normalizes_hyphen_underscore_and_conflicts_are_deterministic(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    root = workspace / ".sprintengine"
    write_role(root, "alpha_role", aliases=["shared-alias", "Alpha-Hyphen"])
    write_skill(root, "alpha_role")
    write_role(root, "beta_role", aliases=["shared_alias"])
    write_skill(root, "beta_role")

    discovery = RoleSkillRegistry(
        workspace_root=workspace,
        user_root=tmp_path / "user",
        bundled_root=tmp_path / "bundled",
    ).discover()

    assert discovery.get_role("alpha-hyphen").id == "alpha_role"
    assert discovery.get_role("alpha_hyphen").id == "alpha_role"
    assert discovery.aliases["shared_alias"] == "alpha_role"
    assert any(warning.code == "alias_conflict" and warning.role_id == "beta_role" for warning in discovery.warnings)


def test_temporary_marketer_role_loads_from_workspace_without_user_home_mutation(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    user = tmp_path / "isolated-user-home"
    root = workspace / ".sprintengine"
    write_role(root, "marketer", aliases=["growth-marketer"], soul=[{"skill": "campaign_strategy"}])
    write_skill(root, "campaign_strategy", "---\nname: campaign_strategy\n---\n\n# Campaign Strategy\n\nPlan launches.")

    discovery = RoleSkillRegistry(
        workspace_root=workspace,
        user_root=user,
        bundled_root=tmp_path / "bundled",
    ).discover()

    assert discovery.get_role("growth_marketer").id == "marketer"
    assert discovery.role_entry("marketer").source.path == root / "roles" / "marketer.json"
    assert [skill.id for skill in discovery.referenced_skills("marketer")] == ["campaign_strategy"]
    assert not user.exists()


def test_rendered_soul_strips_frontmatter_and_preserves_ordered_skill_bodies(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    root = workspace / ".sprintengine"
    write_role(root, "developer", soul=[{"skill": "first"}, {"skill": "second"}])
    write_skill(root, "first", "---\nname: first\n---\n\nFirst body for {{role}}.")
    write_skill(root, "second", "---\nname: second\n---\n\nSecond body for {{role_label}} in {{run_id}}.")

    rendered = RoleSkillRegistry(
        workspace_root=workspace,
        user_root=tmp_path / "user",
        bundled_root=tmp_path / "bundled",
    ).discover().render_soul("developer", workspace_root=workspace, run_id="run-123")

    assert rendered.content == "First body for developer.\n\nSecond body for Developer in run-123."
    assert "---" not in rendered.content


def test_rendered_soul_substitutes_allow_list_only_and_warns_for_unsupported_variables(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    root = workspace / ".sprintengine"
    write_role(root, "marketer", label="Growth Marketer", soul=[{"skill": "strategy"}])
    write_skill(
        root,
        "strategy",
        (
            "Role {{ role }} / {{role_label}} / {{workspace_root}} / {{run_id}}\n"
            "Keep unsupported {{env.HOME}} and {{ role | upper }}."
        ),
    )

    rendered = RoleSkillRegistry(
        workspace_root=workspace,
        user_root=tmp_path / "user",
        bundled_root=tmp_path / "bundled",
    ).discover().render_soul("marketer", workspace_root=workspace, run_id="run-456")

    assert f"Role marketer / Growth Marketer / {workspace} / run-456" in rendered.content
    assert "{{env.HOME}}" in rendered.content
    assert "{{ role | upper }}" in rendered.content
    unsupported = [warning for warning in rendered.warnings if warning.code == "unsupported_template_variable"]
    assert [warning.role_id for warning in unsupported] == ["marketer", "marketer"]


def test_rendering_missing_or_malformed_skill_fails_direct_render_without_breaking_discovery(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    root = workspace / ".sprintengine"
    write_role(root, "developer", soul=[{"skill": "broken"}, {"skill": "missing"}])
    (root / "skills" / "broken").mkdir(parents=True)
    (root / "skills" / "broken" / "SKILL.md").write_text("---\nname: broken\n", encoding="utf-8")

    discovery = RoleSkillRegistry(
        workspace_root=workspace,
        user_root=tmp_path / "user",
        bundled_root=tmp_path / "bundled",
    ).discover()

    assert "developer" in discovery.roles
    assert any(warning.code == "broken_skill_document" for warning in discovery.warnings)
    with pytest.raises(SoulRenderError) as exc_info:
        discovery.render_soul("developer", workspace_root=workspace, run_id="run-789")
    assert "cannot render" in str(exc_info.value)
    assert any(warning.code == "missing_render_skill" for warning in exc_info.value.warnings)
