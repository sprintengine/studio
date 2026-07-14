"""Run-state, roster, task, and lock helpers for Sprint Engine."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from sprintengine_core import store as folder_store
from sprintengine_core.tool.constants import *  # noqa: F403,F401
from sprintengine_core.tool.paths import now_iso
from sprintengine_core.tool.roles import require_configured_role

def parse_agent_specs(values: Optional[List[str]]) -> Dict[str, Dict[str, Any]]:
    agents: Dict[str, Dict[str, Any]] = {}
    for raw in values or []:
        spec = raw.strip()
        if not spec:
            continue
        if ":" not in spec:
            raise SystemExit("--agent must use role:id, for example --agent developer:developer-1")
        raw_role, agent_id = [part.strip() for part in spec.split(":", 1)]
        role = require_configured_role(raw_role, context="--agent")
        if not agent_id:
            raise SystemExit("--agent id cannot be empty.")
        if agent_id in agents and agents[agent_id].get("role") != role:
            raise SystemExit(f"--agent {agent_id!r} is declared with multiple roles.")
        timestamp = now_iso()
        agents[agent_id] = {
            "role": role,
            "status": "idle",
            "heartbeatAt": timestamp,
            "subscription": {"mode": "none"},
            "currentDispatch": None,
            "joinedAt": timestamp,
            "currentTaskId": None,
        }
    return agents


def apply_agent_specs(state: Dict[str, Any], values: Optional[List[str]]) -> None:
    parsed = parse_agent_specs(values)
    if not parsed:
        return
    state.setdefault("sprintengine", {})["rosterConfigured"] = True
    agents = state.setdefault("agents", {})
    for agent_id, agent in parsed.items():
        existing = agents.get(agent_id)
        if isinstance(existing, dict):
            if existing.get("role") and existing.get("role") != agent["role"]:
                raise SystemExit(f"Agent {agent_id!r} already exists with role {existing.get('role')!r}.")
            existing["role"] = agent["role"]
            existing.setdefault("status", "idle")
            existing.setdefault("currentTaskId", None)
        else:
            agents[agent_id] = agent


def apply_role_runtimes(state: Dict[str, Any], raw_json: Optional[str]) -> None:
    """Record the roster's per-role execution runtime (model/cli) at init.

    `raw_json` is a JSON object `{role: {"model": str, "cli": str}}` supplied by
    Multicode from the workspace roster's per-role model/CLI selection. Entries
    with no usable model AND no usable cli are dropped (a role left on the CLI's
    default model records nothing, so no model flag is fabricated). Merges into
    any existing map so a re-init preserves roles it does not mention.
    """
    if not raw_json or not str(raw_json).strip():
        return
    try:
        parsed = json.loads(raw_json)
    except (TypeError, ValueError) as error:
        raise SystemExit(f"--role-runtimes-json must be a JSON object: {error}")
    if not isinstance(parsed, dict):
        raise SystemExit("--role-runtimes-json must be a JSON object of role -> {model, cli}.")
    runtimes = state.setdefault("roleRuntimes", {})
    if not isinstance(runtimes, dict):
        runtimes = {}
        state["roleRuntimes"] = runtimes
    for raw_role, raw_entry in parsed.items():
        role = str(raw_role or "").strip()
        if not role or not isinstance(raw_entry, dict):
            continue
        model = str(raw_entry.get("model") or "").strip()
        cli = str(raw_entry.get("cli") or "").strip()
        entry: Dict[str, Any] = {}
        if model:
            entry["model"] = model
        if cli:
            entry["cli"] = cli
        if entry:
            runtimes[role] = entry


def apply_configured_roles(state: Dict[str, Any], raw_json: Optional[str]) -> None:
    """Persist the run's explicit enabled-role set at init.

    `raw_json` is a JSON array of role ids supplied by Multicode from the
    workspace roster's enabled roles. Post-MC-1542 this is the run's LEGAL ROLE SET:
    the roles a task may be tagged with (`plan.add_task` enforces membership). The
    role need only be enabled here, not currently seated in `agents`, so a lazy
    architect-only roster still admits its planned tasks. Deliberately distinct from
    `roleRuntimes`, whose keys include CLI-default roles. Blank/absent input leaves
    the key untouched so the roster boundary no-ops.
    """
    if not raw_json or not str(raw_json).strip():
        return
    try:
        parsed = json.loads(raw_json)
    except (TypeError, ValueError) as error:
        raise SystemExit(f"--configured-roles-json must be a JSON array: {error}")
    if not isinstance(parsed, list):
        raise SystemExit("--configured-roles-json must be a JSON array of role ids.")
    roles: List[str] = []
    for raw_role in parsed:
        role = str(raw_role or "").strip()
        if role and role not in roles:
            roles.append(role)
    state["configuredRoles"] = roles


def apply_default_phases(state: Dict[str, Any], raw_json: Optional[str]) -> None:
    """Persist the run's phase list at init (CLI-init-only).

    `raw_json` is a JSON array of phase names — the list every task inherits when
    `plan add-task` passes no `--phases`, and the ceiling a per-task list must be a
    subset of. `"[]"` is meaningful and recorded (no review step on this run: every
    publish with changes routes straight to `done`), so unlike the other init keys
    an explicit empty array is NOT treated as absent. A blank/absent flag leaves the
    key off entirely and the engine default (`["review"]`) applies. App-written;
    never MCP-mutable — "agents on this run don't review their own work" is an
    operator guarantee, not a preference the architect can override.
    """
    if raw_json is None or not str(raw_json).strip():
        return
    try:
        parsed = json.loads(raw_json)
    except (TypeError, ValueError) as error:
        raise SystemExit(f"--default-phases-json must be a JSON array: {error}")
    try:
        state["defaultPhases"] = folder_store.normalize_phase_list(parsed, field="--default-phases-json")
    except ValueError as error:
        raise SystemExit(str(error)) from error


def run_default_phases(state: Dict[str, Any]) -> List[str]:
    """The run's phase list (default for tasks, and their ceiling)."""
    try:
        return folder_store.run_default_phases(state)
    except ValueError as error:
        raise SystemExit(str(error)) from error


