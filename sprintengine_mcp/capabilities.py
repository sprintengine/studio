"""Role-scoped tool capability policy for the Sprint Engine MCP surface.

One table, consumed by both sides of the contract: `tools/list` filters the
advertised schemas by the session's role, and the per-call capability check
rejects out-of-surface calls with `tool_not_permitted_for_role`. A tool absent
from a role's listing must also fail when called by name — visibility and
authorization are not allowed to drift apart.

Role classification derives from the role registry, not hardcoded role ids,
because roles are plugin-extensible:

- ``operator`` — the workspace user (`role == "user"` or no role): the app's
  IPC actor, the human/debug CLI, and stdio sessions. Full surface.
- ``architect`` — the system planning role (registry-normalized id
  ``architect``): full agent surface including plan/roster/run-level tools.
- ``reviewer`` — any role whose manifest declares a ``review`` capability:
  agent-common plus the gate/review tools.
- ``worker`` — every other resolvable role, and the conservative fallback for
  roles the registry cannot resolve (such a role cannot join anyway).
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable

from sprintengine_core.role_registry import discover_role_registry, normalize_role_id

RoleClassification = str  # "operator" | "architect" | "reviewer" | "worker"

# Tools every joined agent needs to receive, work, evidence, and finish a task
# or stop safely (including self-retirement near context capacity). Gate tools
# are common, not reviewer-only: quality gates carry their own role (a
# `frontend_review` gate is claimed by the frontend worker), and
# `gate_is_claimable_for_role` already enforces that a caller only claims
# gates assigned to its role.
AGENT_COMMON_TOOLS: frozenset[str] = frozenset({
    "sprintengine.help",
    "sprintengine.gate.list",
    "sprintengine.gate.next",
    "sprintengine.gate.claim",
    "sprintengine.gate.verdict",
    "sprintengine.agent.join",
    "sprintengine.agent.next_directive",
    "sprintengine.agent.heartbeat",
    "sprintengine.agent.leave",
    "sprintengine.subscribe",
    "sprintengine.dispatch.next",
    "sprintengine.dispatch.ack",
    "sprintengine.roster.retire",
    "sprintengine.task.get",
    "sprintengine.task.list",
    "sprintengine.task.next",
    "sprintengine.task.claim",
    "sprintengine.task.status",
    "sprintengine.task.log",
    "sprintengine.task.publish",
    "sprintengine.task.note",
    "sprintengine.task.comment",
    "sprintengine.task.comment.list",
    "sprintengine.task.release",
    "sprintengine.task.resolve_input",
    "sprintengine.artifact.add",
    "sprintengine.artifact.list",
    "sprintengine.artifact.ready",
    "sprintengine.vcs.status",
    "sprintengine.vcs.commit",
    "sprintengine.run.get",
    "sprintengine.run.policy.get",
    "sprintengine.run.subscribe",
    "sprintengine.soul.get",
    "sprintengine.skill.get",
    "sprintengine.skills.list",
    "sprintengine.roles.get",
    "sprintengine.health",
})

# Reviewer privileges beyond the common surface: requesting rework outside an
# active gate. Granted to roles whose manifest declares a `review` capability.
REVIEW_TOOLS: frozenset[str] = frozenset({
    "sprintengine.task.request_changes",
    "sprintengine.artifact.request_changes",
})

# Planning/run-administration surface: the architect (and the operator).
PLANNING_TOOLS: frozenset[str] = frozenset({
    "sprintengine.init",
    "sprintengine.handover",
    "sprintengine.recover",
    "sprintengine.plan.add_task",
    "sprintengine.plan.update_task",
    "sprintengine.plan.delete_task",
    "sprintengine.plan.add_dependency",
    "sprintengine.plan.remove_dependency",
    "sprintengine.plan.start_review",
    "sprintengine.plan.review_status",
    "sprintengine.plan.address_reviews",
    "sprintengine.plan.list",
    "sprintengine.plan.read",
    "sprintengine.triage.needs_input",
    "sprintengine.roster.add",
    "sprintengine.roster.replenish",
    "sprintengine.roster.list",
    "sprintengine.summary",
    "sprintengine.feedback.summarize",
    "sprintengine.feedback.recommend_actions",
    "sprintengine.roles.list",
    "sprintengine.task.ready",
    "sprintengine.artifact.approve",
    "sprintengine.vcs.pr",
})

# Operator-only compatibility surface. `sprintengine.join` backs the human
# `sprintengine --backend mcp-local join --watch` CLI flow and must keep its
# response shape; managed autonomous agents use `agent.join` followed by the
# claim tool their prompt names (`task.next`/`gate.next`), while headless CLI
# agents route through `agent.next_directive`.
OPERATOR_ONLY_TOOLS: frozenset[str] = frozenset({
    "sprintengine.join",
})

# Tools whose payload `role` names the caller (not a task's assigned role —
# e.g. plan.add_task `role` is the task's role). Role-bound sessions must not
# impersonate another role through these.
CALLER_ROLE_PAYLOAD_TOOLS: frozenset[str] = frozenset({
    "sprintengine.agent.join",
    "sprintengine.agent.next_directive",
    "sprintengine.task.next",
    "sprintengine.gate.next",
    "sprintengine.gate.claim",
    "sprintengine.gate.verdict",
})

# Suggested alternatives surfaced in tool_not_permitted_for_role errors for
# the calls agents most plausibly reach for.
PERMITTED_ALTERNATIVES: dict[str, str] = {
    "sprintengine.join": "sprintengine.agent.join",
    "sprintengine.plan.add_task": "sprintengine.task.comment (suggest the task to the architect)",
    "sprintengine.plan.update_task": "sprintengine.task.comment (suggest the change to the architect)",
    "sprintengine.task.request_changes": "sprintengine.task.comment",
    "sprintengine.summary": "sprintengine.task.get",
    "sprintengine.triage.needs_input": "sprintengine.task.status with status=needs_input",
}


def allowed_tools_for_classification(classification: RoleClassification, all_tools: Iterable[str]) -> frozenset[str]:
    if classification == "operator":
        return frozenset(all_tools)
    if classification == "architect":
        return AGENT_COMMON_TOOLS | REVIEW_TOOLS | PLANNING_TOOLS
    if classification == "reviewer":
        return AGENT_COMMON_TOOLS | REVIEW_TOOLS
    return AGENT_COMMON_TOOLS


def classify_role(
    role: str,
    *,
    workspace_root: Path | str | None,
    plugin_registry_roots: tuple[Any, ...] = (),
    user_root: Path | str | None = None,
) -> RoleClassification:
    normalized = normalize_role_id(str(role or ""))
    if not normalized or normalized == "user":
        return "operator"
    return _classify_registry_role(
        normalized,
        str(workspace_root) if workspace_root else None,
        _registry_roots_key(plugin_registry_roots),
        str(user_root) if user_root else None,
    )


def clear_role_classification_cache() -> None:
    _classify_registry_role.cache_clear()


def _registry_roots_key(plugin_registry_roots: tuple[Any, ...]) -> str:
    return json.dumps(
        [root if isinstance(root, (str, dict)) else str(root) for root in plugin_registry_roots],
        sort_keys=True,
        default=str,
    )


@lru_cache(maxsize=256)
def _classify_registry_role(
    normalized_role: str,
    workspace_root: str | None,
    registry_roots_key: str,
    user_root: str | None,
) -> RoleClassification:
    try:
        registry = discover_role_registry(
            workspace_root=Path(workspace_root) if workspace_root else None,
            plugin_roots=tuple(json.loads(registry_roots_key)),
            user_root=Path(user_root) if user_root else None,
        )
        manifest = registry.role_entry(normalized_role).value
    except Exception:
        # Unresolvable roles cannot join a run; give them the conservative
        # worker surface instead of failing every call with a registry error.
        return "worker"
    if manifest.normalized_id == "architect":
        return "architect"
    if any(capability.kind == "review" for capability in manifest.capabilities):
        return "reviewer"
    return "worker"


def permitted_alternative(tool_name: str) -> str | None:
    return PERMITTED_ALTERNATIVES.get(tool_name)
