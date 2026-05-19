"""Sprint Engine roster command handlers."""
from __future__ import annotations

import argparse
from typing import Any, Dict

from sprintengine_core.tool.constants import ACTIVE_TASK_STATUSES
from sprintengine_core.tool.gates import find_active_gate_claim
from sprintengine_core.tool.paths import now_iso
from sprintengine_core.tool.roles import VALID_ROLES
from sprintengine_core.tool.state import (
    add_roster_agent,
    agent_is_retired,
    append_event,
    next_replacement_agent_id,
    retired_agent_has_live_replacement,
    role_has_open_work,
    roster_is_configured,
    with_locked_state,
)

def cmd_roster_add(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        clean_id = args.id.strip()
        before = dict(state.get("agents", {}))
        agent = add_roster_agent(state, args.role, clean_id, args.actor or "architect")
        created = clean_id not in before
        return {
            "ok": True,
            "action": "added" if created else "exists",
            "agentId": clean_id,
            "role": args.role,
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
        if role not in VALID_ROLES:
            raise SystemExit(f"Agent {clean_id!r} does not have a valid Sprint Engine role.")

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
        return {
            "ok": True,
            "action": "already_retired" if already_retired else "retired",
            "agentId": clean_id,
            "role": role,
            "agent": agent,
            "event": event,
        }

    return with_locked_state(args.state, run)

def cmd_roster_replenish(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        actor = (args.actor or "runner").strip() or "runner"
        roles = [args.role] if getattr(args, "role", None) else sorted(VALID_ROLES)
        created = []
        for role in roles:
            if role not in VALID_ROLES:
                raise SystemExit(f"Invalid roster role {role!r}.")
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
