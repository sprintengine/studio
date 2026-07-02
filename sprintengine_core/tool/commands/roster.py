"""Sprint Engine roster command handlers."""
from __future__ import annotations

import argparse
from typing import Any, Dict

from sprintengine_core import store as folder_store
from sprintengine_core.tool.constants import ACTIVE_TASK_STATUSES
from sprintengine_core.tool.gates import find_active_gate_claim
from sprintengine_core.tool.paths import now_iso
from sprintengine_core.tool.roles import configured_role_ids, require_configured_role
from sprintengine_core.tool.state import (
    add_roster_agent,
    agent_is_retired,
    append_event,
    find_task_by_id,
    next_replacement_agent_id,
    retired_agent_has_live_replacement,
    role_has_open_work,
    roster_is_configured,
    with_locked_state,
)
from sprintengine_core.tool.tasks import task_is_ready

# One agent session per task (MC-1444) never applies to planning roles: an
# architect orchestrates the run and a General owns a whole sprint solo, so
# queue-depth replenishment must not mint parallel planning agents.
PLANNING_ROLE_IDS = {"architect", "general"}


def _agent_is_new_task_capacity(state: Dict[str, Any], agent: Any) -> bool:
    """True when this roster id can host a fresh session for a NEW task.

    Mirrors the renderer's task-scoped reuse rules (MC-1444): retired ids are
    gone; a run-complete ('done') id is not respawn capacity (the TS mirror
    requires 'idle', keeping the two calcs from disagreeing every tick); an
    id owning active work is busy; an id whose durable lastOwnedTaskId task
    is still short of terminal state is bound to that task (its live terminal
    only wakes for that task's rework, and a respawn would resume that
    conversation). left/dead ids count — they respawn fresh. Liveness the
    caller knows about arrives separately via --busy-agent (a live
    done-lastOwned terminal is neither wakeable nor spawnable until its
    deferred retirement lands).
    """
    if not isinstance(agent, dict) or agent_is_retired(agent):
        return False
    if str(agent.get("status") or "") == "done":
        return False
    if agent.get("currentTaskId"):
        return False
    last_owned = str(agent.get("lastOwnedTaskId") or "").strip()
    if not last_owned:
        return True
    task = find_task_by_id(state, last_owned)
    return task is None or task.get("status") in {"done", "canceled"}

