from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

import souls.registry as souls_registry
from souls.registry import get_soul, render_soul, soul_path, validate_souls
from sprintengine_core.role_registry import (
    BUNDLED_WORKFLOW_ROLES_SKILLS,
    MissingRoleError,
    RoleSkillRegistry,
)
from sprintengine_core.skill_layers import (
    MULTICODE_LAYER_SKILLS,
    SPRINTENGINE_SOUL_EXTRA_SKILLS,
)
from sprintengine_core.tool.roles import configured_role_ids
from workflow_roles import WORKFLOW_ROLE_IDS, write_workspace_role


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
    assert WORKFLOW_ROLE_IDS.issubset(roles)
    assert "registry_probe" not in roles
    assert "marketer" not in roles
    by_role = {soul["role"]: soul for soul in payload["souls"]}
    assert by_role["blog_writer"]["aliases"] == []
    assert by_role["presentation"]["aliases"] == []
    assert by_role["tester"]["path"].endswith(
        "resources/studio-plugin/workflow-roles/skills/tester/SKILL.md"
    )
    assert "souls/prompts" not in by_role["tester"]["path"]


def test_configured_roles_exclude_validation_only_defaults() -> None:
    configured = configured_role_ids()
    assert "registry_probe" not in configured
    assert "marketer" not in configured


def test_souls_get_returns_prompt_for_hyphen_spelling() -> None:
    completed = run_souls("get", "spec-reviewer", "--format", "json")

    assert completed.returncode == 0, completed.stderr
    payload = json.loads(completed.stdout)

    assert payload["ok"] is True
    assert payload["role"] == "spec_reviewer"
    assert payload["path"].endswith(
        "resources/studio-plugin/workflow-roles/skills/spec-reviewer/SKILL.md"
    )
    assert "souls/prompts" not in payload["path"]
    assert "principal-level specification-conformance reviewer" in payload["content"]


def test_bundled_role_skills_carry_only_the_portable_identity() -> None:
    # A role skill is the role identity only. Host/Sprint Engine layer skills
    # (Backlog, Knowledge Graph, quality norms) are composed on top at spawn
    # time, never baked into the skill, so a role stays portable.
    layer_headings = (
        "# Production Reality Gate",
        "# Post-Change Self-Review",
        "# Evidence Quality Assessment",
    )
    for skill_dir in sorted(BUNDLED_WORKFLOW_ROLES_SKILLS.iterdir()):
        if not skill_dir.is_dir() or skill_dir.name.startswith("."):
            continue
        body = (skill_dir / "SKILL.md").read_text(encoding="utf-8")
        for heading in layer_headings:
            assert heading not in body, skill_dir.name


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
    # A Sprint Engine dispatch layers the studio's product skills and quality
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
    # The standalone (dropdown) spawn layers studio product skills but not
    # the Sprint Engine quality norms.
    rendered = render_soul("developer", extra_skills=MULTICODE_LAYER_SKILLS)

    assert "MULTICODE_KNOWLEDGE_ROOT" in rendered
    assert "# Production Reality Gate" not in rendered
    assert "# Evidence Quality Assessment" not in rendered


# A base Soul may legitimately cite a repository file whose *name* contains a
# forbidden word (a path like `src/video/SprintEngineHero.tsx`). The guard is
# about runtime vocabulary in prose, so drop code-span file paths before
# matching. Only path-shaped spans are dropped: a bare `` `task card` `` or
# `` `claimsChecked` `` span still counts as a leak.
_CODE_SPAN_FILE_PATH = re.compile(r"`[\w.@/-]+/[\w.@-]+\.[A-Za-z0-9]+`")


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

    for role in sorted(configured_role_ids()):
        prose = _CODE_SPAN_FILE_PATH.sub("`<path>`", render_soul(role))
        for needle in forbidden:
            assert needle not in prose, f"{role} base Soul leaked runtime language: {needle}"


