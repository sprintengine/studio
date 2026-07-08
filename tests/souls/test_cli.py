from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import souls.registry as souls_registry
from souls.registry import get_soul, render_soul, soul_path, validate_souls
from sprintengine_core.role_registry import RoleSkillRegistry
from sprintengine_core.skill_layers import (
    MULTICODE_LAYER_SKILLS,
    SPRINTENGINE_SOUL_EXTRA_SKILLS,
)
from sprintengine_core.tool.roles import VALID_ROLES


def run_souls(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "souls", *args],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def test_souls_list_includes_canonical_roles() -> None:
    completed = run_souls("list", "--format", "json")

    assert completed.returncode == 0, completed.stderr
    payload = json.loads(completed.stdout)
    roles = {soul["role"] for soul in payload["souls"]}

    assert payload["ok"] is True
    assert {
        "architect",
        "coordinator",
        "product",
        "developer",
        "devops",
        "frontend",
        "ui_ux_reviewer",
        "blog_writer",
        "tester",
        "security",
        "code_reviewer",
        "spec_reviewer",
        "performance",
        "production_readiness_reviewer",
        "presentation",
    }.issubset(roles)
    assert "registry_probe" not in roles
    assert "marketer" not in roles
    by_role = {soul["role"]: soul for soul in payload["souls"]}
    assert by_role["blog_writer"]["aliases"] == ["blog-writer", "content-writer", "blogger"]
    assert by_role["presentation"]["aliases"] == ["presenter", "deck-writer", "slide-author", "slides"]
    assert by_role["production_readiness_reviewer"]["aliases"] == [
        "production-readiness",
        "production-ready",
        "production-readiness-review",
        "release-readiness",
        "launch-readiness",
    ]
    assert by_role["tester"]["path"].endswith("resources/sprintengine/roles/tester.json")
    assert "souls/prompts" not in by_role["tester"]["path"]


def test_valid_roles_excludes_validation_only_defaults() -> None:
    assert "registry_probe" not in VALID_ROLES
    assert "marketer" not in VALID_ROLES


def test_souls_get_returns_prompt_for_alias() -> None:
    completed = run_souls("get", "qa-test", "--format", "json")

    assert completed.returncode == 0, completed.stderr
    payload = json.loads(completed.stdout)

    assert payload["ok"] is True
    assert payload["role"] == "tester"
    assert payload["path"].endswith("resources/sprintengine/roles/tester.json")
    assert "souls/prompts" not in payload["path"]
    assert "principal QA engineer" in payload["content"]


def test_bundled_role_manifests_carry_only_the_portable_implement_pack() -> None:
    # A pack ships only the role's own directive packs. Host/Sprint Engine layer
    # skills (Backlog, Knowledge Graph, quality norms) are composed on top at spawn
    # time, never baked into the manifest, so a role stays portable.
    registry_root = Path("resources/sprintengine")
    manifests = sorted((registry_root / "roles").glob("*.json"))
    assert manifests

    layer_skills = set(SPRINTENGINE_SOUL_EXTRA_SKILLS)
    for manifest_path in manifests:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        skills = [entry["skill"] for entry in manifest["directives"]["implement"]]

        assert skills == [manifest["id"]], manifest["id"]
        assert not layer_skills.intersection(skills), manifest["id"]


def test_bare_soul_excludes_host_and_sprintengine_layers() -> None:
    # The portable soul carries the role identity only — none of the host or
    # Sprint Engine layer content.
    rendered = render_soul("developer")

    for heading in [
        "# Production Reality Gate",
        "# Post-Change Self-Review",
        "# Evidence Quality Assessment",
    ]:
        assert heading not in rendered
    assert "MULTICODE_KNOWLEDGE_ROOT" not in rendered
    assert "principal software engineer" in rendered


def test_layered_soul_includes_each_shared_section_once() -> None:
    # A Sprint Engine dispatch layers the Multicode product skills and quality
    # norms on top of the soul; each appears exactly once.
    rendered = render_soul("developer", extra_skills=SPRINTENGINE_SOUL_EXTRA_SKILLS)

    for heading in [
        "# Production Reality Gate",
        "# Post-Change Self-Review",
        "# Evidence Quality Assessment",
    ]:
        assert rendered.count(heading) == 1

    assert "Do not treat `MVP`, `first pass`, `local`, or `works in UI` as permission" in rendered
    assert "Completion claims must be backed by" in rendered
    assert "MULTICODE_KNOWLEDGE_ROOT" in rendered


