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

These ids resolve against the same skill registry as soul skills, so the
composed layer skills are wrapped in the identical ``<skill name="...">``
envelope as the soul.
"""

from __future__ import annotations

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