def test_souls_get_returns_nuclear_reviewer() -> None:
    completed = run_souls("get", "nuclear_reviewer", "--format", "json")

    assert completed.returncode == 0, completed.stderr
    payload = json.loads(completed.stdout)

    assert payload["ok"] is True
    assert payload["role"] == "nuclear_reviewer"
    assert payload["path"].endswith(
        "resources/studio-plugin/workflow-roles/skills/nuclear-reviewer/SKILL.md"
    )
    assert "principal-level structural maintainability reviewer" in payload["content"]
    assert "{{final_goal}}" not in payload["content"]


def test_souls_get_returns_blog_writer_for_hyphen_spelling() -> None:
    completed = run_souls("get", "blog-writer", "--format", "json")

    assert completed.returncode == 0, completed.stderr
    payload = json.loads(completed.stdout)

    assert payload["ok"] is True
    assert payload["role"] == "blog_writer"
    assert payload["path"].endswith(
        "resources/studio-plugin/workflow-roles/skills/blog-writer/SKILL.md"
    )
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
    assert "Unknown role 'unknown-role'" in payload["message"]
    assert "no skill declaring it is installed" in payload["message"]


def test_souls_path_uses_the_bundled_skill_file() -> None:
    path = soul_path("tester")

    assert path.match("*/resources/studio-plugin/workflow-roles/skills/tester/SKILL.md")
    assert "souls/prompts" not in path.as_posix()


def test_workspace_marketer_soul_renders_through_registry(tmp_path, monkeypatch) -> None:
    workspace = tmp_path / "workspace"
    write_workspace_role(
        workspace,
        "marketer",
        label="Marketer",
        body="# Marketer\n\nRender {{role_label}} for {{role}}.",
    )
    monkeypatch.chdir(workspace)

    soul = get_soul("marketer")
    content = render_soul("marketer")

    assert soul.role == "marketer"
    assert content.startswith("<soul-legend>")
    assert '<skill name="marketer">\n# Marketer\n\nRender Marketer for marketer.\n</skill>' in content


def test_dropped_alias_does_not_resolve(tmp_path, monkeypatch) -> None:
    workspace = tmp_path / "workspace"
    write_workspace_role(workspace, "marketer", label="Marketer")
    monkeypatch.chdir(workspace)

    with pytest.raises(MissingRoleError) as exc_info:
        get_soul("growth-marketer")
    assert "growth-marketer" in str(exc_info.value)
    assert "no skill declaring it is installed" in str(exc_info.value)


def test_validate_passes_with_bundled_roles_and_an_empty_workspace(tmp_path: Path, monkeypatch) -> None:
    empty = RoleSkillRegistry(workspace_root=tmp_path / "workspace").discover()
    monkeypatch.setattr(souls_registry, "_default_discovery", lambda: empty)
    assert WORKFLOW_ROLE_IDS.issubset(empty.roles)
    assert validate_souls() == []


def test_validate_reports_a_broken_role_skill(tmp_path: Path, monkeypatch) -> None:
    workspace = tmp_path / "workspace"
    skill_dir = workspace / ".claude" / "skills" / "broken-role"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: broken-role\nmetadata:\n  sprintengine-role: broken_role\n  role-label: Broken\n---\n",
        encoding="utf-8",
    )
    discovery = RoleSkillRegistry(workspace_root=workspace).discover()
    monkeypatch.setattr(souls_registry, "_default_discovery", lambda: discovery)

    errors = validate_souls()

    assert any("broken_skill_document" in error for error in errors)


def test_workspace_role_skill_renders_through_souls(tmp_path, monkeypatch) -> None:
    workspace = tmp_path / "workspace"
    write_workspace_role(
        workspace,
        "growth",
        label="Growth",
        body="# Growth\n\nDrive {{role}} work.",
    )
    monkeypatch.chdir(workspace)

    content = render_soul("growth")

    assert '<skill name="growth">' in content
    assert "Drive growth work." in content