def test_standalone_soul_layers_multicode_skills_only() -> None:
    # The standalone (dropdown) spawn layers Multicode product skills but not
    # the Sprint Engine quality norms.
    rendered = render_soul("developer", extra_skills=MULTICODE_LAYER_SKILLS)

    assert "MULTICODE_KNOWLEDGE_ROOT" in rendered
    assert "# Production Reality Gate" not in rendered
    assert "# Evidence Quality Assessment" not in rendered


def test_bundled_base_souls_do_not_include_sprintengine_runtime_language() -> None:
    forbidden = [
        "Sprint Engine",
        "SprintEngine",
        "sprintengine",
        "task card",
        "run-store",
        "difficultyPct",
        "actualDifficultyPct",
        "reviewedDifficultyPct",
        "claimsChecked",
    ]

    for role in sorted(VALID_ROLES):
        rendered = render_soul(role)
        for needle in forbidden:
            assert needle not in rendered, f"{role} base Soul leaked runtime language: {needle}"


def test_souls_get_returns_multiloop_coordinator() -> None:
    completed = run_souls("get", "multiloop-coordinator", "--format", "json")

    assert completed.returncode == 0, completed.stderr
    payload = json.loads(completed.stdout)

    assert payload["ok"] is True
    assert payload["role"] == "coordinator"
    assert payload["path"].endswith("resources/sprintengine/roles/coordinator.json")
    assert "principal-level coordination agent" in payload["content"]
    assert "Multiloop" not in payload["content"]
    assert "{{final_goal}}" not in payload["content"]


def test_souls_get_returns_blog_writer_for_alias() -> None:
    completed = run_souls("get", "blog-writer", "--format", "json")

    assert completed.returncode == 0, completed.stderr
    payload = json.loads(completed.stdout)

    assert payload["ok"] is True
    assert payload["role"] == "blog_writer"
    assert payload["path"].endswith("resources/sprintengine/roles/blog_writer.json")
    assert "senior blog writer" in payload["content"]
    assert "Image Generation" in payload["content"]


def test_souls_validate_passes() -> None:
    completed = run_souls("validate")

    assert completed.returncode == 0, completed.stderr
    assert "All Souls are valid." in completed.stdout


def test_souls_unknown_role_fails_clearly() -> None:
    completed = run_souls("get", "unknown-role", "--format", "json")

    assert completed.returncode == 1
    payload = json.loads(completed.stderr)
    assert payload["ok"] is False
    assert payload["error"] == "soul_not_found"
    assert "Unknown Soul role" in payload["message"]


def test_souls_path_uses_registry_manifest_for_alias() -> None:
    path = soul_path("qa-test")

    assert path.match("*/resources/sprintengine/roles/tester.json")
    assert "souls/prompts" not in path.as_posix()


def test_workspace_marketer_soul_renders_through_registry_without_dispatch_role(tmp_path, monkeypatch) -> None:
    root = tmp_path / ".sprintengine"
    (root / "roles").mkdir(parents=True)
    (root / "skills" / "marketer").mkdir(parents=True)
    (root / "roles" / "marketer.json").write_text(
        json.dumps(
            {
                "id": "marketer",
                "label": "Marketer",
                "aliases": ["growth-marketer"],
                "directives": {"implement": [{"skill": "marketer"}]},
            }
        ),
        encoding="utf-8",
    )
    (root / "skills" / "marketer" / "SKILL.md").write_text(
        "---\nname: marketer\n---\n\n# Marketer\n\nRender {{role_label}} for {{role}}.",
        encoding="utf-8",
    )
    monkeypatch.chdir(tmp_path)

    soul = get_soul("growth-marketer")
    content = render_soul("marketer")

    assert soul.role == "marketer"
    assert content.startswith("<soul-legend>")
    assert '<skill name="marketer">\n# Marketer\n\nRender Marketer for marketer.\n</skill>' in content
    assert "marketer" not in VALID_ROLES


def test_validate_requires_migrated_bundled_roles_from_registry(tmp_path: Path, monkeypatch) -> None:
    discovery = RoleSkillRegistry(
        workspace_root=tmp_path / "workspace",
        user_root=tmp_path / "user",
        bundled_root=tmp_path / "empty-bundled",
    ).discover()
    monkeypatch.setattr(souls_registry, "_default_discovery", lambda: discovery)

    errors = validate_souls()

    assert "developer: missing migrated bundled Soul registry role" in errors
    assert "tester: missing migrated bundled Soul registry role" in errors


