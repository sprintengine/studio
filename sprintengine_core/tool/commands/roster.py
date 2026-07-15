"""Sprint Engine run-config command handlers.

`roster configure` and `roster runtime` are the run's configuredRoles /
roleRuntimes editors. They are all that survives of the old roster surface:
MC-1591 deleted membership (leases replace the roster), so
`roster add/retire/replenish/list` and the seat machinery they drove are gone.
Both ops keep the `roster` command namespace so their existing CLI and MCP
callers are unaffected, but neither touches an agents map — they only mutate
run-level config.
"""
from __future__ import annotations

import argparse
import json
from typing import Any, Dict, List, Optional

from sprintengine_core.tool.plans import find_architect_plan_gate, resolve_planning_role
from sprintengine_core.tool.roles import require_configured_role
from sprintengine_core.tool.state import (
    append_event,
    apply_configured_roles,
    apply_role_runtimes,
    configured_role_set,
    runtime_matches_allowed,
    with_locked_state,
)


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


configure = cmd_roster_configure
runtime = cmd_roster_runtime
