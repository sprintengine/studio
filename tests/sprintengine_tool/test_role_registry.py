from __future__ import annotations

import json
from pathlib import Path

import pytest

from sprintengine_core.role_registry import SOUL_LEGEND, RoleSkillRegistry, SoulRenderError, discover_role_registry

# The specialist roles ship as an installable pack, not in the bundled root. Tests
# that exercise a real specialist role point at the pack as an explicit plugin
# layer (kept hermetic — not the session env the shared conftest sets).
SPECIALIST_PACK_ROOT = Path(__file__).resolve().parents[2] / "resources" / "specialist-pack"


def write_role(
    root: Path,
    role_id: str,
    *,
    label: str | None = None,
    description: str | None = None,
    aliases: list[str] | None = None,
    implement: list[dict] | None = None,
    review: list[dict] | None = None,
    raw: dict | None = None,
) -> None:
    """Write a v2 role manifest. `raw` overrides the whole payload for reject tests."""
    roles_dir = root / "roles"
    roles_dir.mkdir(parents=True, exist_ok=True)
    directives: dict = {"implement": implement if implement is not None else [{"skill": role_id}]}
    if review is not None:
        directives["review"] = review
    payload = {
        "id": role_id,
        "label": role_id.replace("_", " ").title() if label is None else label,
        "description": description if description is not None else f"Does {role_id} work. Staff it when the run needs {role_id} work.",
        "aliases": aliases or [],
        "directives": directives,
    }
    if raw is not None:
        payload = {**payload, **raw}
    (roles_dir / f"{role_id}.json").write_text(json.dumps(payload), encoding="utf-8")


def write_skill(root: Path, skill_id: str, body: str | None = None) -> None:
    skill_dir = root / "skills" / skill_id
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(body or f"# {skill_id}\n\nBody for {skill_id}.", encoding="utf-8")


def test_discovers_production_pack_role_manifest_and_referenced_skill() -> None:
    discovery = discover_role_registry(
        workspace_root=Path("/unused/workspace"),
        plugin_roots=[SPECIALIST_PACK_ROOT],
        user_root=Path("/unused/user"),
    )

    role = discovery.get_role("qa-test")
    skills = discovery.referenced_skills("tester")
    ui_ux_reviewer = discovery.get_role("ui-ux-review")
    production_readiness = discovery.get_role("production-readiness-review")

    assert role.id == "tester"
    assert ui_ux_reviewer.id == "ui_ux_reviewer"
    assert production_readiness.id == "production_readiness_reviewer"
    assert discovery.role_entry("tester").source.layer.name == "plugin:0"
    # The manifest soul is the portable identity only; host/Sprint Engine layer
    # skills are composed on at spawn time, not referenced by the manifest.
    assert [skill.id for skill in skills] == ["tester"]
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


