"""Run-state, roster, task, gate, and lock helpers for Sprint Engine."""

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
    workspace roster's enabled roles. This is the source of truth for quality-gate
    derivation (see store.configured_gate_roles), so a lazy, architect-only roster
    still derives its required reviewer/tester gates: the gate role need only be
    enabled here, not currently seated in `agents`. Deliberately distinct from
    `roleRuntimes`, whose keys include CLI-default roles. Blank/absent input
    leaves the key untouched so legacy runs fall back to the seated-roster roles.
    An explicit empty array records an empty enabled set (no derived gates).
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


def roster_roles(state: Dict[str, Any]) -> set[str]:
    return {
        str(agent.get("role")).strip()
        for agent in state.get("agents", {}).values()
        if isinstance(agent, dict) and str(agent.get("role") or "").strip()
    }


def roster_is_configured(state: Dict[str, Any]) -> bool:
    return bool(state.get("sprintengine", {}).get("rosterConfigured"))


def ensure_role_in_roster(state: Dict[str, Any], role: str) -> None:
    role = require_configured_role(role, context="Role")
    roles = roster_roles(state)
    if roster_is_configured(state) and role not in roles:
        raise SystemExit(
            f"Role {role!r} is not in this Sprint Engine roster. "
            "Add a roster member for that role before creating tasks for it."
        )


def agent_is_retired(agent: Optional[Dict[str, Any]]) -> bool:
    return isinstance(agent, dict) and agent.get("status") in TERMINAL_AGENT_STATUSES


def ensure_agent_in_roster(state: Dict[str, Any], agent_id: str, role: str, *, allow_retired: bool = False) -> None:
    role = require_configured_role(role, context="Agent role")
    existing_agent = state.get("agents", {}).get(agent_id)
    if agent_is_retired(existing_agent) and not allow_retired:
        raise SystemExit(f"Agent {agent_id!r} is retired and cannot claim more Sprint Engine work.")
    if not roster_is_configured(state):
        return
    if not isinstance(existing_agent, dict):
        raise SystemExit(f"Agent {agent_id!r} is not in this Sprint Engine roster.")
    if existing_agent.get("role") != role:
        raise SystemExit(f"Agent {agent_id!r} is rostered as {existing_agent.get('role')!r}, not {role!r}.")


def lazily_register_reviewer_id(state: Dict[str, Any], agent_id: str, role: str, *, actor: str = "sprintengine") -> bool:
    """Register a reviewer role's persistent id on its first gate claim.

    Gate work never mints a fresh id per gate: the first gate dispatch/claim for a
    role whose persistent reviewer id is not yet seated registers that exact id in
    run.yaml (under the gate-queue lock the caller already holds), and every later
    gate claim by the same role reuses it. The id the caller supplies is the role's
    deterministic reviewer id (bare ``<role>``), so the renderer can target it for
    spawn. Registration goes through the normal agent path and never appends to
    ``ownedTaskIds``, so a reviewer id is never task-capped. Returns True when a new
    roster entry was created (so the caller can persist the write).

    A legacy/headless run with no configured roster keeps ad-hoc identity: presence
    is not required and downstream ``ensure_agent`` creates the record, so this does
    not flip such a run into configured-roster mode.
    """
    role = require_configured_role(role, context="Gate role")
    existing = state.get("agents", {}).get(agent_id)
    if agent_is_retired(existing):
        raise SystemExit(f"Agent {agent_id!r} is retired and cannot claim more Sprint Engine work.")
    if not roster_is_configured(state):
        return False
    if isinstance(existing, dict):
        if existing.get("role") != role:
            raise SystemExit(f"Agent {agent_id!r} is rostered as {existing.get('role')!r}, not {role!r}.")
        return False
    add_roster_agent(state, role, agent_id, actor)
    return True