def cmd_roster_add(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        clean_id = args.id.strip()
        role = require_configured_role(args.role, context="Roster")
        before = dict(state.get("agents", {}))
        agent = add_roster_agent(state, role, clean_id, args.actor or "architect")
        created = clean_id not in before
        return {
            "ok": True,
            "action": "added" if created else "exists",
            "agentId": clean_id,
            "role": role,
            "agent": agent,
        }

    return with_locked_state(args.state, run)

def cmd_roster_retire(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        clean_id = args.id.strip()
        if not clean_id:
            raise SystemExit("--id cannot be empty.")
        reason = (args.reason or "").strip()
        if not reason:
            raise SystemExit("--reason is required.")

        agent = state.get("agents", {}).get(clean_id)
        if not isinstance(agent, dict):
            raise SystemExit(f"Agent {clean_id!r} is not in this Sprint Engine roster.")
        role = str(agent.get("role") or "").strip()
        role = require_configured_role(role, context=f"Agent {clean_id!r}")

        active_task = next(
            (
                task
                for task in state.get("tasks", []) or []
                if isinstance(task, dict)
                and task.get("ownerAgentId") == clean_id
                and task.get("status") in ACTIVE_TASK_STATUSES
            ),
            None,
        )
        if active_task:
            raise SystemExit(
                f"Agent {clean_id!r} still owns active task {active_task.get('id')!r}; "
                "finish it, route it to needs_input, or have the architect release it before retiring."
            )

        active_gate = find_active_gate_claim(state, clean_id, role)
        if active_gate:
            raise SystemExit(
                f"Agent {clean_id!r} still owns active gate {active_gate['gate'].get('id')!r} "
                f"on task {active_gate['task'].get('id')!r}; submit a verdict before retiring."
            )

        already_retired = agent_is_retired(agent)
        agent["status"] = "retired"
        agent["currentTaskId"] = None
        agent.pop("currentGateId", None)
        agent.setdefault("retiredAt", now_iso())
        agent["retiredReason"] = reason
        actor = (args.actor or clean_id).strip() or clean_id
        event = append_event(
            state,
            "roster_member_retired",
            actor,
            f"{actor} retired Sprint Engine roster member {clean_id}.",
            {"agentId": clean_id, "role": role, "reason": reason},
        )
        replacement = None
        # The replenishment trigger uses the normalized runner policy so it
        # picks up either the legacy `runner.mode: auto` or the new
        # `runner.cliWatchPolling: enabled` shape.
        runner_policy = folder_store.normalize_runner_policy(state.get("runner"))
        if (
            runner_policy.get("cliWatchPolling") == "enabled"
            and role_has_open_work(state, role)
            and not retired_agent_has_live_replacement(state, agent)
        ):
            replacement_id = next_replacement_agent_id(state, role)
            replacement = add_roster_agent(state, role, replacement_id, actor)
            agent["replacedByAgentId"] = replacement_id
            append_event(
                state,
                "roster_replacement_added",
                actor,
                f"{actor} added replacement Sprint Engine roster member {replacement_id} for retired {role} capacity.",
                {"agentId": replacement_id, "role": role, "replaces": [clean_id]},
            )
        return {
            "ok": True,
            "action": "already_retired" if already_retired else "retired",
            "agentId": clean_id,
            "role": role,
            "agent": agent,
            "event": event,
            "replacement": {"id": agent.get("replacedByAgentId"), "role": role, "agent": replacement, "replaces": [clean_id]} if replacement else None,
        }

    return with_locked_state(args.state, run)

def cmd_roster_replenish(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        actor = (args.actor or "runner").strip() or "runner"
        roles = [require_configured_role(args.role, context="Roster")] if getattr(args, "role", None) else sorted(configured_role_ids())
        created = []
        for role in roles:
            retired_for_role = [
                agent_id
                for agent_id, agent in state.get("agents", {}).items()
                if (
                    isinstance(agent, dict)
                    and agent.get("role") == role
                    and agent_is_retired(agent)
                    and not retired_agent_has_live_replacement(state, agent)
                )
            ]
            if not retired_for_role:
                continue
            if not role_has_open_work(state, role):
                continue
            for retired_id in retired_for_role:
                replacement_id = next_replacement_agent_id(state, role)
                replacement = add_roster_agent(state, role, replacement_id, actor)
                retired_agent = state.get("agents", {}).get(retired_id)
                if isinstance(retired_agent, dict):
                    retired_agent["replacedByAgentId"] = replacement_id
                append_event(
                    state,
                    "roster_replacement_added",
                    actor,
                    f"{actor} added replacement Sprint Engine roster member {replacement_id} for retired {role} capacity.",
                    {"agentId": replacement_id, "role": role, "replaces": [str(retired_id)]},
                )
                created.append({"id": replacement_id, "role": role, "agent": replacement, "replaces": [str(retired_id)]})

        # Queue-depth top-up (MC-1444 Phase 3): with one agent session per
        # task, a role's parallel throughput is bounded by its spawnable
        # roster ids. Top each non-planning role up to its ready-queue depth,
        # bounded by --max-new per invocation (the caller passes its
        # concurrency headroom; spawning itself stays capped by the renderer's
        # availableSlots either way). Runs after the retired-replacement pass
        # so freshly minted replacements count as capacity — no double mint.
        if getattr(args, "queue_depth", False):
            remaining = max(0, int(getattr(args, "max_new", 0) or 0))
            busy_agent_ids = {
                str(agent_id).strip()
                for agent_id in (getattr(args, "busy_agents", None) or [])
                if str(agent_id).strip()
            }
            tasks = [task for task in state.get("tasks", []) or [] if isinstance(task, dict)]
            # A changes_requested task whose bound previous owner still exists
            # is already covered by that agent (live wake or owner-affinity
            # respawn) — it must not add queue depth, or every rework round
            # would mint a surplus id.
            covered_task_ids = {
                str(agent.get("lastOwnedTaskId"))
                for agent in state.get("agents", {}).values()
                if isinstance(agent, dict)
                and not agent_is_retired(agent)
                and agent.get("lastOwnedTaskId")
            }
            for role in roles:
                if remaining <= 0:
                    break
                if role in PLANNING_ROLE_IDS:
                    continue
                ready_depth = sum(
                    1 for task in tasks
                    if task.get("role") == role
                    and task_is_ready(state, task)
                    and not (task.get("status") == "changes_requested" and str(task.get("id")) in covered_task_ids)
                )
                if ready_depth <= 0:
                    continue
                capacity = sum(
                    1 for agent_id, agent in state.get("agents", {}).items()
                    if isinstance(agent, dict)
                    and agent.get("role") == role
                    and str(agent_id) not in busy_agent_ids
                    and _agent_is_new_task_capacity(state, agent)
                )
                deficit = min(ready_depth - capacity, remaining)
                for _ in range(max(0, deficit)):
                    new_id = next_replacement_agent_id(state, role)
                    new_agent = add_roster_agent(state, role, new_id, actor)
                    append_event(
                        state,
                        "roster_capacity_added",
                        actor,
                        f"{actor} added Sprint Engine roster member {new_id}: {role} ready-queue depth exceeds spawnable capacity.",
                        {"agentId": new_id, "role": role, "reason": "queue_depth", "readyDepth": ready_depth},
                    )
                    created.append({"id": new_id, "role": role, "agent": new_agent, "reason": "queue_depth"})
                    remaining -= 1

        return {"ok": True, "action": "replenished" if created else "none", "created": created}

    return with_locked_state(args.state, run)

def cmd_roster_list(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        agents = [
            {"id": str(agent_id), "role": agent.get("role"), "status": agent.get("status"), "currentTaskId": agent.get("currentTaskId")}
            for agent_id, agent in state.get("agents", {}).items()
            if isinstance(agent, dict)
        ]
        return {
            "ok": True,
            "rosterConfigured": roster_is_configured(state),
            "agents": sorted(agents, key=lambda item: (str(item.get("role")), item["id"])),
            "write": False,
        }

    return with_locked_state(args.state, run)

add = cmd_roster_add
retire = cmd_roster_retire
replenish = cmd_roster_replenish
list_roster = cmd_roster_list
