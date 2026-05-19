"""Run-state, roster, task, gate, and lock helpers for Sprint Engine."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from sprintengine_core import store as folder_store
from sprintengine_core.tool.constants import *  # noqa: F403,F401
from sprintengine_core.tool.paths import now_iso
from sprintengine_core.tool.roles import VALID_ROLES

def parse_agent_specs(values: Optional[List[str]]) -> Dict[str, Dict[str, Any]]:
    agents: Dict[str, Dict[str, Any]] = {}
    for raw in values or []:
        spec = raw.strip()
        if not spec:
            continue
        if ":" not in spec:
            raise SystemExit("--agent must use role:id, for example --agent developer:developer-1")
        role, agent_id = [part.strip() for part in spec.split(":", 1)]
        if role not in VALID_ROLES:
            raise SystemExit(f"--agent has invalid role {role!r}.")
        if not agent_id:
            raise SystemExit("--agent id cannot be empty.")
        if agent_id in agents and agents[agent_id].get("role") != role:
            raise SystemExit(f"--agent {agent_id!r} is declared with multiple roles.")
        agents[agent_id] = {"role": role, "status": "idle", "currentTaskId": None}
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


def roster_roles(state: Dict[str, Any]) -> set[str]:
    return {
        str(agent.get("role"))
        for agent in state.get("agents", {}).values()
        if isinstance(agent, dict) and str(agent.get("role")) in VALID_ROLES
    }


def roster_is_configured(state: Dict[str, Any]) -> bool:
    return bool(state.get("sprintengine", {}).get("rosterConfigured"))


def ensure_role_in_roster(state: Dict[str, Any], role: str) -> None:
    roles = roster_roles(state)
    if roster_is_configured(state) and role not in roles:
        raise SystemExit(
            f"Role {role!r} is not in this Sprint Engine roster. "
            "Add a roster member for that role before creating tasks for it."
        )


def agent_is_retired(agent: Optional[Dict[str, Any]]) -> bool:
    return isinstance(agent, dict) and agent.get("status") in TERMINAL_AGENT_STATUSES


def ensure_agent_in_roster(state: Dict[str, Any], agent_id: str, role: str, *, allow_retired: bool = False) -> None:
    existing_agent = state.get("agents", {}).get(agent_id)
    if agent_is_retired(existing_agent) and not allow_retired:
        raise SystemExit(f"Agent {agent_id!r} is retired and cannot claim more Sprint Engine work.")
    if not roster_is_configured(state):
        return
    if not isinstance(existing_agent, dict):
        raise SystemExit(f"Agent {agent_id!r} is not in this Sprint Engine roster.")
    if existing_agent.get("role") != role:
        raise SystemExit(f"Agent {agent_id!r} is rostered as {existing_agent.get('role')!r}, not {role!r}.")


def add_roster_agent(state: Dict[str, Any], role: str, agent_id: str, actor: str) -> Dict[str, Any]:
    if role not in VALID_ROLES:
        raise SystemExit(f"Invalid roster role {role!r}.")
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

    agent = {"role": role, "status": "idle", "currentTaskId": None}
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
    agent = agents.setdefault(agent_id, {"role": role or "developer", "status": "idle", "currentTaskId": None})
    if role and not agent.get("role"):
        agent["role"] = role
    agent.setdefault("status", "idle")
    agent.setdefault("currentTaskId", None)
    return agent


def set_agent_idle(agent: Dict[str, Any]) -> bool:
    changed = set_if_changed(agent, "status", "idle")
    changed = set_if_changed(agent, "currentTaskId", None) or changed
    return changed


def set_agent_active(agent: Dict[str, Any], task: Dict[str, Any]) -> bool:
    changed = set_if_changed(agent, "status", "needs_input" if task.get("status") == "needs_input" else "running")
    changed = set_if_changed(agent, "currentTaskId", task.get("id")) or changed
    return changed


def clear_task_refs(state: Dict[str, Any], task_id: str) -> List[str]:
    cleared = []
    for agent_id, agent in state.get("agents", {}).items():
        if isinstance(agent, dict) and agent.get("currentTaskId") == task_id:
            set_agent_idle(agent)
            cleared.append(str(agent_id))
    return cleared


def ensure_agent_for_reconcile(state: Dict[str, Any], agent_id: str, role: str) -> tuple[Dict[str, Any], bool]:
    agents = state.setdefault("agents", {})
    agent = agents.get(agent_id)
    if not isinstance(agent, dict):
        agent = {"role": role, "status": "idle", "currentTaskId": None}
        agents[agent_id] = agent
        return agent, True

    changed = False
    if not agent.get("role"):
        changed = set_if_changed(agent, "role", role) or changed
    if "status" not in agent:
        changed = set_if_changed(agent, "status", "idle") or changed
    if "currentTaskId" not in agent:
        changed = set_if_changed(agent, "currentTaskId", None) or changed
    return agent, changed


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
            dirty = set_agent_active(agent, current_task) or dirty
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
        dirty = set_agent_active(agent, active_task) or dirty
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


def assign_task(state: Dict[str, Any], task: Dict[str, Any], agent_id: str) -> Dict[str, Any]:
    task["ownerAgentId"] = agent_id
    task["status"] = "in_progress"
    task["startedAt"] = task.get("startedAt") or now_iso()
    agent = ensure_agent(state, agent_id, task.get("role"))
    set_agent_active(agent, task)
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