def add_roster_agent(state: Dict[str, Any], role: str, agent_id: str, actor: str) -> Dict[str, Any]:
    role = require_configured_role(role, context="Roster")
    clean_id = agent_id.strip()
    if not clean_id:
        raise SystemExit("--id cannot be empty.")

    agents = state.setdefault("agents", {})
    existing = agents.get(clean_id)
    if isinstance(existing, dict):
        if existing.get("role") != role:
            raise SystemExit(f"Agent {clean_id!r} already exists with role {existing.get('role')!r}.")
        state.setdefault("sprintengine", {})["rosterConfigured"] = True
        return existing

    timestamp = now_iso()
    agent = {
        "role": role,
        "status": "idle",
        "heartbeatAt": timestamp,
        "subscription": {"mode": "none"},
        "currentDispatch": None,
        "joinedAt": timestamp,
        "currentTaskId": None,
    }
    agents[clean_id] = agent
    state.setdefault("sprintengine", {})["rosterConfigured"] = True
    append_event(state, "roster_member_added", actor, f"{actor} added {clean_id} to the Sprint Engine roster as {role}.")
    return agent


def next_replacement_agent_id(state: Dict[str, Any], role: str) -> str:
    agents = state.get("agents", {})
    used = {str(agent_id) for agent_id in agents.keys()}
    pattern = re.compile(rf"^{re.escape(role)}(?:-(\d+))?$")
    highest = 0
    for agent_id in used:
        match = pattern.match(agent_id)
        if not match:
            continue
        highest = max(highest, int(match.group(1) or "1"))
    candidate_index = max(2, highest + 1)
    while True:
        candidate = f"{role}-{candidate_index}"
        if candidate not in used:
            return candidate
        candidate_index += 1


def role_has_open_work(state: Dict[str, Any], role: str) -> bool:
    for task in state.get("tasks", []) or []:
        if not isinstance(task, dict):
            continue
        if task.get("role") == role and task.get("status") not in {"done", "canceled"}:
            return True
        for gate in task_quality_gates(task):
            if gate.get("role") == role and gate.get("status") in {"pending", "in_progress", "changes_requested", "blocked"}:
                return True
    return False


def retired_agent_has_live_replacement(state: Dict[str, Any], retired_agent: Dict[str, Any]) -> bool:
    replacement_id = str(retired_agent.get("replacedByAgentId") or "").strip()
    if not replacement_id:
        return False
    replacement = state.get("agents", {}).get(replacement_id)
    return isinstance(replacement, dict) and not agent_is_retired(replacement)


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
    if _legacy_projection_is_current(path):
        return _load_legacy_state_projection(path)
    if folder_store_is_ready_for_state(path):
        return folder_store.state_from_folder_store(path.parent)
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
    if "currentGateId" in agent:
        agent.pop("currentGateId", None)
        changed = True
    if "currentGate" in agent:
        agent.pop("currentGate", None)
        changed = True
    changed = set_if_changed(agent, "currentDispatch", None) or changed
    changed = set_if_changed(agent, "heartbeatAt", now_iso()) or changed
    return changed


def append_owned_task_id(agent: Dict[str, Any], task_id: Any) -> bool:
    """Record `task_id` in the agent's durable ownedTaskIds set (append-once).

    Task-scoped roster ids own a task for their whole lifetime; ownedTaskIds is
    the authoritative per-id ownership record the claim guard reads. Re-claiming
    an already-owned task (rework respawn) is a no-op, so the set never grows on
    rework and a per_task id keeps exactly one entry.
    """
    clean_id = str(task_id or "").strip()
    if not clean_id:
        return False
    owned = agent.get("ownedTaskIds")
    if not isinstance(owned, list):
        owned = []
        agent["ownedTaskIds"] = owned
    if clean_id in owned:
        return False
    owned.append(clean_id)
    return True


def agent_owned_task_ids(agent: Dict[str, Any]) -> set[str]:
    """Every task this id owns, unioning ownedTaskIds with lastOwnedTaskId.

    lastOwnedTaskId is included so a roster entry written before ownedTaskIds
    existed (mid-run upgrade) still reports its owned task to the claim guard.
    """
    owned = {
        str(task_id).strip()
        for task_id in (agent.get("ownedTaskIds") or [])
        if str(task_id).strip()
    }
    last_owned = str(agent.get("lastOwnedTaskId") or "").strip()
    if last_owned:
        owned.add(last_owned)
    return owned


