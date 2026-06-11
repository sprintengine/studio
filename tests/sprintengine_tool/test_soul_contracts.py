"""Soul contract tests.

Pin the critical behaviour rules carried by the bundled Sprint Engine skills
so refactors (tagging, deduplication, compression) cannot silently drop them
from a rendered soul. The anchor phrases are registered in
docs/skill-rule-inventory.md; rewording an anchor requires updating both in
the same change.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from sprintengine_core.role_registry import BUNDLED_REGISTRY_ROOT, RoleSkillRegistry

# Anchor phrases per bundled skill. Every skill referenced by a bundled role
# manifest must have an entry; the registration test below enforces this.
SKILL_ANCHORS: dict[str, tuple[str, ...]] = {
    # Cross-cutting discipline skills (in every role's soul).
    "production_reality_gate": (
        "Do not treat `MVP`, `first pass`, `local`, or `works in UI` as permission",
        "not completion evidence",
    ),
    "fallback_discipline": ("explicit failure over surprising fallback",),
    "evidence_quality_assessment": ("Completion claims must be backed by",),
    "post_change_self_review": ("inspect your own diff",),
    "project_relative_paths": ("relative to the project root",),
    "workspace_knowledge": ("MULTICODE_KNOWLEDGE_ROOT",),
    "multicode_backlog": (
        "part of the work, not optional bookkeeping",
        "needs_input",
    ),
    # Role identity anchors.
    "developer": ("principal software engineer",),
    "security": ("principal application security engineer",),
    "code_reviewer": ("principal-level code quality reviewer",),
    "tester": ("principal QA engineer",),
    "architect": ("expert software architect",),
    "product": ("principal product strategist",),
    "frontend": ("senior frontend engineer",),
    "devops": ("principal DevOps and infrastructure engineer",),
    "performance": ("principal performance engineer",),
    "presentation": ("senior product storyteller",),
    "creative": ("senior creative engineer",),
    "cross_platform": ("principal cross-platform compatibility engineer",),
    "nuclear_reviewer": ("Nuclear Reviewer",),
    "production_readiness_reviewer": ("principal production readiness reviewer",),
    "spec_reviewer": ("principal-level specification reviewer",),
    "ui_ux_reviewer": ("senior frontend UI/UX reviewer",),
    "coordinator": ("principal-level coordination agent",),
    "blog_writer": ("senior blog writer",),
}


@pytest.fixture()
def bundled_discovery(tmp_path: Path):
    return RoleSkillRegistry(
        workspace_root=tmp_path / "workspace",
        user_root=tmp_path / "user",
        bundled_root=BUNDLED_REGISTRY_ROOT,
    ).discover()


def test_every_bundled_soul_skill_has_registered_anchors(bundled_discovery) -> None:
    referenced = {
        soul_entry.skill
        for entry in bundled_discovery.roles.values()
        for soul_entry in entry.value.soul
    }
    unregistered = sorted(referenced - set(SKILL_ANCHORS))
    assert not unregistered, (
        "Bundled soul skills without contract anchors (register them in "
        f"docs/skill-rule-inventory.md and SKILL_ANCHORS): {unregistered}"
    )


WHAT_TO_DO_MAX_NONEMPTY_LINES = 16


def test_bundled_soul_skills_have_wellformed_emphasis_tags(bundled_discovery) -> None:
    referenced = {
        soul_entry.skill
        for entry in bundled_discovery.roles.values()
        for soul_entry in entry.value.soul
    }
    problems: list[str] = []
    for skill_id in sorted(referenced):
        body = bundled_discovery.skills[skill_id].value.body
        if body.count("<what-to-do>") != 1 or body.count("</what-to-do>") != 1:
            problems.append(f"{skill_id}: needs exactly one <what-to-do> block")
            continue
        if body.count("<supporting-info>") != body.count("</supporting-info>"):
            problems.append(f"{skill_id}: unbalanced <supporting-info> tags")
        if "<supporting-info>" in body and body.index("<what-to-do>") > body.index("<supporting-info>"):
            problems.append(f"{skill_id}: <what-to-do> must come before <supporting-info>")
        block = body.split("<what-to-do>", 1)[1].split("</what-to-do>", 1)[0]
        nonempty = [line for line in block.splitlines() if line.strip()]
        if len(nonempty) > WHAT_TO_DO_MAX_NONEMPTY_LINES:
            problems.append(
                f"{skill_id}: <what-to-do> has {len(nonempty)} non-empty lines "
                f"(max {WHAT_TO_DO_MAX_NONEMPTY_LINES}); demote detail to <supporting-info>"
            )
    assert not problems, "Skill emphasis-tag problems:\n" + "\n".join(problems)


def test_rendered_souls_carry_legend_and_skill_provenance(bundled_discovery, tmp_path: Path) -> None:
    for role_id in sorted(bundled_discovery.roles):
        rendered = bundled_discovery.render_soul(
            role_id, workspace_root=tmp_path / "workspace", run_id="contract"
        )
        assert rendered.content.count("<soul-legend>") == 1, role_id
        role = bundled_discovery.get_role(role_id)
        for soul_entry in role.soul:
            assert f'<skill name="{soul_entry.skill}">' in rendered.content, (
                f"{role_id}: missing envelope for {soul_entry.skill}"
            )


def test_every_rendered_soul_contains_required_rule_anchors(bundled_discovery, tmp_path: Path) -> None:
    missing: list[str] = []
    for role_id in sorted(bundled_discovery.roles):
        rendered = bundled_discovery.render_soul(
            role_id, workspace_root=tmp_path / "workspace", run_id="contract"
        )
        role = bundled_discovery.get_role(role_id)
        for soul_entry in role.soul:
            for anchor in SKILL_ANCHORS.get(soul_entry.skill, ()):
                if anchor not in rendered.content:
                    missing.append(f"{role_id}: [{soul_entry.skill}] {anchor!r}")
    assert not missing, "Rule anchors missing from rendered souls:\n" + "\n".join(missing)
