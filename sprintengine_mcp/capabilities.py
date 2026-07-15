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
  ``architect``): full agent surface including plan/run-level tools.
- ``general`` — the soulless ``general`` identity that plans, builds, reviews,
  and tests a sprint by itself: the full planning surface, identical to the
  architect's. MC-1591 deleted the roster-growth tools (leases replaced
  membership, so there is no team to expand), and those tools were the only
  thing that set a General apart, so the two classifications now converge. No
  registry manifest required.
- ``owner`` — every other resolvable role, and the conservative fallback for
  roles the registry cannot resolve (such a role cannot join anyway).

MC-1542 collapsed the old ``reviewer`` classification into ``owner``. A sweep role
is a full implementer with the same tool surface as any worker: it claims its own
task, fixes what it finds, and closes its phases with ``task.advance``. There is
no longer any tool a reviewer needs and a worker must not have.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable

from sprintengine_core.role_registry import discover_role_registry, normalize_role_id

RoleClassification = str  # "operator" | "architect" | "general" | "owner"

# Tools every joined agent needs to receive, work, evidence, and finish a task
# or stop safely (self-retirement near context capacity is `agent.leave`, which
# releases the lease). One agent owns a task from claim through `done` (MC-1542),
# so `task.publish` and `task.advance` are the whole lifecycle surface — there is
# no separate reviewer tool set.
AGENT_COMMON_TOOLS: frozenset[str] = frozenset({
    "sprintengine.help",
    "sprintengine.agent.join",
    "sprintengine.agent.next_directive",
    "sprintengine.agent.heartbeat",
    "sprintengine.agent.leave",
    "sprintengine.task.get",
    "sprintengine.task.list",
    "sprintengine.task.next",
    "sprintengine.task.claim",
    "sprintengine.task.status",
    "sprintengine.task.log",
    "sprintengine.task.publish",
    "sprintengine.task.advance",
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
    "sprintengine.roster.configure",
    "sprintengine.summary",
    "sprintengine.feedback.summarize",
    "sprintengine.feedback.recommend_actions",
    "sprintengine.roles.list",
    "sprintengine.artifact.approve",
    # Artifact review stays a planner/operator action: the human Inbox loop and the
    # architect adjudicate artifacts. It is not a rework channel back onto a task.
    "sprintengine.artifact.request_changes",
    "sprintengine.vcs.pr",
})

# Operator-only compatibility surface. `sprintengine.join` backs the human
# `sprintengine --backend mcp-local join --watch` CLI flow and must keep its
# response shape; managed autonomous agents use `agent.join` followed by
# `task.next`, while headless CLI agents route through `agent.next_directive`.
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
})

# Suggested alternatives surfaced in tool_not_permitted_for_role errors for
# the calls agents most plausibly reach for.
PERMITTED_ALTERNATIVES: dict[str, str] = {
    "sprintengine.join": "sprintengine.agent.join",
    "sprintengine.plan.add_task": "sprintengine.task.comment (suggest the task to the architect)",
    "sprintengine.plan.update_task": "sprintengine.task.comment (suggest the change to the architect)",
    "sprintengine.summary": "sprintengine.task.get",
    "sprintengine.triage.needs_input": "sprintengine.task.status with status=needs_input",
}


def allowed_tools_for_classification(classification: RoleClassification, all_tools: Iterable[str]) -> frozenset[str]:
    if classification == "operator":
        return frozenset(all_tools)
    # architect and general share one planning surface: roster growth was the
    # only tool difference and MC-1591 deleted it.
    if classification in ("architect", "general"):
        return AGENT_COMMON_TOOLS | PLANNING_TOOLS
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
    # `general` is a built-in soulless identity, recognised by id without a
    # registry manifest, so short-circuit before discovery.
    if normalized_role == "general":
        return "general"
    try:
        registry = discover_role_registry(
            workspace_root=Path(workspace_root) if workspace_root else None,
            plugin_roots=tuple(json.loads(registry_roots_key)),
            user_root=Path(user_root) if user_root else None,
        )
        manifest = registry.role_entry(normalized_role).value
    except Exception:
        # Unresolvable roles cannot join a run; give them the conservative owner
        # surface instead of failing every call with a registry error.
        return "owner"
    if manifest.normalized_id == "architect":
        return "architect"
    # A sweep role is an owner like any other: same tools, same lifecycle.
    return "owner"


def permitted_alternative(tool_name: str) -> str | None:
    return PERMITTED_ALTERNATIVES.get(tool_name)