def task_claim_exceeds_worker_capacity(state: Dict[str, Any], agent: Dict[str, Any], task_id: Any) -> bool:
    """True when claiming `task_id` would push this id past its task-ownership cap.

    Under the per_task policy an id owns at most one task for life. Re-claiming a
    task the id already owns (rework respawn) is always allowed; only a claim on
    a DIFFERENT task by an id already at its cap is refused. A non-per_task policy
    (none exist yet) imposes no cap.
    """
    policy = folder_store.worker_assignment_policy(state)
    if policy != folder_store.WORKER_ASSIGNMENT_PER_TASK:
        return False
    owned = agent_owned_task_ids(agent)
    if str(task_id or "").strip() in owned:
        return False
    return len(owned) >= 1


def set_agent_active(agent: Dict[str, Any], task: Dict[str, Any], *, refresh_heartbeat: bool = True) -> bool:
    changed = set_if_changed(agent, "status", "needs_input" if task.get("status") == "needs_input" else "running")
    changed = set_if_changed(agent, "currentTaskId", task.get("id")) or changed
    # Durable task-ownership record for task-scoped worker lifecycle (MC-1444):
    # unlike currentTaskId, this survives set_agent_idle/reconcile so the
    # dispatch planner can tell "finished a task" from "never had one".
    # Invariant: every flow that establishes task ownership must pass through
    # here (assign_task/reconcile do; the direct currentTaskId reactivation
    # writes in artifacts.py/task.py only re-activate owners already stamped).
    # A missing stamp is failure-safe — the planner treats the agent as
    # never-owned and falls back to the reuse-preferring lifecycle.
    changed = set_if_changed(agent, "lastOwnedTaskId", task.get("id")) or changed
    changed = append_owned_task_id(agent, task.get("id")) or changed
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
    agent["status"] = "idle" if agent.get("status") in {None, "", "left", "dead"} else agent.get("status", "idle")
    agent["heartbeatAt"] = timestamp
    clear_terminal_state_metadata(agent)
    agent.setdefault("joinedAt", timestamp)
    mode = subscription_mode if subscription_mode in {"none", "poll", "mcp_notifications"} else "none"
    agent["subscription"] = {"mode": mode}
    if mode != "none":
        agent["subscription"]["subscribedAt"] = timestamp
    return agent


def record_agent_heartbeat(state: Dict[str, Any], agent_id: str, role: Optional[str] = None) -> Dict[str, Any]:
    agent = ensure_agent(state, agent_id, role or None)
    agent["heartbeatAt"] = now_iso()
    return agent


def record_agent_leave(state: Dict[str, Any], agent_id: str, role: Optional[str] = None, *, reason: str = "") -> Dict[str, Any]:
    agent = ensure_agent(state, agent_id, role or None)
    timestamp = now_iso()
    agent["status"] = "left"
    agent["leftAt"] = timestamp
    agent["heartbeatAt"] = timestamp
    if reason:
        agent["leaveReason"] = reason
    set_agent_idle(agent)
    agent["status"] = "left"
    agent["leftAt"] = timestamp
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


def agent_is_expired(state: Dict[str, Any], agent: Dict[str, Any], *, now: Optional[datetime] = None) -> bool:
    status = str(agent.get("status") or "")
    if status in TERMINAL_AGENT_STATUSES or status in {"left", "dead"}:
        return False
    heartbeat = parse_utc_timestamp(agent.get("heartbeatAt"))
    if heartbeat is None:
        return False
    current = now or datetime.now(timezone.utc)
    return (current - heartbeat).total_seconds() > agent_liveness_timeout_seconds(state)


