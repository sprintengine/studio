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
from sprintengine_core.skill_layers import SPRINTENGINE_SOUL_EXTRA_SKILLS

# Specialist roles ship as an installable pack; resolve it as an explicit plugin
# layer so the role-identity anchors below are actually checked. The host skills
# (quality norms, phase packs) stay in the bundled root.
SPECIALIST_PACK_ROOT = Path(__file__).resolve().parents[2] / "resources" / "specialist-pack"

# Anchor phrases per bundled skill. Every skill referenced by a bundled role
# manifest must have an entry; the registration test below enforces this.
SKILL_ANCHORS: dict[str, tuple[str, ...]] = {
    # Cross-cutting discipline skills (in every role's soul).
    "production_reality_gate": (
        "Do not treat `MVP`, `first pass`, `local`, or `works in UI` as permission",
        "not completion evidence",
    ),
    "fallback_discipline": ("explicit failure over surprising fallback",),
    "evidence_quality_assessment": (
        "Completion claims must be backed by",
        "for the next agent, not for narration",
        "under 700 characters",
    ),
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
    "tester": ("principal QA engineer",),
    "architect": ("expert software architect",),
    "product": ("principal product strategist",),
    "frontend": ("senior frontend engineer",),
    "devops": ("principal DevOps and infrastructure engineer",),
    "performance": ("principal performance engineer",),
    "presentation": ("senior product storyteller",),
    "creative": ("senior creative engineer",),
    "cross_platform": ("principal cross-platform compatibility engineer",),
    # code_reviewer retired in MC-1542; its scar-tissue rules live in
    # PHASE_REVIEW_ANCHORS below. nuclear_reviewer / spec_reviewer were retired
    # with it, then restored 2026-07 as final-sweep roles (stricter lenses on
    # top of the folded base pack, which keeps its anchors regardless).
    "nuclear_reviewer": ("principal-level structural maintainability reviewer",),
    "spec_reviewer": ("principal-level specification-conformance reviewer",),
    "production_readiness_reviewer": ("principal production readiness reviewer",),
    "ui_ux_reviewer": ("senior frontend UI/UX reviewer",),
    "coordinator": ("principal-level coordination agent",),
    "blog_writer": ("senior blog writer",),
}

# The MC-1542 base review pack. It is not referenced by any role manifest — the
# engine resolves it per phase — so it needs its own contract test (below). These
# anchors are the scar-tissue rules folded in from the retired reviewer souls, and
# the invariants the single-owner trade-off rests on.
PHASE_REVIEW_ANCHORS: tuple[str, ...] = (
    # The adversarial framing that stands in for an independent reviewer.
    "read it as if a stranger wrote it",
    # nuclear_reviewer: contract drift blocks; the KG note lands in the same publish.
    "Contract drift is blocking",
    "in the same publish",
    # code_reviewer / fallback_discipline: no fallback-masking.
    "explicit failure over surprising fallback",
    # spec_reviewer: requirements coverage.
    "Requirements coverage",
    # tester boundary: a smoke check here; exhaustive validation is a planned QA task.
    "quick smoke check",
    "planned QA tasks own that",
    # Decision 2: fix-forward, never route work back.
    "Fix everything you find, now",
    # Decision 5 (escalation default).
    "Never escalate to have your work confirmed",
    # Phase-walk invariant: strictly forward, no re-entry.
    "A phase is visited at most once",
)


def test_phase_review_base_pack_carries_folded_reviewer_rules() -> None:
    """The retired reviewer souls' rules are relocated here, never dropped.

    `sprintengine_phase_review` is the one review lens every task now gets. If a
    prompt-prune hollows it out, the code/spec/nuclear reviewer scar tissue leaves
    the product silently — this test is the only thing standing in the way.
    """
    body = (BUNDLED_REGISTRY_ROOT / "skills" / "sprintengine_phase_review" / "SKILL.md").read_text(encoding="utf-8")
    missing = [anchor for anchor in PHASE_REVIEW_ANCHORS if anchor not in body]
    assert not missing, (
        "Base review-pack rules missing (register anchors in docs/skill-rule-inventory.md): "
        f"{missing}"
    )


