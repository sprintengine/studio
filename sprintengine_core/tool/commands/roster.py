"""Sprint Engine roster command handlers."""
from __future__ import annotations

import argparse
import json
from typing import Any, Dict, List, Optional

from sprintengine_core import store as folder_store
from sprintengine_core.tool.constants import ACTIVE_TASK_STATUSES
from sprintengine_core.tool.paths import now_iso
from sprintengine_core.tool.plans import find_architect_plan_gate, resolve_planning_role
from sprintengine_core.tool.roles import configured_role_ids, require_configured_role
from sprintengine_core.tool.state import (
    PLANNING_ROLE_IDS,
    add_roster_agent,
    agent_is_retired,
    agent_owned_task_ids,
    append_event,
    apply_configured_roles,
    apply_role_runtimes,
    configured_role_set,
    next_replacement_agent_id,
    retired_agent_has_live_replacement,
    role_has_open_work,
    roster_is_configured,
    runtime_matches_allowed,
    with_locked_state,
)
from sprintengine_core.tool.tasks import task_is_ready

# One agent session per task (MC-1444) never applies to planning roles: an
# architect orchestrates the run and a General owns a whole sprint solo, so
# queue-depth replenishment must not mint parallel planning agents. The set lives
# in state.py (PLANNING_ROLE_IDS) so the roster seat cap and this mint-exclusion
# share one source.


def _agent_is_new_task_capacity(state: Dict[str, Any], agent: Any) -> bool:
    """True when this roster id can host a fresh session for a NEW task.

    Task-scoped roster ids never recycle: a worker id owns at most one task for
    its whole lifetime, so an id that has EVER owned a task is spent — not
    capacity for new work even after that task is done. Only a never-owned id is
    spawnable capacity. Retired, run-complete ('done' status), and currently
    task-owning ids are excluded too. Liveness the caller knows about arrives
    separately via --busy-agent. A never-owned id keeps counting across left/dead
    respawns; it just has not consumed its single claim yet.
    """
    if not isinstance(agent, dict) or agent_is_retired(agent):
        return False
    if str(agent.get("status") or "") == "done":
        return False
    if agent.get("currentTaskId"):
        return False
    return not agent_owned_task_ids(agent)

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


