"""Folder-backed Sprint Engine run store primitives."""

from __future__ import annotations

import json
import os
import re
import tempfile
import time
import hashlib
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

try:
    import yaml  # type: ignore
except ImportError as exc:
    raise SystemExit(
        "PyYAML is required. Install with: python3 -m pip install pyyaml"
    ) from exc


TASK_STATUSES = (
    "todo",
    "ready",
    "in_progress",
    "review",
    "testing",
    "product",
    "changes_requested",
    "needs_input",
    "done",
    "canceled",
)
ARTIFACT_STATUSES = (
    "draft",
    "recorded",
    "ready_for_review",
    "approved",
    "changes_requested",
    "superseded",
)
SUPPORT_DIRS = ("metrics", "plan-reviews", "reviews", "validation", "runner")
RUN_FILE = "run.yaml"
EVENTS_FILE = "events.jsonl"
DISPATCH_FILE = "dispatch.jsonl"
FEEDBACK_FILE = "metrics/agent-feedback.jsonl"
PROJECTION_FILE = "projection.json"
LOCK_STATE_FILES = ("runner/run.lock.json", "runner/ready.lock.json")
RUN_LOCK_FILE = "runner/run.queue.lock"
READY_QUEUE_LOCK_FILE = "runner/ready.queue.lock"
CLAIM_QUEUE_LOCK_FILE = "runner/claim.queue.lock"
GATE_QUEUE_LOCK_FILE = "runner/gate.queue.lock"
RUN_SOURCE_KEYS = ("source", "sourceBundle")
DEFAULT_QUALITY_POLICY = {
    "enabled": True,
    "rosterDriven": True,
    "lifecyclePhases": ["review", "testing", "product"],
    "gates": {
        "architect": {
            "phase": "review",
            "role": "architect",
            "required": True,
            "focus": "architecture, state model, projection, CLI, and cross-cutting coordination risk",
        },
        "code_reviewer": {
            "phase": "review",
            "role": "code_reviewer",
            "required": True,
            "focus": "correctness, integration risk, maintainability, regressions, and evidence quality",
        },
        "spec_reviewer": {
            "phase": "review",
            "role": "spec_reviewer",
            "required": True,
            "focus": "requirements coverage, acceptance criteria, behavior gaps, and missing tests",
        },
        "tester": {
            "phase": "testing",
            "role": "tester",
            "required": True,
            "focus": "real-path validation, regression coverage, and reproducible verification",
        },
        "product": {
            "phase": "product",
            "role": "product",
            "required": True,
            "focus": "product acceptance and user-facing behavior",
        },
    },
}
DEFAULT_RUNNER_POLICY = {
    # `cliWatchPolling` controls whether `sprintengine join --watch` keeps
    # polling for new work (`enabled`) or exits when no work is ready
    # (`disabled`). It is a CLI-runtime concern only — Multicode's supervisor
    # ignores it and decides spawning from local renderer autoState. Legacy
    # `mode: auto|off` is read as a fallback by `normalize_runner_policy`.
    "cliWatchPolling": "disabled",
    "pollIntervalSeconds": 10,
    "idleBackoffSeconds": 30,
    "maxBackoffSeconds": 120,
    "stopWhenComplete": True,
}
GATE_PHASES = {"review", "testing", "product"}
GATE_STATUSES = {"pending", "in_progress", "approved", "changes_requested", "blocked", "skipped", "released", "superseded"}


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def validate_status(value: str, allowed: Iterable[str], label: str) -> str:
    status = str(value).strip()
    valid = set(allowed)
    if status not in valid:
        raise ValueError(f"Invalid {label} status {status!r}; expected one of: {', '.join(sorted(valid))}.")
    return status


def validate_task_status(value: str) -> str:
    return validate_status(value, TASK_STATUSES, "task")


def validate_artifact_status(value: str) -> str:
    return validate_status(value, ARTIFACT_STATUSES, "artifact")


def validate_project_relative_path(value: str, *, field: str = "path") -> str:
    raw = str(value).strip()
    if not raw:
        raise ValueError(f"{field} cannot be empty.")
    path = Path(raw)
    if path.is_absolute() or raw.startswith(("/", "\\")):
        raise ValueError(f"{field} must use project-root-relative paths, not absolute paths: {raw}")
    if re.match(r"^[A-Za-z]:[\\/]", raw) or raw.startswith("\\\\"):
        raise ValueError(f"{field} must not use a machine-specific path: {raw}")
    if raw == "~" or raw.startswith("~/") or raw.startswith("~\\"):
        raise ValueError(f"{field} must not use a home-directory path: {raw}")
    if "://" in raw:
        raise ValueError(f"{field} must be a project-root-relative file path, not a URL: {raw}")
    if any(part == ".." for part in path.parts):
        raise ValueError(f"{field} must not traverse outside the project root: {raw}")
    return path.as_posix()


