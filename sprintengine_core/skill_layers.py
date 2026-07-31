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

import os
from typing import Any, Mapping, Optional

# Multicode product skills (Backlog, Knowledge Graph). Not soul-related; layered
# by the host onto Multicode-managed agents when the matching feature is active.
# Sprint Engine dispatches gate them at COMPOSE time (backlog-sourced run /
# configured knowledge root) so inactive features cost zero prompt tokens; the
# skills also self-gate at runtime for compositions without gate context.
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

# The full-loop orchestration skill that stands in for a role-personality Soul on
# an agent with NO role. It drives one agent through plan -> build -> self-review ->
# test -> publish and holds the team at the size the user set.
SPRINTENGINE_ROLELESS_WORKFLOW_SKILL: str = "sprintengine_roleless_workflow"

# The UNGATED full skill list for a roleless agent: the orchestration skill (in
# place of a role soul) plus the universal norm + Multicode product layer.
# `load_roleless_soul_prompt` composes the gated equivalent per run; this
# constant remains the contract/reference list (tests assert against it).
SPRINTENGINE_ROLELESS_SKILLS: tuple[str, ...] = (
    SPRINTENGINE_ROLELESS_WORKFLOW_SKILL,
    *SPRINTENGINE_SOUL_EXTRA_SKILLS,
)


def knowledge_root_is_configured(env: Optional[Mapping[str, str]] = None) -> bool:
    """Whether this process was launched with a workspace Knowledge Graph root."""
    source = os.environ if env is None else env
    return bool(source.get("MULTICODE_KNOWLEDGE_ROOT") or source.get("MULTICODE_MEMORY_ROOT"))


def run_is_backlog_sourced(state: Mapping[str, Any]) -> bool:
    """Whether the run was launched from Multicode Backlog content.

    Backlog launches record their originals on `state.source` / `state.sourceBundle`
    (paths under `backlog/`). Only such runs need the `multicode_backlog` lifecycle
    skill; every other run pays no prompt cost for it.
    """
    sources: list[Any] = [state.get("source")]
    bundle = state.get("sourceBundle")
    if isinstance(bundle, (list, tuple)):
        sources.extend(bundle)
    for entry in sources:
        if not isinstance(entry, Mapping):
            continue
        for key in ("originalPath", "path"):
            raw = entry.get(key)
            if not isinstance(raw, str) or not raw:
                continue
            normalized = raw.replace("\\", "/")
            if normalized.startswith("backlog/") or "/backlog/" in normalized:
                return True
    return False


def multicode_layer_skills_for_run(
    *,
    backlog_sourced: bool = True,
    knowledge_root_configured: bool = True,
) -> tuple[str, ...]:
    """The Multicode product layer, gated by which features the run can use.

    Defaults are fail-open (inject) so callers without gate context keep the
    runtime self-gating behavior instead of silently dropping a needed rule.
    """
    skills: list[str] = []
    if backlog_sourced:
        skills.append("multicode_backlog")
    if knowledge_root_configured:
        skills.append("workspace_knowledge")
    return tuple(skills)


def sprintengine_soul_extra_skills(
    *,
    backlog_sourced: bool = True,
    knowledge_root_configured: bool = True,
) -> tuple[str, ...]:
    """Host layer skills for a dispatched agent's startup brief.

    Every dispatched agent gets the same layer: the Multicode product skills
    (gated per run) + the Sprint Engine quality norms. It does not vary by role —
    the role's own identity comes from its manifest directives.
    """
    return (
        *multicode_layer_skills_for_run(
            backlog_sourced=backlog_sourced,
            knowledge_root_configured=knowledge_root_configured,
        ),
        *SPRINTENGINE_NORM_SKILLS,
    )