def test_named_plugin_roots_report_stable_plugin_source_layers(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    plugin = tmp_path / "plugin-souls"
    user = tmp_path / "user"
    bundled = tmp_path / "bundled"
    write_role(plugin, "plugin_writer", label="Plugin Writer")
    write_skill(plugin, "plugin_writer", "# Plugin writer\n")

    discovery = RoleSkillRegistry(
        workspace_root=workspace,
        plugin_roots=[{"id": "writer-plugin", "root": plugin}],
        user_root=user,
        bundled_root=bundled,
    ).discover()

    assert discovery.role_entry("plugin_writer").source.layer.name == "plugin:writer-plugin"
    assert discovery.skills["plugin_writer"].source.layer.name == "plugin:writer-plugin"


def test_broken_entries_are_skipped_with_structured_warnings(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    root = workspace / ".sprintengine"
    (root / "roles").mkdir(parents=True)
    (root / "roles" / "not-json.json").write_text("{", encoding="utf-8")
    write_role(root, "missing_label", label="")
    write_role(root, "bad_directive", implement=[{"text": "not supported yet"}])
    write_role(root, "valid", implement=[{"skill": "broken"}, {"skill": "missing"}])
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
    # missing_label + bad_directive both reject as invalid_role_manifest.
    assert warning_codes.count("invalid_role_manifest") == 2
    assert any("non-empty 'implement' list" in warning.message for warning in discovery.warnings)
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
    write_role(root, "marketer", aliases=["growth-marketer"], implement=[{"skill": "campaign_strategy"}])
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


def _discover(tmp_path: Path, workspace: Path):
    return RoleSkillRegistry(
        workspace_root=workspace,
        user_root=tmp_path / "user",
        bundled_root=tmp_path / "bundled",
    ).discover()


def test_v1_soul_key_is_rejected_by_name(tmp_path: Path) -> None:
    """Decision 8: no v1 shim. A stale pack fails loudly, naming its v2 replacement."""
    workspace = tmp_path / "workspace"
    root = workspace / ".sprintengine"
    (root / "roles").mkdir(parents=True, exist_ok=True)
    (root / "roles" / "legacy.json").write_text(
        json.dumps({"id": "legacy", "label": "Legacy", "soul": [{"skill": "legacy"}]}), encoding="utf-8"
    )
    write_skill(root, "legacy")

    discovery = _discover(tmp_path, workspace)

    assert "legacy" not in discovery.roles
    rejections = [warning for warning in discovery.warnings if warning.code == "v1_role_manifest"]
    assert len(rejections) == 1
    assert "'soul' was removed" in rejections[0].message
    assert '"directives"' in rejections[0].message


def test_v1_capabilities_key_is_rejected_by_name(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    root = workspace / ".sprintengine"
    write_role(root, "legacy_reviewer", raw={"capabilities": [{"kind": "review"}]})
    write_skill(root, "legacy_reviewer")

    discovery = _discover(tmp_path, workspace)

    assert "legacy_reviewer" not in discovery.roles
    rejections = [warning for warning in discovery.warnings if warning.code == "v1_role_manifest"]
    assert len(rejections) == 1
    assert "'capabilities' was removed" in rejections[0].message
    # The message must name the v2 home for a review-only role's content.
    assert '"review"' in rejections[0].message


def test_a_manifest_still_carrying_a_sweep_block_loads_with_the_key_ignored(tmp_path: Path) -> None:
    """MC-1825 deleted the sweep concept, but user-authored manifests on disk keep
    the block the role-authoring UI wrote. An unknown key is ignored, never a
    rejection — a role the user already installed must not vanish from the picker."""
    workspace = tmp_path / "workspace"
    root = workspace / ".sprintengine"
    write_role(root, "auditor", raw={"sweep": {"focus": "compliance", "when": "always"}})
    write_skill(root, "auditor")

    discovery = _discover(tmp_path, workspace)
    role = discovery.get_role("auditor")

    assert role.id == "auditor"
    assert not hasattr(role, "sweep")
    assert not any(warning.role_id == "auditor" for warning in discovery.warnings)


def test_unknown_directive_phase_rejects_manifest(tmp_path: Path) -> None:
    """A typo'd phase key is a hard reject, never a silently dropped directive pack."""
    workspace = tmp_path / "workspace"
    root = workspace / ".sprintengine"
    write_role(root, "typo_role", raw={"directives": {"implement": [{"skill": "typo_role"}], "testing": [{"skill": "x"}]}})
    write_skill(root, "typo_role")

    discovery = _discover(tmp_path, workspace)

    assert "typo_role" not in discovery.roles
    assert any(warning.code == "invalid_role_manifest" for warning in discovery.warnings)


def test_directives_without_implement_reject_manifest(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    root = workspace / ".sprintengine"
    write_role(root, "review_only", raw={"directives": {"review": [{"skill": "review_only"}]}})
    write_skill(root, "review_only")

    discovery = _discover(tmp_path, workspace)

    assert "review_only" not in discovery.roles
    assert any(warning.code == "invalid_role_manifest" for warning in discovery.warnings)


def test_review_directives_are_exposed_per_phase_and_not_in_the_startup_brief(tmp_path: Path) -> None:
    """`directives.review` rides the phase directive, never the startup brief."""
    workspace = tmp_path / "workspace"
    root = workspace / ".sprintengine"
    write_role(root, "frontend", implement=[{"skill": "frontend"}], review=[{"skill": "frontend_review"}])
    write_skill(root, "frontend", "Implement body.")
    write_skill(root, "frontend_review", "Review body.")

    discovery = _discover(tmp_path, workspace)
    role = discovery.get_role("frontend")

    assert [entry.skill for entry in role.implement_directives] == ["frontend"]
    assert [entry.skill for entry in role.directives_for_phase("review")] == ["frontend_review"]
    assert role.directives_for_phase("nonexistent") == ()
    # referenced_skills (the startup brief) sees only the implement pack.
    assert [skill.id for skill in discovery.referenced_skills("frontend")] == ["frontend"]
    rendered = discovery.render_soul("frontend", workspace_root=workspace)
    assert "Implement body." in rendered.content
    assert "Review body." not in rendered.content


def test_rendered_soul_strips_frontmatter_and_preserves_ordered_skill_bodies(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    root = workspace / ".sprintengine"
    write_role(root, "developer", implement=[{"skill": "first"}, {"skill": "second"}])
    write_skill(root, "first", "---\nname: first\n---\n\nFirst body for {{role}}.")
    write_skill(root, "second", "---\nname: second\n---\n\nSecond body for {{role_label}} in {{run_id}}.")

    rendered = RoleSkillRegistry(
        workspace_root=workspace,
        user_root=tmp_path / "user",
        bundled_root=tmp_path / "bundled",
    ).discover().render_soul("developer", workspace_root=workspace, run_id="run-123")

    assert rendered.content == (
        f"{SOUL_LEGEND}\n\n"
        '<skill name="first">\nFirst body for developer.\n</skill>\n\n'
        '<skill name="second">\nSecond body for Developer in run-123.\n</skill>'
    )
    assert "---" not in rendered.content
    assert rendered.content.count("<soul-legend>") == 1


def test_rendered_soul_substitutes_allow_list_only_and_warns_for_unsupported_variables(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    root = workspace / ".sprintengine"
    write_role(root, "marketer", label="Growth Marketer", implement=[{"skill": "strategy"}])
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
    write_role(root, "developer", implement=[{"skill": "broken"}, {"skill": "missing"}])
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


def test_every_pack_role_manifest_has_expected_shared_skill_boundary() -> None:
    """Regression: specialist-pack role manifests carry only the portable identity.

    Roles are pluggable: a pack ships the role's own directive packs and nothing
    else. The Multicode product layer (Backlog, Knowledge Graph) and the Sprint
    Engine layer (quality norms + coordination skills) are composed on top at spawn
    time via render_soul(extra_skills=...), never referenced by the manifest. A
    manifest that bakes in a layer skill re-couples the role to Multicode or
    Sprint Engine, which this test exists to prevent.
    """
    from sprintengine_core.skill_layers import SPRINTENGINE_SOUL_EXTRA_SKILLS

    roles_dir = SPECIALIST_PACK_ROOT / "roles"
    manifests = sorted(roles_dir.glob("*.json"))
    assert manifests, f"Expected specialist-pack role manifests under {roles_dir}"

    layer_skills = set(SPRINTENGINE_SOUL_EXTRA_SKILLS)
    not_identity_only: list[str] = []
    coupled: list[str] = []
    v1_keys: list[str] = []
    for path in manifests:
        data = json.loads(path.read_text(encoding="utf-8"))
        if "soul" in data or "capabilities" in data:
            v1_keys.append(path.name)
            continue
        directives = data.get("directives") or {}
        implement = [entry.get("skill") for entry in directives.get("implement") or [] if isinstance(entry, dict)]
        if implement != [data.get("id")]:
            not_identity_only.append(path.name)
        all_skills = [
            entry.get("skill")
            for entries in directives.values()
            for entry in entries or []
            if isinstance(entry, dict)
        ]
        # `sprintengine_phase_*` base packs are resolved by the engine, never named
        # by a manifest; a role that references one has re-coupled itself.
        if layer_skills.intersection(all_skills) or any(
            str(skill_id).startswith("sprintengine_") for skill_id in all_skills
        ):
            coupled.append(path.name)

    assert not v1_keys, (
        f"These bundled role manifests still carry removed v1 keys: {v1_keys}. "
        "Migrate them to `directives` (MC-1542)."
    )
    assert not not_identity_only, (
        "These role manifests do not carry an identity-only implement pack: "
        f"{not_identity_only}. A bundled manifest's `directives.implement` must be "
        "exactly [{'skill': <role id>}] so the role stays portable; host and Sprint "
        "Engine layers are composed on at spawn time."
    )
    assert not coupled, (
        "These role manifests bake in a host or Sprint Engine layer skill: "
        f"{coupled}. Backlog, Knowledge Graph, quality norms, and Sprint Engine "
        "coordination skills are layered by the host, not the manifest."
    )


def test_bare_discovery_searches_the_user_install_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """An installed role resolves through bare discovery with no session env.

    The app installs the specialist pack (and user-added roles) under
    ~/.multicode/sprintengine-roles; init-time role validation
    (--agent role:id) runs through bare discover_role_registry(), so the install
    root must be discovered natively — otherwise the engine rejects roles the
    spawn menu just offered.
    """
    install_root = tmp_path / "sprintengine-roles"
    write_role(install_root, "installed_auditor")
    write_skill(install_root, "installed_auditor")
    monkeypatch.delenv("MULTICODE_SPRINTENGINE_REGISTRY_ROOTS", raising=False)
    monkeypatch.setenv("MULTICODE_SPRINTENGINE_USER_REGISTRY_ROOT", str(install_root))

    discovery = discover_role_registry(workspace_root=Path("/unused/workspace"), user_root=Path("/unused/user"))

    assert discovery.get_role("installed_auditor").id == "installed_auditor"
    # Session env roots keep precedence over the install root, and explicit
    # plugin_roots callers stay hermetic (no install root).
    hermetic = discover_role_registry(
        workspace_root=Path("/unused/workspace"), user_root=Path("/unused/user"), plugin_roots=[]
    )
    with pytest.raises(KeyError):
        hermetic.get_role("installed_auditor")