def test_validate_fails_migrated_role_with_missing_registry_skill(tmp_path: Path, monkeypatch) -> None:
    bundled = tmp_path / "bundled"
    roles_dir = bundled / "roles"
    roles_dir.mkdir(parents=True)
    (roles_dir / "tester.json").write_text(
        json.dumps(
            {
                "id": "tester",
                "label": "Tester",
                "aliases": ["qa-test"],
                "directives": {"implement": [{"skill": "missing_tester_skill"}]},
            }
        ),
        encoding="utf-8",
    )
    discovery = RoleSkillRegistry(
        workspace_root=tmp_path / "workspace",
        user_root=tmp_path / "user",
        bundled_root=bundled,
    ).discover()
    monkeypatch.setattr(souls_registry, "_default_discovery", lambda: discovery)

    errors = validate_souls()

    assert any("missing_tester_skill" in error for error in errors)
    assert any("Role 'tester' cannot render" in error for error in errors)


def test_session_plugin_roots_parses_env(monkeypatch) -> None:
    monkeypatch.setenv(
        souls_registry.REGISTRY_ROOTS_ENV,
        json.dumps([
            {"id": "p", "root": "/tmp/x"},
            {"root": "/tmp/y"},          # id optional
            {"bad": 1},                  # no root → skipped
            {"root": "   "},             # blank root → skipped
            "nope",                      # not an object → skipped
        ]),
    )
    assert souls_registry._session_plugin_roots() == [
        {"id": "p", "root": "/tmp/x"},
        {"root": "/tmp/y"},
    ]


def test_session_plugin_roots_tolerates_garbage(monkeypatch) -> None:
    monkeypatch.setenv(souls_registry.REGISTRY_ROOTS_ENV, "not json at all")
    assert souls_registry._session_plugin_roots() == []
    monkeypatch.setenv(souls_registry.REGISTRY_ROOTS_ENV, json.dumps({"root": "x"}))  # not a list
    assert souls_registry._session_plugin_roots() == []
    monkeypatch.delenv(souls_registry.REGISTRY_ROOTS_ENV, raising=False)
    assert souls_registry._session_plugin_roots() == []


def test_effective_plugin_roots_includes_canonical_user_root(monkeypatch) -> None:
    monkeypatch.delenv(souls_registry.REGISTRY_ROOTS_ENV, raising=False)
    assert souls_registry._effective_plugin_roots() == [souls_registry.MULTICODE_USER_REGISTRY_ROOT]
    # Session plugin roots come first, then the canonical user root — matching the
    # app's menu discovery order.
    monkeypatch.setenv(souls_registry.REGISTRY_ROOTS_ENV, json.dumps([{"id": "plug", "root": "/tmp/z"}]))
    assert souls_registry._effective_plugin_roots() == [
        {"id": "plug", "root": "/tmp/z"},
        souls_registry.MULTICODE_USER_REGISTRY_ROOT,
    ]


def test_session_plugin_root_specialist_renders_through_souls(tmp_path, monkeypatch) -> None:
    # A specialist living in a session plugin root (the env channel the app sets
    # at spawn) resolves through render_soul — the same path `souls get` uses — so
    # the spawn menu and the spawn agree.
    plugin = tmp_path / "plugin-roles"
    (plugin / "roles").mkdir(parents=True)
    (plugin / "skills" / "growth").mkdir(parents=True)
    (plugin / "roles" / "growth.json").write_text(
        json.dumps({"id": "growth", "label": "Growth", "directives": {"implement": [{"skill": "growth"}]}}),
        encoding="utf-8",
    )
    (plugin / "skills" / "growth" / "SKILL.md").write_text(
        "---\nname: growth\n---\n\n# Growth\n\nDrive {{role}} work.",
        encoding="utf-8",
    )
    monkeypatch.setenv(souls_registry.REGISTRY_ROOTS_ENV, json.dumps([{"id": "growth-plugin", "root": str(plugin)}]))
    monkeypatch.chdir(tmp_path)

    content = render_soul("growth")

    assert '<skill name="growth">' in content
    assert "Drive growth work." in content
