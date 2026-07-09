"""Host-owned skill layers composed on top of a portable agent soul.

A pack ships only the agent *soul* (role identity). Multicode and Sprint Engine
each own a layer that the host composes on top at spawn time, so a soul author
never has to couple their prompt to Multicode features or Sprint Engine
mechanics:

- ``MULTICODE_LAYER_SKILLS`` — product skills shipped with Multicode and tied to
  a Multicode feature (Backlog, Knowledge Graph). They self-gate at runtime, so
  including them is safe even when the feature is inactive. Applied to
  Multicode-managed spawns (standalone dropdown agents and Sprint Engine).
- ``SPRINTENGINE_NORM_SKILLS`` — the engineering quality bar Sprint Engine
  enforces. Owned by Sprint Engine and layered on only inside a Sprint Engine
  run; a raw standalone soul does not carry them.
- ``SPRINTENGINE_SWEEP_SKILLS`` — the fix-forward mandate, layered onto sweep
  roles only (``sweep`` present in the manifest). See
  ``sprintengine_extra_skills_for_role``.

These ids resolve against the same skill registry as soul skills, so the
composed layer skills are wrapped in the identical ``<skill name="...">``
envelope as the soul.
"""

from __future__ import annotations

from typing import Any

# Multicode product skills (Backlog, Knowledge Graph). Not soul-related; layered
# by the host onto Multicode-managed agents when the matching feature is active.
MULTICODE_LAYER_SKILLS: tuple[str, ...] = (
    "multicode_backlog",
    "workspace_knowledge",
)

# Sprint Engine's quality methodology. Layered on only inside a Sprint Engine
# run, alongside the coordination skills selected per role.
SPRINTENGINE_NORM_SKILLS: tuple[str, ...] = (
    "project_relative_paths",
    "production_reality_gate",
    "fallback_discipline",
    "evidence_quality_assessment",
    "post_change_self_review",
)

# Extra skills composed into the soul render for a Sprint Engine dispatch: the
# Multicode product layer plus Sprint Engine's quality norms. Coordination
# skills (sprintengine_workflow and friends) are selected separately per role.
SPRINTENGINE_SOUL_EXTRA_SKILLS: tuple[str, ...] = (
    *MULTICODE_LAYER_SKILLS,
    *SPRINTENGINE_NORM_SKILLS,
)

# The fix-forward mandate + significant-findings ladder every sweep role carries.
# A HOST layer, not a manifest reference: the rule is identical for every sweep
# (bundled or custom), so stating it once here keeps the prompt-layer policy (one
# behavior, one layer) and keeps a third-party sweep manifest portable — a pack
# author declares `sweep: {focus, when}` and inherits the mandate for free.
SPRINTENGINE_SWEEP_SKILLS: tuple[str, ...] = ("sprintengine_sweep_workflow",)

# The full-loop orchestration skill that stands in for a role-personality Soul on
# a soulless General. It drives one agent through plan -> build -> self-review ->
# test -> publish and holds the team at the size the user set.
SPRINTENGINE_GENERAL_WORKFLOW_SKILL: str = "sprintengine_general_workflow"

# Skills composed into a soulless General's join prompt: the orchestration skill
# (in place of a role soul) plus the same universal norm + Multicode product
# layer every dispatched agent carries. No role-personality Soul is included, so
# this list — not a manifest soul render — is what keeps the universal norms from
# being dropped for the manifest-less General role.
SPRINTENGINE_GENERAL_SKILLS: tuple[str, ...] = (
    SPRINTENGINE_GENERAL_WORKFLOW_SKILL,
    *SPRINTENGINE_SOUL_EXTRA_SKILLS,
)


def sprintengine_extra_skills_for_role(discovery: Any, role: str) -> tuple[str, ...]:
    """Host layer skills for one role's startup brief.

    Every dispatched agent gets the Multicode product layer + Sprint Engine quality
    norms. A SWEEP role additionally gets the fix-forward mandate, layered here
    rather than referenced from its manifest so a third-party sweep pack inherits it
    by declaring `sweep: {focus, when}` and nothing else. An unresolvable role falls
    back to the base layer — a broken manifest must not strip the quality bar.
    """
    try:
        manifest = discovery.get_role(role)
    except (KeyError, AttributeError):
        return SPRINTENGINE_SOUL_EXTRA_SKILLS
    if getattr(manifest, "is_sweep", False):
        return (*SPRINTENGINE_SWEEP_SKILLS, *SPRINTENGINE_SOUL_EXTRA_SKILLS)
    return SPRINTENGINE_SOUL_EXTRA_SKILLS