def _parse_configure_roles(args: argparse.Namespace) -> List[Dict[str, Any]]:
    """Normalize the roster.configure roles payload into a list of dicts.

    MCP passes a native list on `args.roles`; the CLI passes a JSON string on
    `args.roles_json`. Either way this must be a JSON array of objects — a bare
    string in an array field spreads char-by-char, so reject anything that is
    not a list of dicts up front.
    """
    raw = getattr(args, "roles", None)
    if raw is None:
        text = getattr(args, "roles_json", None)
        if not text or not str(text).strip():
            raise SystemExit("roster configure requires --roles-json: a JSON array of {role, cli, model} objects.")
        try:
            raw = json.loads(text)
        except (TypeError, ValueError) as error:
            raise SystemExit(f"--roles-json must be a JSON array of {{role, cli, model}} objects: {error}")
    if not isinstance(raw, list):
        raise SystemExit("roster configure roles must be a JSON array of {role, cli, model} objects.")
    entries: List[Dict[str, Any]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            raise SystemExit("Each roster configure role must be an object of {role, cli, model}.")
        entries.append(entry)
    return entries


def cmd_roster_configure(args: argparse.Namespace) -> Dict[str, Any]:
    """Architect enables roles + pins each role's cli/model in one sanctioned
    mutation ('Architect picks the team' runs). Five ordered validations, each a
    distinct error; then configuredRoles := union(submitted, planning role) and
    roleRuntimes merged. Validation (1) — caller is the planning role — is the
    MCP capability table's job (architect-only surface); this handler runs (2)-(5)."""
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        entries = _parse_configure_roles(args)
        actor = (getattr(args, "id", None) or "architect").strip() or "architect"

        # (2) Only architect-roster runs may reconfigure the team.
        if str(state.get("rosterSource") or "") != "architect":
            raise SystemExit(
                "roster_configure_requires_architect_roster_source: this run's roster was composed by the user; "
                "roster.configure only applies to 'Architect picks the team' runs."
            )

        # (3) The team is locked once the plan is approved (its gate task is done).
        plan_gate_task = find_architect_plan_gate(state, args.state).get("task")
        if isinstance(plan_gate_task, dict) and str(plan_gate_task.get("status") or "") == "done":
            raise SystemExit(
                "roster_locked_after_plan_approval: the plan is approved, so the roster is locked; "
                "post-approval roster changes route through needs_input(user)."
            )

        allowed = state.get("allowedRuntimes")
        # (4) Every submitted role must resolve in the registry (names known roles
        # on failure). Resolve all roles before the palette pass so an unknown
        # role is always reported ahead of an out-of-palette runtime.
        resolved: List[Dict[str, Any]] = []
        for entry in entries:
            role = require_configured_role(str(entry.get("role") or ""), context="roster configure")
            raw_model = entry.get("model")
            model: Optional[str] = str(raw_model).strip() or None if raw_model is not None else None
            resolved.append({"role": role, "cli": str(entry.get("cli") or "").strip(), "model": model})

        # (5) Sprint-palette enforcement: when allowedRuntimes is set (every
        # wizard-created architect-roster run), each cli/model must exactly match
        # an allowed entry. Omitting cli (no ambient default) fails here too.
        if isinstance(allowed, list):
            allowed_desc = ", ".join(
                f"{str(item.get('cli'))}/{item.get('model') or '(cli default)'}"
                for item in allowed
                if isinstance(item, dict)
            ) or "(none)"
            for item in resolved:
                if not runtime_matches_allowed(allowed, item["cli"], item["model"]):
                    requested = f"{item['cli'] or '(none)'}/{item['model'] or '(cli default)'}"
                    raise SystemExit(
                        f"runtime_not_allowed_for_run: role {item['role']!r} requested runtime {requested}, "
                        f"which is not in this sprint's selection. Allowed: {allowed_desc}."
                    )

        planning_role = resolve_planning_role(state)
        union: List[str] = [planning_role]
        for item in resolved:
            if item["role"] not in union:
                union.append(item["role"])
        apply_configured_roles(state, json.dumps(union))
        apply_role_runtimes(
            state,
            json.dumps({item["role"]: {"cli": item["cli"], "model": item["model"]} for item in resolved}),
        )
        append_event(
            state,
            "roster_configured",
            actor,
            f"{actor} configured the Sprint Engine roster: {', '.join(item['role'] for item in resolved) or '(none)'}.",
            {"roles": [dict(item) for item in resolved]},
        )
        return {"ok": True, "configuredRoles": list(state.get("configuredRoles") or [])}

    return with_locked_state(args.state, run)

def cmd_roster_runtime(args: argparse.Namespace) -> Dict[str, Any]:
    """Operator edit of one role's execution runtime (cli/model) mid-run.

    This is the app-owned, user-driven counterpart to roster.configure: it is
    invoked from the board UI (--actor ui), is deliberately NOT exposed on the
    MCP capability surface, and is NOT subject to the architect-mode
    rosterSource / plan-approval-lock / allowedRuntimes guards — the palette
    constrains the architect, never the operator. The merge lands in
    roleRuntimes, so every future spawn (reconcile) and claim
    (stamp_task_execution_identity) resolves the new runtime; live agents keep
    their launched runtime until they next start.
    """
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        role = require_configured_role(str(args.role or ""), context="roster runtime")
        configured = configured_role_set(state)
        if configured is not None and role not in configured:
            raise SystemExit(
                f"role_not_enabled_for_run: role {role!r} is not enabled for this run; "
                "add it to the roster before setting its runtime."
            )
        cli = str(args.cli or "").strip()
        if not cli:
            raise SystemExit(
                "roster runtime requires --cli (pass the role's current CLI when changing only the model)."
            )
        raw_model = getattr(args, "model", None)
        model: Optional[str] = str(raw_model).strip() or None if raw_model is not None else None
        actor = str(getattr(args, "actor", None) or "user").strip() or "user"
        runtimes = state.get("roleRuntimes")
        previous = dict(runtimes.get(role)) if isinstance(runtimes, dict) and isinstance(runtimes.get(role), dict) else {}
        apply_role_runtimes(state, json.dumps({role: {"cli": cli, "model": model}}))
        current = dict((state.get("roleRuntimes") or {}).get(role) or {})
        append_event(
            state,
            "role_runtime_changed",
            actor,
            f"{actor} set the {role} runtime to {cli}/{model or '(cli default)'}.",
            {"role": role, "cli": cli, "model": model, "previous": previous},
        )
        return {"ok": True, "role": role, "runtime": current, "previous": previous}

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

        already_retired = agent_is_retired(agent)
        agent["status"] = "retired"
        agent["currentTaskId"] = None
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

        # Task-scoped assignment op (queue-depth mode): with one agent session
        # per task and no slot recycling, every unowned ready task needs its own
        # fresh roster id. Mint one per uncovered ready task for each non-planning
        # role, bounded by --max-new (the caller's concurrency headroom; spawning
        # stays capped by the renderer's availableSlots either way), and return
        # authoritative [{agentId, role, taskId}] assignments. Runs after the
        # retired-replacement pass so freshly minted replacements count as
        # capacity — no double mint.
        assignments: list[Dict[str, Any]] = []
        if getattr(args, "queue_depth", False):
            remaining = max(0, int(getattr(args, "max_new", 0) or 0))
            busy_agent_ids = {
                str(agent_id).strip()
                for agent_id in (getattr(args, "busy_agents", None) or [])
                if str(agent_id).strip()
            }
            # Only `todo` tasks are ready (MC-1542), and a reopened task is re-bound
            # to its previous owner rather than returned to the queue, so no ready
            # task can already be covered by a live agent. The old
            # `changes_requested`-covered exclusion is therefore gone.
            tasks = [task for task in state.get("tasks", []) or [] if isinstance(task, dict)]
            for role in roles:
                if remaining <= 0:
                    break
                if role in PLANNING_ROLE_IDS:
                    continue
                ready_tasks = [task for task in tasks if task.get("role") == role and task_is_ready(state, task)]
                if not ready_tasks:
                    continue
                # Never-owned spawnable ids already absorb the head of the ready
                # queue; each remaining ready task needs a fresh task-scoped id.
                capacity = sum(
                    1 for agent_id, agent in state.get("agents", {}).items()
                    if isinstance(agent, dict)
                    and agent.get("role") == role
                    and str(agent_id) not in busy_agent_ids
                    and _agent_is_new_task_capacity(state, agent)
                )
                for task in ready_tasks[capacity:]:
                    if remaining <= 0:
                        break
                    task_id = str(task.get("id") or "")
                    new_id = next_replacement_agent_id(state, role)
                    new_agent = add_roster_agent(state, role, new_id, actor)
                    append_event(
                        state,
                        "roster_capacity_added",
                        actor,
                        f"{actor} added Sprint Engine roster member {new_id}: task-scoped id for ready {role} task {task_id}.",
                        {"agentId": new_id, "role": role, "reason": "queue_depth", "readyDepth": len(ready_tasks), "taskId": task_id},
                    )
                    created.append({"id": new_id, "role": role, "agent": new_agent, "reason": "queue_depth", "taskId": task_id})
                    assignments.append({"agentId": new_id, "role": role, "taskId": task_id})
                    remaining -= 1

        return {"ok": True, "action": "replenished" if created else "none", "created": created, "assignments": assignments}

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
configure = cmd_roster_configure
runtime = cmd_roster_runtime
retire = cmd_roster_retire
replenish = cmd_roster_replenish
list_roster = cmd_roster_list