def test_phase_review_base_pack_resolves_through_registry_layering(tmp_path: Path) -> None:
    """A workspace layer can shadow the base pack, changing every task's review lens."""
    from sprintengine_core.tool.phase_prompts import phase_base_pack_skill_id

    skill_id = phase_base_pack_skill_id("review")
    assert skill_id == "sprintengine_phase_review"

    workspace = tmp_path / "workspace"
    override_dir = workspace / ".sprintengine" / "skills" / skill_id
    override_dir.mkdir(parents=True)
    (override_dir / "SKILL.md").write_text("# House review lens\n", encoding="utf-8")

    discovery = RoleSkillRegistry(
        workspace_root=workspace,
        user_root=tmp_path / "user",
        bundled_root=BUNDLED_REGISTRY_ROOT,
    ).discover()

    entry = discovery.skills[skill_id]
    assert entry.source.layer.name == "workspace"
    assert "House review lens" in entry.value.body
    assert [shadow.layer.name for shadow in entry.shadowed] == ["bundled"]


@pytest.fixture()
def bundled_discovery(tmp_path: Path):
    # Specialist roles resolve from the pack (explicit plugin layer); host skills
    # from the bundled root — the composition a real dispatch renders.
    return RoleSkillRegistry(
        workspace_root=tmp_path / "workspace",
        plugin_roots=[SPECIALIST_PACK_ROOT],
        user_root=tmp_path / "user",
        bundled_root=BUNDLED_REGISTRY_ROOT,
    ).discover()


def test_every_bundled_soul_skill_has_registered_anchors(bundled_discovery) -> None:
    referenced = {
        entry_skill.skill
        for entry in bundled_discovery.roles.values()
        for entry_skill in entry.value.all_directive_skills()
    }
    unregistered = sorted(referenced - set(SKILL_ANCHORS))
    assert not unregistered, (
        "Bundled soul skills without contract anchors (register them in "
        f"docs/skill-rule-inventory.md and SKILL_ANCHORS): {unregistered}"
    )


WHAT_TO_DO_MAX_NONEMPTY_LINES = 16


def test_bundled_soul_skills_have_wellformed_emphasis_tags(bundled_discovery) -> None:
    referenced = {
        entry_skill.skill
        for entry in bundled_discovery.roles.values()
        for entry_skill in entry.value.all_directive_skills()
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
        for directive_entry in role.implement_directives:
            assert f'<skill name="{directive_entry.skill}">' in rendered.content, (
                f"{role_id}: missing envelope for {directive_entry.skill}"
            )


def test_every_rendered_soul_contains_required_rule_anchors(bundled_discovery, tmp_path: Path) -> None:
    missing: list[str] = []
    for role_id in sorted(bundled_discovery.roles):
        rendered = bundled_discovery.render_soul(
            role_id, workspace_root=tmp_path / "workspace", run_id="contract"
        )
        role = bundled_discovery.get_role(role_id)
        for directive_entry in role.implement_directives:
            for anchor in SKILL_ANCHORS.get(directive_entry.skill, ()):
                if anchor not in rendered.content:
                    missing.append(f"{role_id}: [{directive_entry.skill}] {anchor!r}")
    assert not missing, "Rule anchors missing from rendered souls:\n" + "\n".join(missing)


def test_layered_render_carries_host_and_sprintengine_anchors(bundled_discovery, tmp_path: Path) -> None:
    # Backlog, Knowledge Graph, and the quality norms left the manifest soul and
    # are now layered on at spawn time. Guard their anchors on the layered render
    # so the host layer cannot silently drop them.
    missing: list[str] = []
    for role_id in sorted(bundled_discovery.roles):
        rendered = bundled_discovery.render_soul(
            role_id,
            workspace_root=tmp_path / "workspace",
            run_id="contract",
            extra_skills=SPRINTENGINE_SOUL_EXTRA_SKILLS,
        )
        for skill_id in SPRINTENGINE_SOUL_EXTRA_SKILLS:
            assert f'<skill name="{skill_id}">' in rendered.content, f"{role_id}: missing {skill_id} envelope"
            for anchor in SKILL_ANCHORS.get(skill_id, ()):
                if anchor not in rendered.content:
                    missing.append(f"{role_id}: [{skill_id}] {anchor!r}")
    assert not missing, "Layer anchors missing from rendered souls:\n" + "\n".join(missing)