def apply_phase_runtimes(state: Dict[str, Any], raw_json: Optional[str]) -> None:
    """Persist per-phase runtime bindings at init (MC-1543, CLI-init-only).

    `raw_json` is `{phase: {"cli": str, "model": str|null}}` — the operator paying
    for a stronger model to review each task's diff as a fresh, diff-seeded session.
    Validated against `allowedRuntimes` (the sprint palette) exactly as
    `roster.configure` validates a role binding, and against the shipped phase
    vocabulary. An entry with no `cli` is dropped: a binding with no CLI cannot spawn
    a session, and silently ignoring it would leave the operator believing they had
    bought independent review. Absent/blank leaves the key off, so ZERO extra
    sessions are created (the MC-1542 default).
    """
    if not raw_json or not str(raw_json).strip():
        return
    try:
        parsed = json.loads(raw_json)
    except (TypeError, ValueError) as error:
        raise SystemExit(f"--phase-runtimes-json must be a JSON object: {error}")
    if not isinstance(parsed, dict):
        raise SystemExit("--phase-runtimes-json must be a JSON object of phase -> {cli, model}.")
    allowed = state.get("allowedRuntimes")
    runtimes: Dict[str, Dict[str, Any]] = {}
    for raw_phase, raw_entry in parsed.items():
        phase = str(raw_phase or "").strip()
        if phase not in VALID_TASK_PHASES:
            raise SystemExit(
                f"--phase-runtimes-json names unknown phase {phase!r}; expected one of: {', '.join(VALID_TASK_PHASES)}."
            )
        if not isinstance(raw_entry, dict):
            raise SystemExit(f"--phase-runtimes-json entry for {phase!r} must be an object of {{cli, model}}.")
        cli = str(raw_entry.get("cli") or "").strip()
        if not cli:
            raise SystemExit(f"--phase-runtimes-json entry for {phase!r} requires a cli.")
        raw_model = raw_entry.get("model")
        model: Optional[str] = str(raw_model).strip() or None if raw_model is not None else None
        if isinstance(allowed, list) and not runtime_matches_allowed(allowed, cli, model):
            raise SystemExit(
                f"runtime_not_allowed_for_run: phase {phase!r} requested runtime "
                f"{cli}/{model or '(cli default)'}, which is not in this sprint's selection."
            )
        runtimes[phase] = {"cli": cli, "model": model}
    if runtimes:
        state["phaseRuntimes"] = runtimes


def phase_runtime(state: Dict[str, Any], phase: str) -> Dict[str, Any]:
    """The `{cli, model}` bound to `phase`, or `{}` when it runs in-session."""
    return folder_store.phase_runtime(state, phase)


def phase_needs_own_session(state: Dict[str, Any], task: Dict[str, Any], phase: str) -> bool:
    """True when `phase` must run as a FRESH session on a different runtime.

    Absent binding, or a binding equal to the runtime the task is already stamped
    with, falls through to the in-session default: the owner is mid-tool-call and
    gets the directive inline. Only a genuinely different `{cli, model}` buys a new
    session — the operator pays per bound phase per task, and never by accident.
    """
    binding = phase_runtime(state, phase)
    if not binding:
        return False
    bound_cli = str(binding.get("cli") or "").strip()
    bound_model = binding.get("model") or None
    task_cli = str(task.get("cli") or "").strip()
    task_model = str(task.get("model") or "").strip() or None
    return (bound_cli, bound_model) != (task_cli, task_model)


def apply_required_sweeps(state: Dict[str, Any], raw_json: Optional[str]) -> None:
    """Persist the operator's mandated sweep roles at init (CLI-init-only).

    `raw_json` is a JSON array of sweep role ids the operator ticked in the wizard's
    "Final sweeps" panel. Sweep inclusion is normally the architect's risk-tiered
    call; a mandated sweep is not negotiable — the planning directive must plan one
    task per required role, and the run cannot complete until it has. Every id is
    checked against the role registry's sweep roles, so a typo (or a worker role)
    fails at init rather than silently never being planned. Blank/absent input, and
    an explicit empty array, leave the key off entirely.
    """
    if not raw_json or not str(raw_json).strip():
        return
    try:
        parsed = json.loads(raw_json)
    except (TypeError, ValueError) as error:
        raise SystemExit(f"--required-sweeps-json must be a JSON array: {error}")
    if not isinstance(parsed, list):
        raise SystemExit("--required-sweeps-json must be a JSON array of sweep role ids.")
    roles: List[str] = []
    for raw_role in parsed:
        role = require_configured_role(str(raw_role or "").strip(), context="--required-sweeps-json")
        if role not in roles:
            roles.append(role)
    if not roles:
        return
    from sprintengine_core.role_registry import discover_role_registry

    sweep_ids = {manifest.id for manifest in discover_role_registry().sweep_roles()}
    not_sweeps = [role for role in roles if role not in sweep_ids]
    if not_sweeps:
        raise SystemExit(
            f"--required-sweeps-json names non-sweep role(s): {', '.join(not_sweeps)}. "
            f"Sweep roles declare a `sweep` block in their manifest. Known sweeps: {', '.join(sorted(sweep_ids))}."
        )
    state["requiredSweeps"] = roles


def run_required_sweeps(state: Dict[str, Any]) -> List[str]:
    """Sweep roles the operator mandated for this run."""
    return folder_store.run_required_sweeps(state)


def apply_roster_source(state: Dict[str, Any], value: Optional[str]) -> None:
    """Persist the run's roster-source mode at init (CLI-init-only).

    `'architect'` means the architect picks the team via `roster.configure`;
    `'user'` (and absent/legacy) means the user composed the roster in the
    wizard. Mirrors `apply_configured_roles`: blank/absent input leaves the key
    untouched so legacy runs stay absent (default `'user'` semantics), and the
    round-trip re-emits it only when present. App-written like
    `--role-runtimes-json`; never MCP-mutable.
    """
    clean = str(value or "").strip()
    if not clean:
        return
    if clean not in {"user", "architect"}:
        raise SystemExit("--roster-source must be 'user' or 'architect'.")
    state["rosterSource"] = clean