def _bool_value(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
    return default


def normalize_quality_policy(raw: Any) -> dict[str, Any]:
    policy = raw if isinstance(raw, dict) else {}
    normalized = {
        "enabled": _bool_value(policy.get("enabled"), True),
        "rosterDriven": _bool_value(policy.get("rosterDriven"), True),
        "lifecyclePhases": ["review", "testing", "product"],
        "gates": {},
    }
    raw_gates = policy.get("gates") if isinstance(policy.get("gates"), dict) else {}
    for key, defaults in DEFAULT_QUALITY_POLICY["gates"].items():
        override = raw_gates.get(key) if isinstance(raw_gates.get(key), dict) else {}
        phase = str(override.get("phase") or defaults["phase"]).strip()
        role = str(override.get("role") or defaults["role"]).strip()
        if phase not in GATE_PHASES:
            phase = defaults["phase"]
        normalized["gates"][key] = {
            "phase": phase,
            "role": role,
            "required": _bool_value(override.get("required"), bool(defaults["required"])),
            "focus": str(override.get("focus") or defaults["focus"]).strip(),
        }
    return normalized


def _positive_int(value: Any, fallback: int, *, minimum: int = 1, maximum: int = 3600) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(minimum, min(maximum, parsed))


_LEGACY_TO_NEW_CLI_WATCH = {"auto": "enabled", "off": "disabled"}


def normalize_runner_policy(raw: Any) -> dict[str, Any]:
    """Normalize the on-disk runner policy.

    Field rename: `runner.mode` (`auto|off`) → `runner.cliWatchPolling`
    (`enabled|disabled`). Read both shapes for backward compatibility with
    existing `run.yaml` files; write the new shape on output.
    """
    policy = raw if isinstance(raw, dict) else {}
    raw_value = policy.get("cliWatchPolling")
    if raw_value is None:
        # Legacy field name and value space.
        legacy_mode = str(policy.get("mode") or "").strip().lower()
        raw_value = _LEGACY_TO_NEW_CLI_WATCH.get(legacy_mode, DEFAULT_RUNNER_POLICY["cliWatchPolling"])
    cli_watch_polling = str(raw_value).strip().lower()
    if cli_watch_polling not in {"enabled", "disabled"}:
        cli_watch_polling = str(DEFAULT_RUNNER_POLICY["cliWatchPolling"])
    return {
        "cliWatchPolling": cli_watch_polling,
        "pollIntervalSeconds": _positive_int(policy.get("pollIntervalSeconds"), int(DEFAULT_RUNNER_POLICY["pollIntervalSeconds"])),
        "idleBackoffSeconds": _positive_int(policy.get("idleBackoffSeconds"), int(DEFAULT_RUNNER_POLICY["idleBackoffSeconds"])),
        "maxBackoffSeconds": _positive_int(policy.get("maxBackoffSeconds"), int(DEFAULT_RUNNER_POLICY["maxBackoffSeconds"])),
        "stopWhenComplete": _bool_value(policy.get("stopWhenComplete"), bool(DEFAULT_RUNNER_POLICY["stopWhenComplete"])),
    }


def roster_roles_from_state(state: dict[str, Any]) -> set[str]:
    agents = state.get("agents") if isinstance(state.get("agents"), dict) else {}
    return {
        str(agent.get("role"))
        for agent in agents.values()
        if isinstance(agent, dict) and str(agent.get("role") or "").strip()
    }


def roster_is_configured_in_state(state: dict[str, Any]) -> bool:
    sprintengine = state.get("sprintengine") if isinstance(state.get("sprintengine"), dict) else {}
    return bool(sprintengine.get("rosterConfigured"))


def task_requires_architect_gate(task: dict[str, Any]) -> bool:
    paths = [str(path) for path in task.get("ownedPaths", []) or []]
    cross_cutting_prefixes = (
        "sprintengine_core/",
        "scripts/sprintengine",
        "src/renderer/src/utils/sprintengine",
        "src/renderer/src/components/panels",
        "src/main/mobile/sprintengine",
        ".agents/skills/sprintengine",
    )
    return any(path.startswith(cross_cutting_prefixes) for path in paths)


def task_requires_product_gate(task: dict[str, Any]) -> bool:
    return _bool_value(task.get("productFacing"), False)


def _normalize_gate_attempts(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    attempts: list[dict[str, Any]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        attempt = dict(entry)
        status = str(attempt.get("status") or "").strip()
        if status and status not in GATE_STATUSES:
            attempt["status"] = "blocked"
        attempts.append(attempt)
    return attempts


def normalize_quality_gate(raw: Any, fallback_id: str) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    gate_id = str(raw.get("id") or fallback_id).strip()
    phase = str(raw.get("phase") or "").strip()
    role = str(raw.get("role") or "").strip()
    status = str(raw.get("status") or "pending").strip()
    if not gate_id or phase not in GATE_PHASES or not role:
        return None
    if status not in GATE_STATUSES:
        status = "pending"
    gate = {
        "id": gate_id,
        "phase": phase,
        "role": role,
        "status": status,
        "required": _bool_value(raw.get("required"), True),
        "allowSelfReview": _bool_value(raw.get("allowSelfReview"), True),
        "focus": str(raw.get("focus") or "").strip(),
        "attempts": _normalize_gate_attempts(raw.get("attempts")),
    }
    skip_rationale = str(raw.get("skipRationale") or "").strip()
    if skip_rationale:
        gate["skipRationale"] = skip_rationale
    return gate


def derive_default_quality_gates(task: dict[str, Any], state: dict[str, Any], policy: dict[str, Any]) -> list[dict[str, Any]]:
    if not policy.get("enabled", True):
        return []
    roster_configured = roster_is_configured_in_state(state)
    if not roster_configured:
        return []
    if task.get("role") not in {"developer", "frontend"} and not _bool_value(task.get("producesImplementation"), False):
        return []
    roster_roles = roster_roles_from_state(state)
    gate_specs = policy.get("gates") if isinstance(policy.get("gates"), dict) else {}
    selected: list[dict[str, Any]] = []

    frontend_paths = (
        "src/renderer/",
        "src/main/mobile/",
        "src/shared/mobile-control/",
    )
    if any(str(path).startswith(frontend_paths) for path in task.get("ownedPaths", []) or []) and "frontend" in roster_roles:
        selected.append({
            "id": "frontend_review",
            "phase": "review",
            "role": "frontend",
            "status": "pending",
            "required": True,
            "allowSelfReview": True,
            "focus": "UI behavior, accessibility, responsive behavior, status labels, and interaction correctness",
            "attempts": [],
        })

    for gate_id in ("code_reviewer", "spec_reviewer", "tester", "product"):
        spec = gate_specs.get(gate_id)
        if not isinstance(spec, dict):
            continue
        role = str(spec.get("role") or gate_id)
        if gate_id == "product" and not task_requires_product_gate(task):
            continue
        if roster_configured and role not in roster_roles:
            continue
        selected.append({
            "id": gate_id,
            "phase": spec["phase"],
            "role": role,
            "status": "pending",
            "required": bool(spec.get("required", True)),
            "allowSelfReview": True,
            "focus": str(spec.get("focus") or ""),
            "attempts": [],
        })

    architect_spec = gate_specs.get("architect")
    if isinstance(architect_spec, dict):
        role = str(architect_spec.get("role") or "architect")
        if (not roster_configured or role in roster_roles) and task_requires_architect_gate(task):
            selected.insert(0, {
                "id": "architect_review",
                "phase": architect_spec["phase"],
                "role": role,
                "status": "pending",
                "required": bool(architect_spec.get("required", True)),
                "allowSelfReview": True,
                "focus": str(architect_spec.get("focus") or ""),
                "attempts": [],
            })
    return selected


def normalize_task_quality_gates(task: dict[str, Any], state: dict[str, Any], policy: dict[str, Any]) -> list[dict[str, Any]]:
    raw_gates = task.get("qualityGates")
    if isinstance(raw_gates, list):
        normalized = [
            gate
            for index, raw_gate in enumerate(raw_gates)
            if (gate := normalize_quality_gate(raw_gate, f"gate-{index + 1}")) is not None
        ]
    else:
        normalized = derive_default_quality_gates(task, state, policy)
    return normalized


def normalize_quality_fields(state: dict[str, Any], run: dict[str, Any] | None = None) -> dict[str, Any]:
    source_policy = None
    if isinstance(run, dict):
        source_policy = run.get("qualityPolicy")
    if not isinstance(source_policy, dict):
        sprintengine = state.get("sprintengine") if isinstance(state.get("sprintengine"), dict) else {}
        source_policy = sprintengine.get("qualityPolicy") if isinstance(sprintengine.get("qualityPolicy"), dict) else {}
    policy = normalize_quality_policy(source_policy)
    state.setdefault("sprintengine", {})["qualityPolicy"] = policy
    for task in state.get("tasks", []) or []:
        if isinstance(task, dict):
            task["qualityGates"] = normalize_task_quality_gates(task, state, policy)
    return policy


def atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    temp_path = Path(temp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp_path, path)
    finally:
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass


def atomic_write_json(path: Path, payload: Any) -> None:
    atomic_write_text(path, json.dumps(payload, indent=2, sort_keys=True) + "\n")


def atomic_write_yaml(path: Path, payload: Any) -> None:
    atomic_write_text(path, yaml.safe_dump(payload, sort_keys=False))


def atomic_move(source: Path, destination: Path) -> None:
    if not source.exists():
        raise FileNotFoundError(source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    os.replace(source, destination)


def append_jsonl(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, sort_keys=True) + "\n")


def append_event(team_dir: Path, event: dict[str, Any]) -> Path:
    append_jsonl(team_dir / EVENTS_FILE, event)
    return team_dir / EVENTS_FILE


def normalize_agent_subscription(raw: Any) -> dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    mode = str(source.get("mode") or "none").strip()
    if mode not in {"none", "poll", "mcp_notifications"}:
        mode = "none"
    subscription: dict[str, Any] = {"mode": mode}
    for key in ("subscribedAt", "lastDispatchId", "lastDispatchAckAt", "lastDispatchOutcome"):
        value = str(source.get(key) or "").strip()
        if value:
            subscription[key] = value
    return subscription


def normalize_current_dispatch(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    dispatch_id = str(raw.get("dispatchId") or raw.get("id") or "").strip()
    target_kind = str(raw.get("targetKind") or raw.get("kind") or "").strip()
    role = str(raw.get("role") or "").strip()
    reason = str(raw.get("reason") or "").strip()
    if not dispatch_id or not target_kind or not role or not reason:
        return None
    dispatch = {
        "dispatchId": dispatch_id,
        "targetKind": target_kind,
        "role": role,
        "reason": reason,
    }
    for key in ("taskId", "gateId", "attemptId", "assignedAt"):
        value = str(raw.get(key) or "").strip()
        if value:
            dispatch[key] = value
    return dispatch


def normalize_agent_record(agent_id: str, raw: Any) -> dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    role = str(source.get("role") or "").strip()
    status = str(source.get("status") or "idle").strip() or "idle"
    joined_at = str(source.get("joinedAt") or "").strip() or now_iso()
    heartbeat_at = str(source.get("heartbeatAt") or "").strip() or joined_at
    agent = {
        "role": role,
        "status": status,
        "heartbeatAt": heartbeat_at,
        "subscription": normalize_agent_subscription(source.get("subscription")),
        "currentDispatch": normalize_current_dispatch(source.get("currentDispatch")),
        "joinedAt": joined_at,
        "currentTaskId": source.get("currentTaskId") or None,
    }
    for key in ("currentGateId", "lastDirectiveAt", "leftAt", "leaveReason", "deadAt", "replacedByAgentId"):
        value = source.get(key)
        if value not in (None, ""):
            agent[key] = value
    if isinstance(source.get("currentGate"), dict):
        agent["currentGate"] = {
            key: value
            for key, value in source["currentGate"].items()
            if key in {"taskId", "gateId", "attemptId"} and value not in (None, "")
        }
    if not agent["role"]:
        agent["role"] = str(agent_id).split("-", 1)[0] or "developer"
    return agent


def normalize_agents(raw: Any) -> dict[str, dict[str, Any]]:
    agents = raw if isinstance(raw, dict) else {}
    normalized: dict[str, dict[str, Any]] = {}
    for agent_id, agent in agents.items():
        clean_id = str(agent_id).strip()
        if clean_id:
            normalized[clean_id] = normalize_agent_record(clean_id, agent)
    return normalized


def dispatch_id_for_record(record: dict[str, Any]) -> str:
    target = record.get("target") if isinstance(record.get("target"), dict) else {}
    material = {
        "agentId": record.get("agentId"),
        "role": record.get("role"),
        "target": {
            "kind": target.get("kind"),
            "taskId": target.get("taskId"),
            "gateId": target.get("gateId"),
            "attemptId": target.get("attemptId"),
        },
        "reason": record.get("reason"),
    }
    digest = hashlib.sha256(json.dumps(material, sort_keys=True).encode("utf-8")).hexdigest()[:16]
    return f"DISP-{digest}"


def append_dispatch_records(team_dir: Path, records: list[dict[str, Any]]) -> Path:
    path = team_dir / DISPATCH_FILE
    if not records:
        if not path.exists():
            atomic_write_text(path, "")
        return path
    existing_ids = {
        str(record.get("id"))
        for record in read_jsonl_file(path)
        if isinstance(record, dict) and record.get("id")
    }
    for raw in records:
        if not isinstance(raw, dict):
            continue
        record = dict(raw)
        record["id"] = str(record.get("id") or dispatch_id_for_record(record))
        if record["id"] in existing_ids:
            continue
        append_jsonl(path, record)
        existing_ids.add(record["id"])
    return path


def initialize_run_store(
    team_dir: Path,
    *,
    name: str,
    goal: str = "",
    status: str = "planning",
    roster_configured: bool = False,
) -> Path:
    team_dir.mkdir(parents=True, exist_ok=True)
    for task_status in TASK_STATUSES:
        (team_dir / "tasks" / task_status).mkdir(parents=True, exist_ok=True)
    for artifact_status in ARTIFACT_STATUSES:
        (team_dir / "artifacts" / artifact_status).mkdir(parents=True, exist_ok=True)
    for support_dir in SUPPORT_DIRS:
        (team_dir / support_dir).mkdir(parents=True, exist_ok=True)

    run_path = team_dir / RUN_FILE
    if not run_path.exists():
        atomic_write_yaml(
            run_path,
            {
                "schemaVersion": 1,
                "name": name,
                "goal": goal,
                "status": status,
                "rosterConfigured": roster_configured,
                "graphPolicy": {"readiness": "dependency"},
                "runner": dict(DEFAULT_RUNNER_POLICY),
                "agents": {},
                "roles": {},
                "sprintengine": {
                    "name": name,
                    "goal": goal,
                    "status": status,
                    "rosterConfigured": roster_configured,
                },
                "tasks": [],
                "artifacts": [],
                "creation": {"source": "folder_store", "createdAt": now_iso()},
            },
        )
    events_path = team_dir / EVENTS_FILE
    if not events_path.exists():
        atomic_write_text(events_path, "")
    dispatch_path = team_dir / DISPATCH_FILE
    if not dispatch_path.exists():
        atomic_write_text(dispatch_path, "")
    feedback_path = team_dir / FEEDBACK_FILE
    if not feedback_path.exists():
        atomic_write_text(feedback_path, "")
    for lock_file in LOCK_STATE_FILES:
        path = team_dir / lock_file
        if not path.exists():
            atomic_write_json(path, {"status": "idle", "updatedAt": now_iso()})
    return run_path


def task_filename(task_id: str, order: int | None = None) -> str:
    safe_id = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(task_id).strip())
    if not safe_id:
        raise ValueError("Task id cannot be empty.")
    if order is None:
        return f"{safe_id}.json"
    return f"{order:04d}-{safe_id}.json"


def load_run_yaml(team_dir: Path) -> dict[str, Any]:
    run_path = team_dir / RUN_FILE
    if not run_path.exists():
        return {}
    loaded = yaml.safe_load(run_path.read_text(encoding="utf-8")) or {}
    if not isinstance(loaded, dict):
        raise ValueError(f"Unexpected run.yaml shape in {run_path}")
    return loaded


def read_json_file(path: Path) -> dict[str, Any]:
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON file {path}: {exc.msg}") from exc
    if not isinstance(parsed, dict):
        raise ValueError(f"Unexpected JSON object shape in {path}")
    return parsed


def read_jsonl_file(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    records: list[dict[str, Any]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid JSONL record in {path}:{line_number}: {exc.msg}") from exc
        if isinstance(parsed, dict):
            records.append(parsed)
    return records


def task_graph_from_run(team_dir: Path) -> dict[str, list[str]]:
    run = load_run_yaml(team_dir)
    graph: dict[str, list[str]] = {}
    for entry in run.get("tasks", []) or []:
        if not isinstance(entry, dict):
            continue
        task_id = str(entry.get("id") or "").strip()
        if not task_id:
            continue
        graph[task_id] = [str(dep).strip() for dep in entry.get("dependsOn", []) or [] if str(dep).strip()]
    return graph


def task_graph_from_tasks(tasks: Iterable[dict[str, Any]]) -> dict[str, list[str]]:
    graph: dict[str, list[str]] = {}
    for task in tasks:
        task_id = str(task.get("id") or "").strip()
        if not task_id:
            continue
        graph[task_id] = [str(dep).strip() for dep in task.get("dependsOn", []) or [] if str(dep).strip()]
    return graph


def topological_task_ids(graph: dict[str, list[str]]) -> list[str]:
    missing = sorted({dep for deps in graph.values() for dep in deps if dep not in graph})
    if missing:
        raise ValueError(f"Task graph references unknown dependencies: {', '.join(missing)}")

    temporary: set[str] = set()
    permanent: set[str] = set()
    ordered: list[str] = []

    def visit(task_id: str, trail: list[str]) -> None:
        if task_id in permanent:
            return
        if task_id in temporary:
            cycle_start = trail.index(task_id) if task_id in trail else 0
            cycle = [*trail[cycle_start:], task_id]
            raise ValueError(f"Task dependency cycle detected: {' -> '.join(cycle)}")
        temporary.add(task_id)
        for dep_id in sorted(graph.get(task_id, [])):
            visit(dep_id, [*trail, task_id])
        temporary.remove(task_id)
        permanent.add(task_id)
        ordered.append(task_id)

    for task_id in sorted(graph):
        visit(task_id, [])
    return ordered


def validate_acyclic_task_graph(tasks: Iterable[dict[str, Any]]) -> list[str]:
    return topological_task_ids(task_graph_from_tasks(tasks))


def task_is_ready_for_queue(tasks_by_id: dict[str, dict[str, Any]], task: dict[str, Any], graph: dict[str, list[str]]) -> bool:
    if task.get("status") not in {"todo", "changes_requested"} or task.get("ownerAgentId"):
        return False
    if _bool_value(task.get("needsTriage"), False):
        return False
    dispatch = task.get("dispatch")
    if isinstance(dispatch, dict) and dispatch.get("mode") == "manual" and dispatch.get("status") != "ready":
        return False
    for dep_id in graph.get(str(task.get("id")), []):
        dependency = tasks_by_id.get(dep_id)
        if dependency is None or dependency.get("status") != "done":
            return False
    return True


def sync_run_yaml_from_state(team_dir: Path, state: dict[str, Any]) -> None:
    sprintengine = state.get("sprintengine") if isinstance(state.get("sprintengine"), dict) else {}
    agents = normalize_agents(state.get("agents"))
    state["agents"] = agents
    roles = state.get("roles") if isinstance(state.get("roles"), dict) else {}
    run = load_run_yaml(team_dir)
    creation = run.get("creation") if isinstance(run.get("creation"), dict) else {}
    runner_policy = normalize_runner_policy(state.get("runner") if isinstance(state.get("runner"), dict) else run.get("runner"))
    quality_policy = normalize_quality_fields(state, run)
    run.update(
        {
            "schemaVersion": run.get("schemaVersion") or 1,
            "name": sprintengine.get("name") or team_dir.name,
            "goal": sprintengine.get("goal") or "",
            "status": sprintengine.get("status") or "planning",
            "rosterConfigured": bool(sprintengine.get("rosterConfigured")),
            "graphPolicy": run.get("graphPolicy") or {"readiness": "dependency"},
            "runner": runner_policy,
            "qualityPolicy": quality_policy,
            "agents": agents,
            "roles": roles,
            "sprintengine": sprintengine,
            "tasks": [
                {
                    "id": task.get("id"),
                    "status": task.get("status"),
                    "role": task.get("role"),
                    "dependsOn": [str(dep) for dep in task.get("dependsOn", []) or []],
                    "needsTriage": _bool_value(task.get("needsTriage"), False),
                }
                for task in state.get("tasks", []) or []
                if isinstance(task, dict) and task.get("id")
            ],
            "artifacts": [
                {
                    "id": artifact.get("id"),
                    "status": artifact.get("status"),
                    "kind": artifact.get("kind"),
                    "taskId": artifact.get("taskId"),
                }
                for artifact in state.get("artifacts", []) or []
                if isinstance(artifact, dict) and artifact.get("id")
            ],
            "updatedAt": now_iso(),
        }
    )
    for key in RUN_SOURCE_KEYS:
        if key in state:
            run[key] = state[key]
    run["creation"] = creation or {"source": "folder_store", "createdAt": now_iso()}
    atomic_write_yaml(team_dir / RUN_FILE, run)


def clear_task_status_folders(team_dir: Path) -> None:
    for status in TASK_STATUSES:
        folder = team_dir / "tasks" / status
        folder.mkdir(parents=True, exist_ok=True)
        for child in folder.glob("*.json"):
            child.unlink()


def clear_artifact_status_folders(team_dir: Path) -> None:
    for status in ARTIFACT_STATUSES:
        folder = team_dir / "artifacts" / status
        folder.mkdir(parents=True, exist_ok=True)
        for child in folder.glob("*.json"):
            child.unlink()


def status_folder_for_task(task: dict[str, Any], ready_ids: set[str]) -> str:
    task_id = str(task.get("id") or "")
    status = str(task.get("status") or "todo")
    if status == "changes_requested":
        return "changes_requested"
    if task_id in ready_ids:
        return "ready"
    if status not in TASK_STATUSES or status == "ready":
        status = "todo"
    return status


def write_materialized_task_files(team_dir: Path, tasks: list[dict[str, Any]], ordered_ids: list[str], ready_ids: set[str]) -> None:
    clear_task_status_folders(team_dir)
    order_by_id = {task_id: index + 1 for index, task_id in enumerate(ordered_ids)}
    for task in tasks:
        task_id = str(task.get("id") or "").strip()
        if not task_id:
            continue
        folder_status = status_folder_for_task(task, ready_ids)
        stored = dict(task)
        stored["needsTriage"] = _bool_value(stored.get("needsTriage"), False)
        stored["status"] = folder_status
        if folder_status == "ready":
            stored["stateStatus"] = task.get("status")
        target = team_dir / "tasks" / folder_status / task_filename(task_id, order_by_id.get(task_id))
        atomic_write_json(target, stored)


def artifact_filename(artifact_id: str) -> str:
    safe_id = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(artifact_id).strip())
    if not safe_id:
        raise ValueError("Artifact id cannot be empty.")
    return f"{safe_id}.json"


def status_folder_for_artifact(artifact: dict[str, Any]) -> str:
    status = str(artifact.get("status") or "draft")
    if status not in ARTIFACT_STATUSES:
        status = "draft"
    return status


def write_materialized_artifact_files(team_dir: Path, artifacts: list[dict[str, Any]]) -> None:
    clear_artifact_status_folders(team_dir)
    for artifact in artifacts:
        artifact_id = str(artifact.get("id") or "").strip()
        if not artifact_id:
            continue
        folder_status = status_folder_for_artifact(artifact)
        stored = dict(artifact)
        stored["status"] = folder_status
        target = team_dir / "artifacts" / folder_status / artifact_filename(artifact_id)
        atomic_write_json(target, stored)


def sync_events_jsonl(team_dir: Path, events: list[dict[str, Any]]) -> None:
    lines = [json.dumps(event, sort_keys=True) for event in events if isinstance(event, dict)]
    atomic_write_text(team_dir / EVENTS_FILE, ("\n".join(lines) + "\n") if lines else "")


def refresh_ready_queue(team_dir: Path, state: dict[str, Any]) -> dict[str, Any]:
    tasks = [task for task in state.get("tasks", []) or [] if isinstance(task, dict)]
    graph = task_graph_from_run(team_dir)
    if set(graph) != {str(task.get("id")) for task in tasks if task.get("id")}:
        graph = task_graph_from_tasks(tasks)
    ordered_ids = topological_task_ids(graph)
    tasks_by_id = {str(task.get("id")): task for task in tasks if task.get("id")}
    ready_ids = {
        task_id
        for task_id in ordered_ids
        if task_id in tasks_by_id and task_is_ready_for_queue(tasks_by_id, tasks_by_id[task_id], graph)
    }
    write_materialized_task_files(team_dir, tasks, ordered_ids, ready_ids)
    return {"orderedTaskIds": ordered_ids, "readyTaskIds": [task_id for task_id in ordered_ids if task_id in ready_ids]}


def sync_state_to_store(team_dir: Path, state: dict[str, Any], *, state_path: Path | None = None) -> dict[str, Any]:
    initialize_run_store(
        team_dir,
        name=str(state.get("sprintengine", {}).get("name") or team_dir.name),
        goal=str(state.get("sprintengine", {}).get("goal") or ""),
        status=str(state.get("sprintengine", {}).get("status") or "planning"),
        roster_configured=bool(state.get("sprintengine", {}).get("rosterConfigured")),
    )
    validate_acyclic_task_graph([task for task in state.get("tasks", []) or [] if isinstance(task, dict)])
    with FolderLock(team_dir / READY_QUEUE_LOCK_FILE):
        normalize_quality_fields(state, load_run_yaml(team_dir))
        pending_dispatch_records = [
            record for record in state.pop("_dispatchRecords", []) if isinstance(record, dict)
        ]
        sync_run_yaml_from_state(team_dir, state)
        refresh = refresh_ready_queue(team_dir, state)
        write_materialized_artifact_files(team_dir, [artifact for artifact in state.get("artifacts", []) or [] if isinstance(artifact, dict)])
        sync_events_jsonl(team_dir, [event for event in state.get("events", []) or [] if isinstance(event, dict)])
        append_dispatch_records(team_dir, pending_dispatch_records)
        write_projection_file(team_dir, state, state_path=state_path)
        return refresh


def materialized_ready_task_ids(team_dir: Path) -> list[str]:
    ready_dir = team_dir / "tasks" / "ready"
    if not ready_dir.exists():
        return []
    ready_ids: list[str] = []
    for path in sorted(ready_dir.glob("*.json")):
        try:
            parsed = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid ready task file {path}: {exc.msg}") from exc
        if not isinstance(parsed, dict) or not parsed.get("id"):
            raise ValueError(f"Invalid ready task file {path}: missing task id")
        ready_ids.append(str(parsed["id"]))
    return ready_ids


def _list_materialized_records(team_dir: Path, root: str, statuses: Iterable[str]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for status in statuses:
        folder = team_dir / root / status
        if not folder.exists():
            continue
        for path in sorted(folder.glob("*.json")):
            record = read_json_file(path)
            record.setdefault("status", status)
            record["folderStatus"] = status
            records.append(record)
    return records


def _tasks_from_folder_store(team_dir: Path) -> list[dict[str, Any]]:
    tasks = _list_materialized_records(team_dir, "tasks", TASK_STATUSES)
    return sorted(tasks, key=lambda task: str(task.get("id") or ""))


def _artifacts_from_folder_store(team_dir: Path) -> list[dict[str, Any]]:
    artifacts = _list_materialized_records(team_dir, "artifacts", ARTIFACT_STATUSES)
    return sorted(artifacts, key=lambda artifact: str(artifact.get("id") or ""))


def _semantic_task_from_folder_record(task: dict[str, Any]) -> dict[str, Any]:
    semantic = dict(task)
    folder_status = str(semantic.get("folderStatus") or semantic.get("status") or "todo")
    semantic["status"] = str(semantic.get("stateStatus") or folder_status)
    semantic.pop("folderStatus", None)
    semantic.pop("stateStatus", None)
    return semantic


def _semantic_artifact_from_folder_record(artifact: dict[str, Any]) -> dict[str, Any]:
    semantic = dict(artifact)
    semantic["status"] = str(semantic.get("folderStatus") or semantic.get("status") or "draft")
    semantic.pop("folderStatus", None)
    return semantic


def state_from_folder_store(team_dir: Path) -> dict[str, Any]:
    run = load_run_yaml(team_dir)
    if not run:
        raise FileNotFoundError(team_dir / RUN_FILE)

    sprintengine = run.get("sprintengine") if isinstance(run.get("sprintengine"), dict) else {}
    reconstructed_sprintengine = dict(sprintengine)
    reconstructed_sprintengine.setdefault("name", run.get("name") or team_dir.name)
    reconstructed_sprintengine.setdefault("goal", run.get("goal") or "")
    reconstructed_sprintengine.setdefault("status", run.get("status") or "planning")
    reconstructed_sprintengine.setdefault("rosterConfigured", bool(run.get("rosterConfigured")))
    if isinstance(run.get("creation"), dict):
        reconstructed_sprintengine.setdefault("creation", run["creation"])

    agents = normalize_agents(run.get("agents"))
    roles = run.get("roles") if isinstance(run.get("roles"), dict) else {}
    task_order = {
        str(entry.get("id")): index
        for index, entry in enumerate(run.get("tasks", []) or [])
        if isinstance(entry, dict) and entry.get("id")
    }
    tasks = [_semantic_task_from_folder_record(task) for task in _tasks_from_folder_store(team_dir)]
    tasks.sort(key=lambda task: task_order.get(str(task.get("id") or ""), len(task_order)))
    state = {
        "sprintengine": reconstructed_sprintengine,
        "runner": normalize_runner_policy(run.get("runner")),
        "tasks": tasks,
        "artifacts": [_semantic_artifact_from_folder_record(artifact) for artifact in _artifacts_from_folder_store(team_dir)],
        "events": read_jsonl_file(team_dir / EVENTS_FILE),
        "dispatches": read_jsonl_file(team_dir / DISPATCH_FILE),
        "agents": agents,
        "roles": roles,
    }
    for key in RUN_SOURCE_KEYS:
        if key in run:
            state[key] = run[key]
    normalize_quality_fields(state, run)
    return state


def _normalize_projection_task(task: dict[str, Any], *, board_column: str) -> dict[str, Any]:
    semantic_status = str(task.get("stateStatus") or task.get("status") or "todo")
    projected = dict(task)
    projected["status"] = board_column
    projected["stateStatus"] = semantic_status
    projected["boardColumn"] = board_column
    projected.setdefault("dependsOn", [])
    projected.setdefault("ownedPaths", [])
    projected.setdefault("acceptanceCriteria", [])
    projected.setdefault("implementationNotes", [])
    projected.setdefault("notes", [])
    projected.setdefault("evidence", {})
    projected.setdefault("comments", [])
    projected.setdefault("activity", [])
    projected["needsTriage"] = _bool_value(projected.get("needsTriage"), False)
    return projected


def _projection_comment_time(comment: dict[str, Any]) -> str:
    return str(comment.get("createdAt") or "")


def _projection_latest_comments(task: dict[str, Any], limit: int = 5) -> list[dict[str, Any]]:
    comments = task.get("comments") if isinstance(task.get("comments"), list) else []
    clean_comments = [comment for comment in comments if isinstance(comment, dict)]
    return sorted(clean_comments, key=_projection_comment_time, reverse=True)[:limit]


def _projection_open_feedback(task: dict[str, Any], limit: int = 10) -> list[dict[str, Any]]:
    feedback_types = {"review_feedback", "test_feedback", "product_feedback", "architect_feedback"}
    comments = task.get("comments") if isinstance(task.get("comments"), list) else []
    open_comments = []
    for comment in comments:
        if not isinstance(comment, dict) or comment.get("type") not in feedback_types:
            continue
        data = comment.get("data") if isinstance(comment.get("data"), dict) else {}
        if data.get("status", "open") == "open":
            open_comments.append(comment)
    return sorted(open_comments, key=_projection_comment_time, reverse=True)[:limit]


def _projection_quality_gate_summary(task: dict[str, Any]) -> dict[str, Any]:
    gates = task.get("qualityGates") if isinstance(task.get("qualityGates"), list) else []
    summary: dict[str, Any] = {
        "total": 0,
        "required": 0,
        "openRequired": 0,
        "byPhase": {},
        "byStatus": {},
    }
    for gate in gates:
        if not isinstance(gate, dict):
            continue
        status = str(gate.get("status") or "pending")
        phase = str(gate.get("phase") or "unknown")
        required = gate.get("required") is not False
        summary["total"] += 1
        if required:
            summary["required"] += 1
        if required and status not in {"approved", "skipped"}:
            summary["openRequired"] += 1
        summary["byPhase"][phase] = summary["byPhase"].get(phase, 0) + 1
        summary["byStatus"][status] = summary["byStatus"].get(status, 0) + 1
    return summary


def _projection_recorded_artifacts(artifacts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    recorded = []
    for artifact in artifacts:
        if artifact.get("status") != "recorded":
            continue
        recorded.append({
            "id": artifact.get("id"),
            "kind": artifact.get("kind"),
            "title": artifact.get("title"),
            "path": artifact.get("path"),
            "gateId": artifact.get("gateId"),
            "createdBy": artifact.get("createdBy"),
            "createdAt": artifact.get("createdAt"),
        })
    return recorded


def _build_board(tasks: list[dict[str, Any]]) -> dict[str, Any]:
    columns = {status: {"count": 0, "taskIds": []} for status in TASK_STATUSES}
    for task in tasks:
        column = str(task.get("boardColumn") or task.get("folderStatus") or task.get("status") or "todo")
        if column not in columns:
            column = "todo"
        columns[column]["count"] += 1
        if task.get("id"):
            columns[column]["taskIds"].append(str(task["id"]))
    return {
        "columns": columns,
        "counts": {status: data["count"] for status, data in columns.items()},
        "readyTaskIds": list(columns["ready"]["taskIds"]),
        "changesRequestedTaskIds": list(columns["changes_requested"]["taskIds"]),
    }


def _artifact_counts(artifacts: list[dict[str, Any]]) -> dict[str, int]:
    counts = {status: 0 for status in ARTIFACT_STATUSES}
    for artifact in artifacts:
        status = str(artifact.get("folderStatus") or artifact.get("status") or "draft")
        if status in counts:
            counts[status] += 1
    return counts


def _build_projection_run_summary(
    run: dict[str, Any],
    tasks: list[dict[str, Any]],
    artifacts: list[dict[str, Any]],
    board: dict[str, Any],
) -> dict[str, Any]:
    completed = [task for task in tasks if task.get("stateStatus") == "done" or task.get("status") == "done"]
    artifact_counts = _artifact_counts(artifacts)
    return {
        "goal": run.get("goal") or "",
        "status": run.get("status") or "planning",
        "tasks": {
            "total": len(tasks),
            "completed": len(completed),
            "remaining": max(0, len(tasks) - len(completed)),
            "ready": board["counts"].get("ready", 0),
            "changesRequested": board["counts"].get("changes_requested", 0),
            "needsInput": board["counts"].get("needs_input", 0),
        },
        "artifacts": {
            "total": len(artifacts),
            "readyForReview": artifact_counts.get("ready_for_review", 0),
            "approved": artifact_counts.get("approved", 0),
            "changesRequested": artifact_counts.get("changes_requested", 0),
        },
        "completedTasks": [
            {
                "id": task.get("id"),
                "title": task.get("title"),
                "summary": (task.get("evidence") if isinstance(task.get("evidence"), dict) else {}).get("summary") or "",
                "ownerAgentId": task.get("ownerAgentId"),
                "completedAt": task.get("completedAt"),
            }
            for task in completed
        ],
    }


def _projection_locks(team_dir: Path, state_path: Path | None) -> dict[str, Any]:
    lock_paths = {
        "runFile": (state_path or team_dir / RUN_FILE).with_suffix(".yaml.lock"),
        "run": team_dir / RUN_LOCK_FILE,
        "readyQueue": team_dir / READY_QUEUE_LOCK_FILE,
        "claimQueue": team_dir / CLAIM_QUEUE_LOCK_FILE,
        "gateQueue": team_dir / GATE_QUEUE_LOCK_FILE,
    }
    lock_reports = []
    warnings = []
    for name, path in lock_paths.items():
        report = FolderLock(path).inspect()
        entry = {
            "name": name,
            "exists": report.exists,
            "stale": report.stale,
            "ageSeconds": report.ageSeconds,
            "owner": report.owner,
        }
        lock_reports.append(entry)
        if report.stale:
            warnings.append({"name": name, "message": f"{name} lock appears stale.", "ageSeconds": report.ageSeconds})

    state_files = {}
    for relative in LOCK_STATE_FILES:
        path = team_dir / relative
        if path.exists():
            try:
                state_files[Path(relative).stem] = read_json_file(path)
            except ValueError:
                state_files[Path(relative).stem] = {"status": "invalid"}
    return {"locks": lock_reports, "states": state_files, "warnings": warnings}


def build_projection(
    team_dir: Path,
    *,
    state_path: Path | None = None,
) -> dict[str, Any]:
    folder_store_ready = (team_dir / RUN_FILE).exists() and (team_dir / "tasks").exists()
    if folder_store_ready:
        source = "folder_store"
        run = load_run_yaml(team_dir)
        raw_tasks = _tasks_from_folder_store(team_dir)
        tasks = [_normalize_projection_task(task, board_column=str(task.get("folderStatus") or task.get("status") or "todo")) for task in raw_tasks]
        artifacts = _artifacts_from_folder_store(team_dir)
        events = read_jsonl_file(team_dir / EVENTS_FILE)
        dispatches = read_jsonl_file(team_dir / DISPATCH_FILE)
        feedback = read_jsonl_file(team_dir / FEEDBACK_FILE)
        roster = normalize_agents(run.get("agents"))
        quality_policy = normalize_quality_policy(run.get("qualityPolicy") if isinstance(run.get("qualityPolicy"), dict) else {})
        runner_policy = normalize_runner_policy(run.get("runner"))
    else:
        raise ValueError(f"Sprint Engine folder store is not initialized at {team_dir}.")

    artifacts_by_task: dict[str, list[dict[str, Any]]] = {}
    for artifact in artifacts:
        task_id = str(artifact.get("taskId") or "")
        if task_id:
            artifacts_by_task.setdefault(task_id, []).append(artifact)
    for task in tasks:
        task_id = str(task.get("id") or "")
        linked_artifacts = artifacts_by_task.get(task_id, [])
        task["artifacts"] = linked_artifacts
        task["qualityGateSummary"] = _projection_quality_gate_summary(task)
        task["latestComments"] = _projection_latest_comments(task)
        task["latestOpenFeedback"] = _projection_open_feedback(task)
        task["recordedArtifacts"] = _projection_recorded_artifacts(linked_artifacts)

    board = _build_board(tasks)
    locks = _projection_locks(team_dir, state_path)
    updated_at = run.get("updatedAt") or now_iso()
    projection = {
        "ok": True,
        "projectionVersion": 1,
        "source": source,
        "generatedAt": now_iso(),
        "updatedAt": updated_at,
        "run": {
            "id": team_dir.name,
            "name": run.get("name") or team_dir.name,
            "goal": run.get("goal") or "",
            "status": run.get("status") or "planning",
            "rosterConfigured": bool(run.get("rosterConfigured")),
            "updatedAt": updated_at,
            "creation": run.get("creation") if isinstance(run.get("creation"), dict) else {},
            "qualityPolicy": quality_policy,
            "runner": runner_policy,
        },
        "roster": roster if isinstance(roster, dict) else {},
        "tasks": tasks,
        "board": board,
        "artifacts": artifacts,
        "locks": locks,
        "activity": events,
        "dispatches": dispatches,
        "feedback": feedback,
        "counts": {
            "tasks": board["counts"],
            "ready": board["counts"].get("ready", 0),
            "changesRequested": board["counts"].get("changes_requested", 0),
            "needsInput": board["counts"].get("needs_input", 0),
            "artifacts": _artifact_counts(artifacts),
        },
        "runSummary": _build_projection_run_summary(run, tasks, artifacts, board),
    }
    if state_path is not None:
        projection["statePath"] = str(state_path)
        projection["planPath"] = str(team_dir / "plan.md")
    return projection


def write_projection_file(team_dir: Path, state: dict[str, Any], *, state_path: Path | None = None) -> Path:
    projection = build_projection(team_dir, state_path=state_path)
    atomic_write_json(team_dir / PROJECTION_FILE, projection)
    return team_dir / PROJECTION_FILE


@dataclass(frozen=True)
class LockReport:
    path: str
    exists: bool
    stale: bool
    ageSeconds: float | None
    owner: dict[str, Any] | None


class FolderLock:
    def __init__(self, path: Path, *, stale_after_seconds: float = 300.0, timeout: float = 30.0, poll: float = 0.2):
        self.path = path
        self.stale_after_seconds = stale_after_seconds
        self.timeout = timeout
        self.poll = poll
        self.fd: int | None = None

    def inspect(self) -> LockReport:
        if not self.path.exists():
            return LockReport(str(self.path), False, False, None, None)
        age = max(0.0, time.time() - self.path.stat().st_mtime)
        owner = None
        try:
            parsed = json.loads(self.path.read_text(encoding="utf-8"))
            if isinstance(parsed, dict):
                owner = parsed
        except (OSError, json.JSONDecodeError):
            owner = None
        return LockReport(str(self.path), True, age > self.stale_after_seconds, age, owner)

    def recover_stale(self) -> bool:
        report = self.inspect()
        if not report.exists or not report.stale:
            return False
        self.path.unlink()
        return True

    def acquire(self, *, recover_stale: bool = False) -> LockReport:
        deadline = time.monotonic() + self.timeout
        payload = json.dumps({"pid": os.getpid(), "createdAt": now_iso()})
        self.path.parent.mkdir(parents=True, exist_ok=True)
        while True:
            try:
                self.fd = os.open(str(self.path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(self.fd, payload.encode("utf-8"))
                return self.inspect()
            except FileExistsError:
                report = self.inspect()
                if report.stale and recover_stale:
                    self.recover_stale()
                    continue
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"Timed out waiting for lock: {self.path}")
                time.sleep(self.poll)

    def release(self) -> None:
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass

    def __enter__(self) -> "FolderLock":
        self.acquire(recover_stale=True)
        return self

    def __exit__(self, *_: Any) -> None:
        self.release()