def find_gate_by_claim(
    state: Dict[str, Any],
    task_id: Any,
    gate_id: Any,
    attempt_id: Any,
    *,
    claimed_by: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    task = find_task_by_id(state, task_id)
    if not task:
        return None
    for gate in task_quality_gates(task):
        if gate.get("id") != gate_id:
            continue
        for attempt in reversed(gate_attempts(gate)):
            if attempt.get("id") == attempt_id:
                return {"task": task, "gate": gate, "attempt": attempt}
        if claimed_by:
            for attempt in reversed(gate_attempts(gate)):
                if attempt.get("status") == "in_progress" and attempt.get("claimedBy") == claimed_by:
                    return {"task": task, "gate": gate, "attempt": attempt}
        return {"task": task, "gate": gate, "attempt": None}
    return None


def current_gate_reference(agent: Dict[str, Any]) -> Dict[str, Any]:
    current_gate = agent.get("currentGate") if isinstance(agent.get("currentGate"), dict) else {}
    return {
        "taskId": current_gate.get("taskId") or agent.get("currentTaskId"),
        "gateId": current_gate.get("gateId") or agent.get("currentGateId"),
        "attemptId": current_gate.get("attemptId"),
    }


def release_expired_agent_targets(
    state: Dict[str, Any],
    *,
    actor: str = "sprintengine",
    excluding_agent_id: Optional[str] = None,
) -> Dict[str, Any]:
    released: List[Dict[str, Any]] = []
    current = datetime.now(timezone.utc)
    for agent_id, agent in list(state.get("agents", {}).items()):
        if excluding_agent_id and agent_id == excluding_agent_id:
            continue
        if not isinstance(agent, dict):
            continue
        dispatch = agent.get("currentDispatch") if isinstance(agent.get("currentDispatch"), dict) else {}
        gate_ref = current_gate_reference(agent)
        has_target_mirror = agent.get("currentTaskId") or dispatch.get("targetKind") or gate_ref.get("gateId")
        if not has_target_mirror:
            continue
        if agent.get("status") != "dead" and not agent_is_expired(state, agent, now=current):
            continue
        role = str(agent.get("role") or "")
        task_id = agent.get("currentTaskId") or dispatch.get("taskId") or gate_ref.get("taskId")
        gate_id = dispatch.get("gateId") or gate_ref.get("gateId")
        attempt_id = dispatch.get("attemptId") or gate_ref.get("attemptId")
        target_kind = str(dispatch.get("targetKind") or ("gate" if gate_id else "task" if task_id else ""))
        released_target: Dict[str, Any] = {"agentId": agent_id, "role": role, "targetKind": target_kind}
        released_actual_target = False

        if target_kind == "gate":
            gate_claim = find_gate_by_claim(state, task_id, gate_id, attempt_id, claimed_by=str(agent_id))
            if gate_claim:
                task = gate_claim["task"]
                gate = gate_claim["gate"]
                attempt = gate_claim.get("attempt")
                if gate.get("status") == "in_progress":
                    gate["status"] = "pending"
                    released_actual_target = True
                if isinstance(attempt, dict) and attempt.get("status") == "in_progress":
                    attempt["status"] = "released"
                    attempt["completedAt"] = now_iso()
                    released_actual_target = True
                append_task_activity(
                    task,
                    "gate_release",
                    actor,
                    f"{actor} released expired gate claim {gate.get('id')} from {agent_id}.",
                    {"gateId": gate.get("id"), "previousOwnerAgentId": agent_id, "reason": "agent_expired"},
                )
                released_target.update({"taskId": task.get("id"), "gateId": gate.get("id")})
        else:
            task = find_task_by_id(state, task_id)
            if task and task.get("ownerAgentId") == agent_id and task.get("status") in {"in_progress", "changes_requested"}:
                previous_status = str(task.get("status") or "")
                task["ownerAgentId"] = None
                task["status"] = "todo" if previous_status == "in_progress" else previous_status
                task["startedAt"] = None if previous_status == "in_progress" else task.get("startedAt")
                task["completedAt"] = None
                append_task_activity(
                    task,
                    "status_change",
                    actor,
                    f"{actor} released expired task claim from {agent_id}.",
                    {"status": task.get("status"), "fromStatus": previous_status, "previousOwnerAgentId": agent_id, "reason": "agent_expired"},
                )
                released_target.update({"taskId": task.get("id"), "fromStatus": previous_status, "status": task.get("status")})
                released_actual_target = True

        if not released_actual_target:
            continue

        queue_dispatch_record(
            state,
            agent_id=str(agent_id),
            role=role,
            target_kind=target_kind or "agent",
            task_id=str(released_target.get("taskId") or ""),
            gate_id=str(released_target.get("gateId") or ""),
            reason="agent_expired_release",
        )
        agent["status"] = "dead"
        agent["deadAt"] = now_iso()
        agent["heartbeatAt"] = agent["deadAt"]
        agent["deathReason"] = "heartbeat_expired"
        set_agent_idle(agent)
        agent["status"] = "dead"
        agent["deadAt"] = agent["heartbeatAt"]
        released.append(released_target)

    if released:
        append_event(
            state,
            "agent_targets_released",
            actor,
            f"{actor} released {len(released)} expired agent target(s).",
            {"releasedCount": len(released)},
        )
    return {"released": released, "dirty": bool(released)}


def clear_task_refs(state: Dict[str, Any], task_id: str) -> List[str]:
    cleared = []
    for agent_id, agent in state.get("agents", {}).items():
        if isinstance(agent, dict) and agent.get("currentTaskId") == task_id:
            if agent.get("status") in TERMINAL_AGENT_STATUSES or agent.get("status") in {"left", "dead"}:
                set_if_changed(agent, "currentTaskId", None)
                if "currentGateId" in agent:
                    agent.pop("currentGateId", None)
                if "currentGate" in agent:
                    agent.pop("currentGate", None)
                set_if_changed(agent, "currentDispatch", None)
            else:
                set_agent_idle(agent)
            cleared.append(str(agent_id))
    return cleared


def ensure_agent_for_reconcile(state: Dict[str, Any], agent_id: str, role: str) -> tuple[Dict[str, Any], bool]:
    agents = state.setdefault("agents", {})
    agent = agents.get(agent_id)
    timestamp = now_iso()
    if not isinstance(agent, dict):
        agent = {
            "role": role,
            "status": "idle",
            "heartbeatAt": timestamp,
            "subscription": {"mode": "none"},
            "currentDispatch": None,
            "joinedAt": timestamp,
            "currentTaskId": None,
        }
        agents[agent_id] = agent
        return agent, True

    changed = False
    if not agent.get("role"):
        changed = set_if_changed(agent, "role", role) or changed
    if "status" not in agent:
        changed = set_if_changed(agent, "status", "idle") or changed
    if "heartbeatAt" not in agent:
        changed = set_if_changed(agent, "heartbeatAt", timestamp) or changed
    if "subscription" not in agent:
        changed = set_if_changed(agent, "subscription", {"mode": "none"}) or changed
    if "currentDispatch" not in agent:
        changed = set_if_changed(agent, "currentDispatch", None) or changed
    if "joinedAt" not in agent:
        changed = set_if_changed(agent, "joinedAt", timestamp) or changed
    if "currentTaskId" not in agent:
        changed = set_if_changed(agent, "currentTaskId", None) or changed
    return agent, changed


def current_dispatch_payload(
    *,
    dispatch_id: str,
    target_kind: str,
    role: str,
    reason: str,
    task_id: Optional[str] = None,
    gate_id: Optional[str] = None,
    attempt_id: Optional[str] = None,
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
    if gate_id:
        payload["gateId"] = gate_id
    if attempt_id:
        payload["attemptId"] = attempt_id
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
    gate_id: Optional[str] = None,
    gate_status: Optional[str] = None,
    attempt_id: Optional[str] = None,
) -> Dict[str, Any]:
    timestamp = now_iso()
    target = {"kind": target_kind}
    if task_id:
        target["taskId"] = task_id
    if gate_id:
        target["gateId"] = gate_id
    if attempt_id:
        target["attemptId"] = attempt_id
    record = {
        "timestamp": timestamp,
        "agentId": agent_id,
        "role": role,
        "target": target,
        "reason": reason,
        "state": {
            "taskStatus": task_status,
            "gateStatus": gate_status,
        },
        "outcome": "dispatched",
        "source": "core",
    }
    record["id"] = folder_store.dispatch_id_for_record(record)
    state.setdefault("_dispatchRecords", []).append(record)
    return record


def dispatch_target_key(target_kind: str, task_id: Any = None, gate_id: Any = None) -> str:
    if target_kind == "gate":
        return f"gate:{task_id}:{gate_id}"
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


def latest_rework_gate_attempt(task: Dict[str, Any]) -> dict[str, str]:
    latest: dict[str, str] = {}
    latest_completed = ""
    for gate in task.get("qualityGates") or []:
        if not isinstance(gate, dict):
            continue
        gate_id = str(gate.get("id") or "")
        for attempt in gate.get("attempts") or []:
            if not isinstance(attempt, dict):
                continue
            verdict = str(attempt.get("verdict") or attempt.get("status") or "")
            completed_at = str(attempt.get("completedAt") or "")
            attempt_id = str(attempt.get("id") or "")
            if verdict not in {"changes_requested", "failed"} or not attempt_id:
                continue
            if not latest or completed_at >= latest_completed:
                latest_completed = completed_at
                latest = {"gateId": gate_id, "attemptId": attempt_id}
    return latest


def current_dispatch_matches_task(
    agent: Dict[str, Any],
    task: Dict[str, Any],
    reason: str,
    *,
    gate_id: Optional[str] = None,
    attempt_id: Optional[str] = None,
) -> bool:
    dispatch = agent.get("currentDispatch")
    if not isinstance(dispatch, dict):
        return False
    matches = (
        dispatch.get("targetKind") == "task"
        and dispatch.get("taskId") == task.get("id")
        and dispatch.get("reason") == reason
        and bool(dispatch.get("dispatchId"))
    )
    if gate_id is not None:
        matches = matches and dispatch.get("gateId") == gate_id
    if attempt_id is not None:
        matches = matches and dispatch.get("attemptId") == attempt_id
    return matches


def current_dispatch_matches_gate(
    agent: Dict[str, Any],
    task: Dict[str, Any],
    gate: Dict[str, Any],
    attempt: Dict[str, Any],
    reason: str,
) -> bool:
    dispatch = agent.get("currentDispatch")
    if not isinstance(dispatch, dict):
        return False
    return (
        dispatch.get("targetKind") == "gate"
        and dispatch.get("taskId") == task.get("id")
        and dispatch.get("gateId") == gate.get("id")
        and dispatch.get("attemptId") == attempt.get("id")
        and dispatch.get("reason") == reason
        and bool(dispatch.get("dispatchId"))
    )


def ensure_gate_dispatch(
    state: Dict[str, Any],
    agent: Dict[str, Any],
    task: Dict[str, Any],
    gate: Dict[str, Any],
    attempt: Dict[str, Any],
    agent_id: str,
    role: str,
) -> bool:
    if gate.get("status") != "in_progress" or attempt.get("status") != "in_progress":
        return False
    reason = "gate_claimed"
    if current_dispatch_matches_gate(agent, task, gate, attempt, reason):
        return False
    dispatch = queue_dispatch_record(
        state,
        agent_id=agent_id,
        role=role,
        target_kind="gate",
        task_id=str(task.get("id") or ""),
        task_status=str(task.get("status") or ""),
        gate_id=str(gate.get("id") or ""),
        gate_status=str(gate.get("status") or ""),
        attempt_id=str(attempt.get("id") or ""),
        reason=reason,
    )
    agent["currentDispatch"] = current_dispatch_payload(
        dispatch_id=dispatch["id"],
        target_kind="gate",
        role=role,
        reason=reason,
        task_id=str(task.get("id") or ""),
        gate_id=str(gate.get("id") or ""),
        attempt_id=str(attempt.get("id") or ""),
        assigned_at=dispatch["timestamp"],
    )
    agent["lastDirectiveAt"] = dispatch["timestamp"]
    return True


def reconcile_agent(state: Dict[str, Any], agent_id: str, role: str) -> Dict[str, Any]:
    agent, dirty = ensure_agent_for_reconcile(state, agent_id, role)
    dirty = set_if_changed(agent, "role", role) or dirty
    repairs = []

    current_task_id = agent.get("currentTaskId")
    if current_task_id:
        current_task = find_task_by_id(state, current_task_id)
        if not current_task or current_task.get("status") not in ACTIVE_TASK_STATUSES:
            dirty = set_agent_idle(agent) or dirty
            repairs.append(f"cleared stale task ref {current_task_id}")
        elif current_task.get("ownerAgentId") in (None, "", agent_id):
            dirty = set_if_changed(current_task, "ownerAgentId", agent_id) or dirty
            dirty = set_agent_active(agent, current_task, refresh_heartbeat=False) or dirty
            return {"agent": agent, "activeTask": current_task, "repairs": repairs, "dirty": dirty}
        else:
            dirty = set_agent_idle(agent) or dirty
            repairs.append(f"cleared task {current_task_id} owned by {current_task.get('ownerAgentId')}")

    active_task = next(
        (t for t in state.get("tasks", [])
         if isinstance(t, dict) and t.get("ownerAgentId") == agent_id and t.get("status") in ACTIVE_TASK_STATUSES),
        None,
    )
    if active_task:
        dirty = set_agent_active(agent, active_task, refresh_heartbeat=False) or dirty
        return {"agent": agent, "activeTask": active_task, "repairs": repairs, "dirty": dirty}

    if agent_is_retired(agent):
        dirty = set_if_changed(agent, "currentTaskId", None) or dirty
        if "currentGateId" in agent:
            agent.pop("currentGateId", None)
            dirty = True
        return {"agent": agent, "activeTask": None, "repairs": repairs, "dirty": dirty}

    if agent.get("status") == "done":
        dirty = set_if_changed(agent, "currentTaskId", None) or dirty
        return {"agent": agent, "activeTask": None, "repairs": repairs, "dirty": dirty}

    dirty = set_agent_idle(agent) or dirty
    return {"agent": agent, "activeTask": None, "repairs": repairs, "dirty": dirty}


def clear_non_active_task_owner_claims(state: Dict[str, Any]) -> bool:
    dirty = False
    non_active_owned_statuses = {"review", "testing", "product", "changes_requested", "done"}
    for task in state.get("tasks", []) or []:
        if not isinstance(task, dict):
            continue
        task_id = str(task.get("id") or "")
        if task.get("status") not in non_active_owned_statuses or not task.get("ownerAgentId"):
            continue
        previous_owner_id = task.get("ownerAgentId")
        task["ownerAgentId"] = None
        dirty = True
        if task_id:
            cleared_refs = clear_task_refs(state, task_id)
            dirty = bool(cleared_refs) or dirty
        append_task_activity(
            task,
            "status_change",
            "sprintengine",
            f"Sprint Engine cleared stale active owner claim from {task_id}.",
            {"status": task.get("status"), "previousOwnerAgentId": previous_owner_id, "reason": "non_active_status"},
        )
    return dirty


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
    architect plan-gate / product-intake tasks that are activated directly.
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
    # One agent/model owns a task start-to-finish (MC-1444), so a single
    # model/cli field per task is faithful — no per-attempt history.
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


def next_gate_attempt_id(gate: Dict[str, Any]) -> str:
    attempts = gate.setdefault("attempts", [])
    if not isinstance(attempts, list):
        gate["attempts"] = []
        attempts = gate["attempts"]
    max_index = 0
    for attempt in attempts:
        if not isinstance(attempt, dict):
            continue
        match = re.fullmatch(r"GA-(\d+)", str(attempt.get("id") or ""))
        if match:
            max_index = max(max_index, int(match.group(1)))
    return f"GA-{max_index + 1:03d}"


def task_quality_gates(task: Dict[str, Any]) -> List[Dict[str, Any]]:
    gates = task.setdefault("qualityGates", [])
    if not isinstance(gates, list):
        task["qualityGates"] = []
        return task["qualityGates"]
    return [gate for gate in gates if isinstance(gate, dict)]


def gate_attempts(gate: Dict[str, Any]) -> List[Dict[str, Any]]:
    attempts = gate.setdefault("attempts", [])
    if not isinstance(attempts, list):
        gate["attempts"] = []
        return gate["attempts"]
    return attempts


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
    author_role = str(state.get("agents", {}).get(actor, {}).get("role") or task.get("role") or "").strip()
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