def apply_allowed_runtimes(state: Dict[str, Any], raw_json: Optional[str]) -> None:
    """Persist the sprint's allowed runtime palette at init (CLI-init-only).

    `raw_json` is a JSON array of `{cli, model}` objects (`model: null` = that
    CLI's own default, recorded as `None`) — the models the user ticked for this
    sprint. This is the hard boundary `roster.configure` enforces: the architect
    may only assign a role a `{cli, model}` that exactly matches an entry here.
    Entries with no usable `cli` are dropped, and duplicates are collapsed.
    Blank/absent input leaves the key untouched so non-architect runs stay
    absent. App-written like `--role-runtimes-json`; never MCP-mutable.
    """
    if not raw_json or not str(raw_json).strip():
        return
    try:
        parsed = json.loads(raw_json)
    except (TypeError, ValueError) as error:
        raise SystemExit(f"--allowed-runtimes-json must be a JSON array: {error}")
    if not isinstance(parsed, list):
        raise SystemExit("--allowed-runtimes-json must be a JSON array of {cli, model} objects.")
    allowed: List[Dict[str, Any]] = []
    for entry in parsed:
        if not isinstance(entry, dict):
            continue
        cli = str(entry.get("cli") or "").strip()
        if not cli:
            continue
        raw_model = entry.get("model")
        model = str(raw_model).strip() or None if raw_model is not None else None
        normalized = {"cli": cli, "model": model}
        if normalized not in allowed:
            allowed.append(normalized)
    state["allowedRuntimes"] = allowed


def runtime_matches_allowed(allowed: Any, cli: str, model: Optional[str]) -> bool:
    """True when `{cli, model}` exactly matches an entry in the allowed palette.

    `model` is compared as-is: `None` (CLI default) matches only a `None` entry,
    a string matches only that string. Used by `roster.configure` to reject any
    role assignment outside the sprint's ticked selection.
    """
    if not isinstance(allowed, list):
        return False
    return any(
        isinstance(entry, dict)
        and str(entry.get("cli") or "").strip() == cli
        and (entry.get("model") or None) == (model or None)
        for entry in allowed
    )


def apply_init_source(
    state: Dict[str, Any],
    source_json: Optional[str],
    source_bundle_json: Optional[str],
) -> None:
    """Seed the sprint source at creation time (app-created runs).

    Multicode passes the already-resolved source metadata so the seed lands in
    run.yaml at t=0 — the Sprint Inbox has an honest "Started from" the moment the
    run exists, independent of any agent later running `handover`. Both carry the
    same shapes the handover command writes: `source` a single dict (kind/origin/
    path/planKind/capturedAt), `sourceBundle` a list of those dicts. Blank/absent
    input leaves state untouched, so CLI/headless and re-init runs (which seed via
    handover) are unaffected.
    """
    if source_json and str(source_json).strip():
        try:
            source = json.loads(source_json)
        except (TypeError, ValueError) as error:
            raise SystemExit(f"--source-json must be a JSON object: {error}")
        if not isinstance(source, dict):
            raise SystemExit("--source-json must be a JSON object of source metadata.")
        state["source"] = source
    if source_bundle_json and str(source_bundle_json).strip():
        try:
            bundle = json.loads(source_bundle_json)
        except (TypeError, ValueError) as error:
            raise SystemExit(f"--source-bundle-json must be a JSON array: {error}")
        if not isinstance(bundle, list):
            raise SystemExit("--source-bundle-json must be a JSON array of source bundle items.")
        state["sourceBundle"] = [item for item in bundle if isinstance(item, dict)]


def roster_is_configured(state: Dict[str, Any]) -> bool:
    return bool(state.get("sprintengine", {}).get("rosterConfigured"))


# Who PLANS is not a set here: `plans.resolve_planning_role` is the single source
# (architect if rostered, else general). There is deliberately no PLANNING_ROLE_IDS
# constant — it used to double as the seat cap, which is what capped a general-only
# run at one agent (MC-1585). Keep the two questions apart.

# Roles capped at one live seat. Only the architect: it orchestrates the whole run,
# and two architects would each try to own it. A General does NOT belong here — the
# default product is a POOL of plain agents that share one task graph by claiming
# (the startup prompt and sprintengine_general_workflow have always promised this),
# so generals seat and replenish as `general-N` workers exactly like developers.
# Planning stays serialized by task ownership, not by a seat cap: the plan-approval
# task has exactly one claimer. This is the single source of the set — roster.py's
# queue-depth replenishment imports it — so the seat cap here and the mint-exclusion
# there cannot drift apart.
SINGLETON_SEAT_ROLE_IDS = {"architect"}


def configured_role_set(state: Dict[str, Any]) -> Optional[set[str]]:
    """The run's enforced enabled-role set, or None when unconfigured.

    Read inline here rather than through the folder store to avoid a
    state->store import cycle. `configuredRoles` is stored canonical, so callers
    membership-test canonical role ids directly. An absent key or an empty/blank
    list returns None so the roster boundary no-ops for legacy/headless runs.
    """
    raw = state.get("configuredRoles")
    if not isinstance(raw, list):
        return None
    roles = {str(role).strip() for role in raw if str(role or "").strip()}
    return roles or None


def ensure_role_in_roster(state: Dict[str, Any], role: str) -> None:
    """Validate `role` against the run's configuredRoles (its legal role set).

    Post-lease authority: run membership is `configuredRoles`, not a seated
    roster. A run with zero live workers of a role still admits its planned
    tasks, so a lazy (architect-only) roster plans work for every enabled role.
    No-ops when configuredRoles is absent/blank (legacy/headless runs)."""
    role = require_configured_role(role, context="Role")
    configured = configured_role_set(state)
    if configured is not None and role not in configured:
        raise SystemExit(
            f"Role {role!r} is not enabled for this run; ask the user to add it to the roster."
        )


def agent_is_retired(agent: Optional[Dict[str, Any]]) -> bool:
    return isinstance(agent, dict) and agent.get("status") in TERMINAL_AGENT_STATUSES


def planning_seat_taken(agents: Dict[str, Any], role: str) -> bool:
    """True when a non-retired agent already holds `role`'s singleton seat.

    Applies to SINGLETON_SEAT_ROLE_IDS (the architect), not to every planning
    role: generals are a pool and seat freely. A retired holder has vacated its
    seat, so it never blocks seating a replacement of the same role.
    """
    return any(
        isinstance(other, dict)
        and str(other.get("role") or "").strip() == role
        and not agent_is_retired(other)
        for other in agents.values()
    )


