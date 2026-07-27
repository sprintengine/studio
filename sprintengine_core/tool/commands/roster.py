"""Sprint Engine run-config command handlers.

`roster runtime` and `roster enable` are the run's roleRuntimes / configuredRoles
editors. They are all that survives of the old roster surface: MC-1591 deleted
membership (leases replace the roster), so `roster add/retire/replenish/list` and
the seat machinery they drove are gone, and MC-1889 deleted `roster configure`
with the "Architect picks the team" formation it existed to serve. Both survivors
are operator-driven (`--actor ui`), keep the `roster` command namespace so their
existing callers are unaffected, and touch no agents map — they only mutate
run-level config.
"""
from __future__ import annotations

import argparse
import json
from typing import Any, Dict, Optional

from sprintengine_core.tool.roles import require_configured_role
from sprintengine_core.tool.state import (
    append_event,
    apply_configured_roles,
    apply_role_runtimes,
    configured_role_set,
    with_locked_state,
)


def cmd_roster_runtime(args: argparse.Namespace) -> Dict[str, Any]:
    """Operator edit of one role's execution runtime (cli/model) mid-run.

    Invoked from the board UI (--actor ui) and deliberately NOT exposed on the
    MCP capability surface: a role's execution runtime is user config. The merge
    lands in roleRuntimes, so every future spawn (reconcile) and claim
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


def cmd_roster_enable(args: argparse.Namespace) -> Dict[str, Any]:
    """Operator enables one more role for the run mid-flight (board "Add a role").

    Like `roster runtime`, this is the app-owned, user-driven surface
    (--actor ui): `configuredRoles` is user config, so the user's own board
    action is the sanctioned writer — deliberately NOT exposed on the MCP
    capability surface. Additive only: the union with the existing set never
    drops a role. A run with no configuredRoles is legacy/unconstrained — every role is
    already legal there, so no list is written (writing one would suddenly
    constrain the run). Optional --cli/--model seed the role's runtime in the
    same write so the pool supervisor can resolve spawns immediately.
    """
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        role = require_configured_role(str(args.role or ""), context="roster enable")
        configured = configured_role_set(state)
        already_enabled = configured is None or role in configured
        if not already_enabled:
            union = [str(item) for item in (state.get("configuredRoles") or [])]
            union.append(role)
            apply_configured_roles(state, json.dumps(union))
        cli = str(getattr(args, "cli", None) or "").strip()
        raw_model = getattr(args, "model", None)
        model: Optional[str] = str(raw_model).strip() or None if raw_model is not None else None
        if cli:
            apply_role_runtimes(state, json.dumps({role: {"cli": cli, "model": model}}))
        actor = str(getattr(args, "actor", None) or "user").strip() or "user"
        append_event(
            state,
            "role_enabled",
            actor,
            f"{actor} enabled the {role} role for this run.",
            {"role": role, "alreadyEnabled": already_enabled, "cli": cli or None, "model": model},
        )
        return {
            "ok": True,
            "role": role,
            "alreadyEnabled": already_enabled,
            "configuredRoles": list(state.get("configuredRoles") or []),
        }

    return with_locked_state(args.state, run)


runtime = cmd_roster_runtime
enable = cmd_roster_enable