def role_has_open_work(state: Dict[str, Any], role: str) -> bool:
    for task in state.get("tasks", []) or []:
        if not isinstance(task, dict):
            continue
        if task.get("role") == role and task.get("status") not in {"done", "canceled"}:
            return True
    return False


def set_if_changed(record: Dict[str, Any], key: str, value: Any) -> bool:
    if record.get(key) == value:
        return False
    record[key] = value
    return True


def folder_store_is_ready_for_state(path: Path) -> bool:
    team_dir = path.parent
    return (team_dir / folder_store.RUN_FILE).exists() and (team_dir / "tasks").exists()


def _uses_legacy_state_projection(path: Path) -> bool:
    return path.name != folder_store.RUN_FILE


def _load_legacy_state_projection(path: Path) -> Dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    try:
        loaded = json.loads(text)
    except json.JSONDecodeError:
        loaded = folder_store.yaml.safe_load(text) or {}
    if not isinstance(loaded, dict):
        raise SystemExit(f"Invalid Sprint Engine state projection: {path}")
    return loaded


def _legacy_projection_is_current(path: Path) -> bool:
    if not _uses_legacy_state_projection(path) or not path.exists():
        return False
    run_path = path.parent / folder_store.RUN_FILE
    if not run_path.exists():
        return True
    return path.stat().st_mtime >= run_path.stat().st_mtime


def _write_legacy_state_projection(path: Path, state: Dict[str, Any]) -> None:
    if not _uses_legacy_state_projection(path):
        return
    folder_store.atomic_write_json(path, state)


def load_mutation_state(path: Path, *, initial_state: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    return _resolve_mutation_state(path, initial_state=initial_state)


def _resolve_mutation_state(path: Path, *, initial_state: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    if _legacy_projection_is_current(path):
        return _load_legacy_state_projection(path)
    if folder_store_is_ready_for_state(path):
        try:
            return folder_store.state_from_folder_store(path.parent)
        except folder_store.RunStoreVersionError as exc:
            # A pre-MC-1542 store is rejected, not migrated (decision 8). Surface it
            # as a readable CLI error rather than a traceback; the app surfaces the
            # same message through the projection's schemaVersion guard.
            raise SystemExit(str(exc)) from exc
    if _uses_legacy_state_projection(path) and path.exists():
        return _load_legacy_state_projection(path)
    if initial_state is not None:
        return initial_state
    raise SystemExit(
        "Sprint Engine folder store is not initialized. Run `sprintengine init` for this team before using this command."
    )


def load_state(path: Path) -> Dict[str, Any]:
    return load_mutation_state(path)


def mutation_lock_for_state(path: Path):
    return folder_store.FolderLock(path.parent / folder_store.RUN_LOCK_FILE)


from sprintengine_core.tool.shell import *  # noqa: F403,F401


def with_locked_state(path: Path, handler, *, initial_state: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    lock = mutation_lock_for_state(path)
    with lock:
        state = load_mutation_state(path, initial_state=initial_state)
        result = handler(state)
        if result.get("write", True):
            try:
                folder_store.sync_state_to_store(path.parent, state, state_path=path)
                _write_legacy_state_projection(path, state)
            except ValueError as exc:
                raise SystemExit(str(exc)) from exc
        result.pop("write", None)
        return result


# ---------------------------------------------------------------------------
# State helpers
# ---------------------------------------------------------------------------

def find_task(state: Dict[str, Any], task_id: str) -> Dict[str, Any]:
    for task in state.get("tasks", []):
        if task.get("id") == task_id:
            return task
    raise SystemExit(f"Task not found: {task_id}")


def find_task_by_id(state: Dict[str, Any], task_id: Any) -> Optional[Dict[str, Any]]:
    for task in state.get("tasks", []):
        if isinstance(task, dict) and task.get("id") == task_id:
            return task
    return None


def append_event(
    state: Dict[str, Any],
    event_type: str,
    actor: str,
    message: str,
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    event = {
        "id": f"EVT-{len(state['events']) + 1:03d}",
        "timestamp": now_iso(),
        "type": event_type,
        "actor": actor,
        "message": message,
    }
    if extra:
        event.update({key: value for key, value in extra.items() if value is not None and value != ""})
    state["events"].append(event)
    state.setdefault("sprintengine", {})["updatedAt"] = now_iso()
    return event


def append_task_activity(
    task: Dict[str, Any],
    activity_type: str,
    actor: str,
    message: str,
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    activity = task.setdefault("activity", [])
    if not isinstance(activity, list):
        activity = []
        task["activity"] = activity
    entry = {
        "id": next_activity_id(activity),
        "timestamp": now_iso(),
        "type": activity_type,
        "actor": actor,
        "message": message,
    }
    if extra:
        entry.update({key: value for key, value in extra.items() if value is not None and value != ""})
    activity.append(entry)
    return entry


def next_activity_id(activity: List[Any]) -> str:
    max_index = 0
    for entry in activity:
        if not isinstance(entry, dict):
            continue
        raw_id = str(entry.get("id") or "")
        match = re.fullmatch(r"ACT-(\d+)", raw_id)
        if match:
            max_index = max(max_index, int(match.group(1)))
    return f"ACT-{max_index + 1:03d}"


def append_agent_notification_event(
    state: Dict[str, Any],
    actor: str,
    target_agent_id: Optional[str],
    task_id: Optional[str],
    notification_kind: str,
    message: str,
    artifact_id: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    if not target_agent_id:
        return None
    return append_event(
        state,
        "agent_notification_requested",
        actor,
        message,
        {
            "targetAgentId": target_agent_id,
            "taskId": task_id,
            "artifactId": artifact_id,
            "notificationKind": notification_kind,
        },
    )


def ensure_agent(state: Dict[str, Any], agent_id: str, role: Optional[str] = None) -> Dict[str, Any]:
    agents = state.setdefault("agents", {})
    timestamp = now_iso()
    agent = agents.setdefault(
        agent_id,
        {
            "role": role or "developer",
            "status": "idle",
            "heartbeatAt": timestamp,
            "subscription": {"mode": "none"},
            "currentDispatch": None,
            "joinedAt": timestamp,
            "currentTaskId": None,
        },
    )
    if role and not agent.get("role"):
        agent["role"] = role
    agent.setdefault("status", "idle")
    agent.setdefault("heartbeatAt", timestamp)
    agent.setdefault("subscription", {"mode": "none"})
    agent.setdefault("currentDispatch", None)
    agent.setdefault("joinedAt", timestamp)
    agent.setdefault("currentTaskId", None)
    return agent


def clear_terminal_state_metadata(agent: Dict[str, Any]) -> bool:
    changed = False
    for key in ("deadAt", "deathReason", "leftAt", "leaveReason"):
        if key in agent:
            agent.pop(key, None)
            changed = True
    return changed


def set_agent_idle(agent: Dict[str, Any]) -> bool:
    changed = set_if_changed(agent, "status", "idle")
    changed = set_if_changed(agent, "currentTaskId", None) or changed
    changed = set_if_changed(agent, "currentDispatch", None) or changed
    changed = set_if_changed(agent, "heartbeatAt", now_iso()) or changed
    return changed


def agent_owned_task_ids(agent: Dict[str, Any]) -> set[str]:
    """Every task this id has owned, from its `lastOwnedTaskId` attribution field.

    Vestigial roster helper kept for `commands/roster.py` (deleted with the
    roster surface in T2); no claim/seat/capacity decision reads it any more —
    the task lease is the sole authority (see `worker_has_active_lease`).
    """
    owned: set[str] = set()
    last_owned = str(agent.get("lastOwnedTaskId") or "").strip()
    if last_owned:
        owned.add(last_owned)
    return owned


def set_agent_active(agent: Dict[str, Any], task: Dict[str, Any], *, refresh_heartbeat: bool = True) -> bool:
    """Sync the non-authoritative agents-map mirror to an owned task.

    Assignment authority lives on the task lease (see `mint_lease`); this only
    updates the display mirror the projection still reads until T4 deletes it.
    `lastOwnedTaskId` is retained as the denormalized last-owner attribution field.
    """
    changed = set_if_changed(agent, "status", "needs_input" if task.get("status") == "needs_input" else "running")
    changed = set_if_changed(agent, "currentTaskId", task.get("id")) or changed
    changed = set_if_changed(agent, "lastOwnedTaskId", task.get("id")) or changed
    changed = clear_terminal_state_metadata(agent) or changed
    if refresh_heartbeat:
        changed = set_if_changed(agent, "heartbeatAt", now_iso()) or changed
    return changed


def record_agent_join(
    state: Dict[str, Any],
    agent_id: str,
    role: str,
    *,
    subscription_mode: str = "none",
) -> Dict[str, Any]:
    agent = ensure_agent(state, agent_id, role)
    timestamp = now_iso()
    agent["role"] = role
    # Legacy terminal statuses are already normalized to idle on load; a rejoin
    # only needs to fill an empty status. A live status (running/needs_input) is
    # left for reconcile/claim to resolve.
    if not agent.get("status"):
        agent["status"] = "idle"
    agent["heartbeatAt"] = timestamp
    clear_terminal_state_metadata(agent)
    agent.setdefault("joinedAt", timestamp)
    mode = subscription_mode if subscription_mode in {"none", "poll", "mcp_notifications"} else "none"
    agent["subscription"] = {"mode": mode}
    if mode != "none":
        agent["subscription"]["subscribedAt"] = timestamp
    return agent


def record_agent_heartbeat(state: Dict[str, Any], agent_id: str, role: Optional[str] = None) -> Dict[str, Any]:
    """Renew liveness for `agent_id`: every active lease it holds, plus its mirror.

    The lease heartbeat is what the expiry sweep measures, so renewing it here is
    what keeps a live worker's task from being reclaimed. The agents-map mirror
    heartbeat is refreshed alongside for the display projection.
    """
    agent = ensure_agent(state, agent_id, role or None)
    timestamp = now_iso()
    agent["heartbeatAt"] = timestamp
    for task in worker_active_lease_tasks(state, agent_id):
        lease = task_lease(task)
        if lease is not None:
            lease["heartbeatAt"] = timestamp
    return agent


def parse_utc_timestamp(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def agent_liveness_timeout_seconds(state: Dict[str, Any]) -> int:
    sprintengine = state.get("sprintengine") if isinstance(state.get("sprintengine"), dict) else {}
    runner = state.get("runner") if isinstance(state.get("runner"), dict) else {}
    for source in (sprintengine, runner):
        try:
            value = int(source.get("agentTimeoutSeconds"))  # type: ignore[union-attr]
        except (TypeError, ValueError):
            continue
        if value > 0:
            return value
    return 300


# ---------------------------------------------------------------------------
# Task leases — the assignment authority (MC-1591)
#
# A lease is minted on the task record at claim (`mint_lease`), lives while the
# task is in_progress/review/needs_input, and ends at done/canceled. It is the
# sole authority for claim, seat, and capacity decisions; `ownerAgentId` is its
# denormalized owner field, kept in lockstep for every consumer that already
# reads it. The persistent `agents` map is a non-authoritative display mirror
# only (physical removal + the lease-derived projection land in T4).
# ---------------------------------------------------------------------------

def task_lease(task: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    lease = task.get("lease")
    return lease if isinstance(lease, dict) else None


def lease_is_active(task: Dict[str, Any]) -> bool:
    """True while the task's lease binds a worker (in_progress/review/needs_input)."""
    return task.get("status") in ACTIVE_TASK_STATUSES and active_lease_worker(task) is not None


def active_lease_worker(task: Dict[str, Any]) -> Optional[str]:
    """The worker id holding this task's ACTIVE lease, or None.

    Active means the task status is in ACTIVE_TASK_STATUSES. Falls back to the
    denormalized `ownerAgentId` when the record predates the lease field, so a
    task claimed before this change is still attributed to its owner.
    """
    if task.get("status") not in ACTIVE_TASK_STATUSES:
        return None
    lease = task_lease(task)
    worker = str((lease or {}).get("workerId") or "").strip()
    if worker:
        return worker
    owner = str(task.get("ownerAgentId") or "").strip()
    return owner or None


def mint_lease(task: Dict[str, Any], worker_id: str, role: Optional[str] = None) -> Dict[str, Any]:
    """Mint or refresh the task's assignment lease for `worker_id`.

    Called wherever a worker takes ownership of an active task (claim, phase
    re-bind). `since` is preserved while the same worker holds the lease across a
    phase walk and reset when a different worker takes over. `heartbeatAt` is
    refreshed so the expiry sweep measures from the latest ownership event.
    """
    clean_id = str(worker_id or "").strip()
    existing = task_lease(task) or {}
    same_worker = str(existing.get("workerId") or "").strip() == clean_id and clean_id != ""
    lease: Dict[str, Any] = {
        "workerId": clean_id,
        "role": str(role or existing.get("role") or task.get("role") or "").strip(),
        "heartbeatAt": now_iso(),
        "since": existing.get("since") if same_worker else now_iso(),
    }
    session_id = str(existing.get("sessionId") or "").strip()
    if session_id:
        lease["sessionId"] = session_id
    task["lease"] = lease
    return lease


def end_lease(task: Dict[str, Any]) -> None:
    """End the task's lease (at done/canceled or on release to the queue)."""
    task.pop("lease", None)


def worker_active_lease_tasks(state: Dict[str, Any], worker_id: str) -> List[Dict[str, Any]]:
    """Every task on which `worker_id` currently holds an active lease."""
    clean_id = str(worker_id or "").strip()
    if not clean_id:
        return []
    return [
        task for task in state.get("tasks", []) or []
        if isinstance(task, dict) and active_lease_worker(task) == clean_id
    ]


def worker_has_active_lease(state: Dict[str, Any], worker_id: str, *, excluding_task_id: Any = None) -> bool:
    """True when `worker_id` holds an active lease on any task except `excluding_task_id`.

    The lease-authority replacement for `task_claim_exceeds_worker_capacity`:
    a worker with an active lease is refused a second claim; a worker whose task
    is done (no active lease) may claim again. Re-claiming the excluded task
    itself (rework respawn) is always allowed.
    """
    excluded = str(excluding_task_id or "").strip()
    return any(
        str(task.get("id") or "").strip() != excluded
        for task in worker_active_lease_tasks(state, worker_id)
    )


def worker_active_lease_role(state: Dict[str, Any], worker_id: str) -> str:
    """The role recorded on any active lease `worker_id` holds, or ''."""
    for task in worker_active_lease_tasks(state, worker_id):
        role = str((task_lease(task) or {}).get("role") or task.get("role") or "").strip()
        if role:
            return role
    return ""


def worker_role(state: Dict[str, Any], worker_id: str) -> str:
    """Best-effort role for a worker id, for display typing — never authority.

    The agents-map role is gone as an authority, so this derives the role from the
    run's own records: an active lease first, then any task the worker owns or last
    implemented, then the minted-id convention (`<role>` / `<role>-<n>`, how the
    spawner names workers) validated against the run's configured roles. Returns ''
    when the role cannot be established.
    """
    clean = str(worker_id or "").strip()
    if not clean:
        return ""
    role = worker_active_lease_role(state, clean)
    if role:
        return role
    for task in state.get("tasks", []) or []:
        if not isinstance(task, dict):
            continue
        if task.get("ownerAgentId") == clean or str(task.get("lastImplementedByAgentId") or "").strip() == clean:
            role = str(task.get("role") or "").strip()
            if role:
                return role
    prefix = clean.split("-", 1)[0]
    configured = configured_role_set(state)
    if prefix and (configured is None or prefix in configured):
        return prefix
    return ""


def lease_is_expired(state: Dict[str, Any], task: Dict[str, Any], *, now: Optional[datetime] = None) -> bool:
    """True when the task's lease heartbeat has aged past the liveness timeout."""
    heartbeat = parse_utc_timestamp((task_lease(task) or {}).get("heartbeatAt"))
    if heartbeat is None:
        return False
    current = now or datetime.now(timezone.utc)
    return (current - heartbeat).total_seconds() > agent_liveness_timeout_seconds(state)


def release_agent_targets(
    state: Dict[str, Any],
    agent_id: str,
    *,
    reason: str,
    actor: str,
) -> List[Dict[str, Any]]:
    """Free every in_progress lease `agent_id` holds and reset its display mirror.

    The single authority for releasing a worker's owned work, shared by the MCP
    agent.leave path and the headless expiry sweep. Keyed on the task lease (via
    its denormalized `ownerAgentId`): an `in_progress` task returns to the queue
    (-> todo, lease ended, ownerAgentId/startedAt/completedAt reset).

    A task in `review` STAYS bound to its lease (MC-1542 Flow 6). Its diff is
    published and its phase is half-walked; releasing it to `todo` would hand a
    stranger a task whose work is already done and whose ready-queue entry claims
    otherwise. The owner is instead revived under the same id with a phase brief.
    `needs_input` stays bound for the same reason — the blocker is on the human.

    The agents-map mirror record is reset to idle for display only; liveness is
    never stored here. Returns one canonical descriptor per released target
    (empty when the worker held none); callers shape their own payloads from it.
    """
    agents = state.get("agents")
    agent = agents.get(agent_id) if isinstance(agents, dict) else None
    released: List[Dict[str, Any]] = []

    for task in state.get("tasks", []) or []:
        if not isinstance(task, dict) or active_lease_worker(task) != agent_id:
            continue
        status = str(task.get("status") or "")
        # Only un-started implementation work returns to the queue. `review` and
        # `needs_input` leases stay bound (see the docstring).
        if status != "in_progress":
            continue
        end_lease(task)
        task["ownerAgentId"] = None
        task["status"] = "todo"
        task["startedAt"] = None
        task["completedAt"] = None
        append_task_activity(
            task,
            "status_change",
            actor,
            f"{actor} released task claim from {agent_id}: {reason}",
            {"status": task.get("status"), "fromStatus": status, "previousOwnerAgentId": agent_id, "reason": reason},
        )
        released.append({
            "kind": "task",
            "taskId": task.get("id"),
            "previousOwnerAgentId": agent_id,
            "fromStatus": status,
            "status": task.get("status"),
        })

    if isinstance(agent, dict):
        set_agent_idle(agent)
    return released


def release_expired_agent_targets(
    state: Dict[str, Any],
    *,
    actor: str = "sprintengine",
    excluding_agent_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Headless fallback for the derived-liveness model, keyed on task leases.

    Main is the authority on worker liveness; when it is not driving (headless
    CLI runs), any `in_progress` lease whose heartbeat has aged past the timeout
    is swept through release_agent_targets — the same release the MCP agent.leave
    path performs — and re-dispatched. Only `in_progress` leases are swept:
    `review`/`needs_input` leases stay bound to their worker id. Once a lease is
    released to `todo` it is no longer active, so repeat sweeps are a no-op.
    """
    released: List[Dict[str, Any]] = []
    current = datetime.now(timezone.utc)
    # Group expired in_progress leases by worker so one release frees all of a
    # departed worker's un-started tasks in a single pass.
    expired_workers: Dict[str, str] = {}
    for task in state.get("tasks", []) or []:
        if not isinstance(task, dict) or task.get("status") != "in_progress":
            continue
        worker_id = active_lease_worker(task)
        if not worker_id or worker_id == excluding_agent_id:
            continue
        if not lease_is_expired(state, task, now=current):
            continue
        lease = task_lease(task) or {}
        expired_workers.setdefault(worker_id, str(lease.get("role") or task.get("role") or ""))

    dirty = bool(expired_workers)
    for worker_id, role in expired_workers.items():
        for entry in release_agent_targets(state, worker_id, reason="agent expired", actor=actor):
            kind = str(entry.get("kind") or "")
            queue_dispatch_record(
                state,
                agent_id=worker_id,
                role=role,
                target_kind=kind or "agent",
                task_id=str(entry.get("taskId") or ""),
                reason="agent_expired_release",
            )
            released.append({
                "agentId": worker_id,
                "role": role,
                "targetKind": kind,
                "taskId": entry.get("taskId"),
                "fromStatus": entry.get("fromStatus"),
                "status": entry.get("status"),
            })

    if released:
        append_event(
            state,
            "agent_targets_released",
            actor,
            f"{actor} released {len(released)} expired agent target(s).",
            {"releasedCount": len(released)},
        )
    return {"released": released, "dirty": dirty}


def clear_task_refs(state: Dict[str, Any], task_id: str) -> List[str]:
    cleared = []
    for agent_id, agent in state.get("agents", {}).items():
        if isinstance(agent, dict) and agent.get("currentTaskId") == task_id:
            if agent_is_retired(agent):
                set_if_changed(agent, "currentTaskId", None)
                set_if_changed(agent, "currentDispatch", None)
            else:
                set_agent_idle(agent)
            cleared.append(str(agent_id))
    return cleared


def current_dispatch_payload(
    *,
    dispatch_id: str,
    target_kind: str,
    role: str,
    reason: str,
    task_id: Optional[str] = None,
    assigned_at: Optional[str] = None,
) -> Dict[str, Any]:
    payload = {
        "dispatchId": dispatch_id,
        "targetKind": target_kind,
        "role": role,
        "reason": reason,
        "assignedAt": assigned_at or now_iso(),
    }
    if task_id:
        payload["taskId"] = task_id
    return payload


def queue_dispatch_record(
    state: Dict[str, Any],
    *,
    agent_id: str,
    role: str,
    target_kind: str,
    reason: str,
    task_id: Optional[str] = None,
    task_status: Optional[str] = None,
) -> Dict[str, Any]:
    timestamp = now_iso()
    target = {"kind": target_kind}
    if task_id:
        target["taskId"] = task_id
    record = {
        "timestamp": timestamp,
        "agentId": agent_id,
        "role": role,
        "target": target,
        "reason": reason,
        "state": {"taskStatus": task_status},
        "outcome": "dispatched",
        "source": "core",
    }
    record["id"] = folder_store.dispatch_id_for_record(record)
    state.setdefault("_dispatchRecords", []).append(record)
    return record


def dispatch_target_key(target_kind: str, task_id: Any = None) -> str:
    del target_kind
    return f"task:{task_id}"


def select_round_robin_target(
    state: Dict[str, Any],
    *,
    role: str,
    target_kind: str,
    candidates: List[Any],
    key_fn,
) -> Any:
    if not candidates:
        return None
    keys = [key_fn(candidate) for candidate in candidates]
    cursor_key = f"{role}:{target_kind}"
    cursors = state.setdefault("sprintengine", {}).setdefault("dispatchCursors", {})
    last_key = cursors.get(cursor_key) if isinstance(cursors, dict) else None
    if last_key in keys:
        return candidates[(keys.index(last_key) + 1) % len(candidates)]
    return candidates[0]


def record_dispatch_cursor(state: Dict[str, Any], *, role: str, target_kind: str, target_key: str) -> None:
    cursors = state.setdefault("sprintengine", {}).setdefault("dispatchCursors", {})
    if isinstance(cursors, dict):
        cursors[f"{role}:{target_kind}"] = target_key


def current_dispatch_matches_task(agent: Dict[str, Any], task: Dict[str, Any], reason: str) -> bool:
    dispatch = agent.get("currentDispatch")
    if not isinstance(dispatch, dict):
        return False
    return (
        dispatch.get("targetKind") == "task"
        and dispatch.get("taskId") == task.get("id")
        and dispatch.get("reason") == reason
        and bool(dispatch.get("dispatchId"))
    )


def reconcile_worker(state: Dict[str, Any], worker_id: str, role: str) -> Dict[str, Any]:
    """Reconnect a joining/claiming worker to its active-lease task, or idle it.

    The lease-based replacement for the agents-map reconcile: a worker's active
    task is the one whose active lease it holds (found via the denormalized
    `ownerAgentId`), not a mirror pointer. The agents-map record is synced for
    display only. Returns the same {agent, activeTask, dirty} shape its callers
    (task.next, join) already consume.
    """
    # A first-seen worker must persist its fresh mirror record so the projection
    # shows it even before it claims (the old ensure_agent_for_reconcile signalled
    # this via a creation flag). Detecting it here is mirror bookkeeping, not
    # authority — the lease governs assignment.
    agents = state.get("agents")
    existed = isinstance(agents, dict) and isinstance(agents.get(worker_id), dict)
    agent = ensure_agent(state, worker_id, role)
    dirty = (not existed) or set_if_changed(agent, "role", role)
    active = next(
        (t for t in state.get("tasks", []) or []
         if isinstance(t, dict) and active_lease_worker(t) == worker_id),
        None,
    )
    if active is not None:
        dirty = set_if_changed(active, "ownerAgentId", worker_id) or dirty
        dirty = set_agent_active(agent, active, refresh_heartbeat=False) or dirty
        return {"agent": agent, "activeTask": active, "repairs": [], "dirty": dirty}
    if agent_is_retired(agent):
        dirty = set_if_changed(agent, "currentTaskId", None) or dirty
    else:
        dirty = set_agent_idle(agent) or dirty
    return {"agent": agent, "activeTask": None, "repairs": [], "dirty": dirty}


def role_runtime(state: Dict[str, Any], role: Optional[str]) -> Dict[str, Any]:
    """The recorded {model, cli} the roster configured for `role`, or {}.

    Written once at run init from the workspace roster's per-role model/CLI
    selection (see cmd_init). This is the source of truth for stamping a task's
    execution model on the normal Multicode path, where claims arrive over the
    shared HTTP MCP hub with no per-agent context to carry the model.
    """
    role_key = str(role or "").strip()
    if not role_key:
        return {}
    runtimes = state.get("roleRuntimes")
    if not isinstance(runtimes, dict):
        return {}
    entry = runtimes.get(role_key)
    return entry if isinstance(entry, dict) else {}


def stamp_task_execution_identity(
    state: Dict[str, Any],
    task: Dict[str, Any],
    *,
    model: Optional[str] = None,
    cli: Optional[str] = None,
) -> None:
    """Stamp the CLI model/CLI that worked `task` onto the task record.

    The value carries "what ran" and is retained through handoff (never cleared
    with ownerAgentId), for attribution and per-task usage metrics. Precedence:
    explicit override (headless --model/--cli) > the run's per-role runtime map
    (`role_runtime`). Last-write-wins; a blank never clobbers a good value, so a
    role on the CLI default (empty runtime) records nothing. Called wherever a
    task is activated for a worker — both `assign_task` (worker claims) and the
    architect plan-approval / product-intake tasks that are activated directly.
    """
    runtime = role_runtime(state, task.get("role"))
    resolved_model = (model or "").strip() or str(runtime.get("model") or "").strip()
    resolved_cli = (cli or "").strip() or str(runtime.get("cli") or "").strip()
    if resolved_model:
        task["model"] = resolved_model
    if resolved_cli:
        task["cli"] = resolved_cli


def assign_task(
    state: Dict[str, Any],
    task: Dict[str, Any],
    agent_id: str,
    *,
    model: Optional[str] = None,
    cli: Optional[str] = None,
) -> Dict[str, Any]:
    task["ownerAgentId"] = agent_id
    task["status"] = "in_progress"
    task["startedAt"] = task.get("startedAt") or now_iso()
    # The lease on the task record is the assignment authority; ownerAgentId is
    # its denormalized owner. One worker/model owns a task start-to-finish
    # (MC-1444), so a single model/cli field per task is faithful.
    mint_lease(task, agent_id, task.get("role"))
    stamp_task_execution_identity(state, task, model=model, cli=cli)
    agent = ensure_agent(state, agent_id, task.get("role"))
    set_agent_active(agent, task)
    dispatch = queue_dispatch_record(
        state,
        agent_id=agent_id,
        role=str(task.get("role") or agent.get("role") or ""),
        target_kind="task",
        task_id=str(task.get("id") or ""),
        task_status=str(task.get("status") or ""),
        reason="task_claimed",
    )
    agent["currentDispatch"] = current_dispatch_payload(
        dispatch_id=dispatch["id"],
        target_kind="task",
        role=str(task.get("role") or agent.get("role") or ""),
        reason="task_claimed",
        task_id=str(task.get("id") or ""),
        assigned_at=dispatch["timestamp"],
    )
    agent["lastDirectiveAt"] = dispatch["timestamp"]
    record_dispatch_cursor(
        state,
        role=str(task.get("role") or agent.get("role") or ""),
        target_kind="task",
        target_key=dispatch_target_key("task", task.get("id")),
    )
    append_task_activity(task, "claim", agent_id, f"{agent_id} claimed {task.get('id')}.")
    return {"agent": agent}


def next_comment_id(task: Dict[str, Any]) -> str:
    comments = task.setdefault("comments", [])
    if not isinstance(comments, list):
        task["comments"] = []
        comments = task["comments"]
    max_index = 0
    for comment in comments:
        if not isinstance(comment, dict):
            continue
        match = re.fullmatch(r"C(\d+)", str(comment.get("id") or ""))
        if match:
            max_index = max(max_index, int(match.group(1)))
    return f"C{max_index + 1}"


def create_task_comment(
    state: Dict[str, Any],
    task: Dict[str, Any],
    *,
    actor: str,
    body: str,
    comment_type: str,
    source: str = "agent",
    paths: Optional[List[str]] = None,
    data: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    clean_body = str(body or "").strip()
    if not clean_body:
        raise SystemExit("Task comment body cannot be empty.")
    if comment_type not in VALID_TASK_COMMENT_TYPES:
        raise SystemExit(f"Invalid task comment type {comment_type!r}.")
    clean_paths = [folder_store.validate_project_relative_path(path, field="--path") for path in (paths or []) if str(path).strip()]
    # The author's role is derived from the run's records (lease / owned tasks /
    # minted-id convention), never the agents map, falling back to the task's role
    # when the author cannot be attributed to one (e.g. the human operator).
    author_role = worker_role(state, actor) or str(task.get("role") or "").strip()
    comment = {
        "id": next_comment_id(task),
        "type": comment_type,
        "actor": actor,
        "authorAgentId": actor,
        "authorRole": author_role,
        "source": source,
        "body": clean_body,
        "createdAt": now_iso(),
    }
    if clean_paths:
        comment["paths"] = clean_paths
    if data:
        comment["data"] = {key: value for key, value in data.items() if value not in (None, "", [])}
    task.setdefault("comments", []).append(comment)
    append_task_activity(
        task,
        "comment",
        actor,
        clean_body,
        {"commentId": comment["id"], "commentType": comment_type, "source": source},
    )
    return comment
