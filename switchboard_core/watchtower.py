from __future__ import annotations

import json
import re
import uuid
from pathlib import Path
from typing import Any

from .store import SwitchboardError, atomic_write_json, init_workspace, now_iso, switchboard_root


WATCHTOWER_RUN_STATUSES = ("pending", "running", "completed", "failed", "canceled")
WATCHTOWER_RUN_ID_RE = re.compile(r"^watchtower_[0-9]{8}T[0-9]{6}Z_[0-9a-f]{8}$")


def watchtower_run_root(workspace: Path) -> Path:
    return switchboard_root(workspace) / "watchtower-runs"


def watchtower_run_dir(workspace: Path, run_id: str) -> Path:
    validate_watchtower_run_id(run_id)
    return watchtower_run_root(workspace) / run_id


def watchtower_run_path(workspace: Path, run_id: str) -> Path:
    return watchtower_run_dir(workspace, run_id) / "run.json"


def run_child_path(run_dir: Path, relative_path: str) -> Path:
    if not isinstance(relative_path, str) or not relative_path.strip():
        raise SwitchboardError("Watchtower run relative path is required.")
    if Path(relative_path).is_absolute():
        raise SwitchboardError("Watchtower run paths must be relative.")
    resolved = (run_dir / relative_path).resolve()
    if not resolved.is_relative_to(run_dir.resolve()):
        raise SwitchboardError("Watchtower run path escapes the run directory.")
    return resolved


def validate_watchtower_run_id(run_id: str) -> None:
    if not isinstance(run_id, str) or not WATCHTOWER_RUN_ID_RE.match(run_id):
        raise SwitchboardError("Watchtower run id is invalid.")


def new_watchtower_run_id() -> str:
    return f"watchtower_{now_iso().replace('-', '').replace(':', '').replace('+00:00', 'Z')[:15]}Z_{uuid.uuid4().hex[:8]}"


def default_watchtower_counts() -> dict[str, int]:
    return {"valid": 0, "invalid": 0, "ingested": 0}


def normalize_watchtower_counts(value: Any) -> dict[str, int]:
    counts = default_watchtower_counts()
    if not isinstance(value, dict):
        return counts
    for key in counts:
        current = value.get(key)
        counts[key] = current if isinstance(current, int) and current >= 0 else 0
    return counts


def normalize_watchtower_agent(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    agent_id = value.get("agentId")
    specialist_id = value.get("specialistId")
    status = value.get("status")
    output_dir = value.get("outputDir")
    report_path = value.get("reportPath")
    execution_id = value.get("executionId")
    error_message = value.get("errorMessage")
    task_ids = value.get("taskIds")
    if not isinstance(agent_id, str) or not agent_id.strip():
        return None
    normalized = {
        "agentId": agent_id.strip(),
        "specialistId": specialist_id.strip() if isinstance(specialist_id, str) and specialist_id.strip() else None,
        "status": status if status in WATCHTOWER_RUN_STATUSES else "pending",
        "outputDir": output_dir.strip() if isinstance(output_dir, str) and output_dir.strip() else f"outputs/{agent_id.strip()}",
        "reportPath": report_path.strip() if isinstance(report_path, str) and report_path.strip() else None,
    }
    if isinstance(execution_id, str) and execution_id.strip():
        normalized["executionId"] = execution_id.strip()
    if isinstance(error_message, str) and error_message.strip():
        normalized["errorMessage"] = error_message.strip()
    if isinstance(task_ids, list):
        normalized_task_ids = [task_id for task_id in task_ids if isinstance(task_id, str) and task_id.strip()]
        if normalized_task_ids:
            normalized["taskIds"] = normalized_task_ids
    return normalized


def ensure_watchtower_run_agent_paths(workspace: Path, run: dict[str, Any]) -> None:
    current_dir = watchtower_run_dir(workspace, run["runId"])
    for agent in run.get("agents", []):
        output_dir = agent.get("outputDir")
        if isinstance(output_dir, str) and output_dir.strip():
            run_child_path(current_dir, output_dir)
        report_path = agent.get("reportPath")
        if isinstance(report_path, str) and report_path.strip():
            run_child_path(current_dir, report_path).parent.mkdir(parents=True, exist_ok=True)


def normalize_watchtower_run(workspace: Path, payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise SwitchboardError("Watchtower run metadata must contain a JSON object.")
    if payload.get("schemaVersion") != 1:
        raise SwitchboardError("Watchtower run schemaVersion must be 1.")
    run_id = payload.get("runId")
    if not isinstance(run_id, str):
        raise SwitchboardError("Watchtower run id is required.")
    validate_watchtower_run_id(run_id)
    status = payload.get("status")
    if status not in WATCHTOWER_RUN_STATUSES:
        raise SwitchboardError("Watchtower run status is invalid.")
    created_at = payload.get("createdAt")
    if not isinstance(created_at, str) or not created_at:
        raise SwitchboardError("Watchtower run createdAt is required.")
    completed_at = payload.get("completedAt")
    if completed_at is not None and not isinstance(completed_at, str):
        raise SwitchboardError("Watchtower run completedAt must be a string or null.")
    preset = payload.get("preset")
    if not isinstance(preset, str) or not preset.strip():
        raise SwitchboardError("Watchtower run preset is required.")
    agents_value = payload.get("agents")
    if not isinstance(agents_value, list):
        raise SwitchboardError("Watchtower run agents must be an array.")
    agents = [agent for agent in (normalize_watchtower_agent(item) for item in agents_value) if agent is not None]
    return {
        "schemaVersion": 1,
        "runId": run_id,
        "status": status,
        "createdAt": created_at,
        "completedAt": completed_at,
        "workspaceRoot": str(Path(payload.get("workspaceRoot") or workspace).expanduser().resolve()),
        "preset": preset.strip(),
        "agents": agents,
        "counts": normalize_watchtower_counts(payload.get("counts")),
    }


def create_watchtower_run(workspace: Path, *, preset: str, agents: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return create_watchtower_run_with_status(workspace, preset=preset, agents=agents, status="pending")


def create_watchtower_run_with_status(
    workspace: Path,
    *,
    preset: str,
    agents: list[dict[str, Any]] | None = None,
    status: str = "pending",
) -> dict[str, Any]:
    if not isinstance(preset, str) or not preset.strip():
        raise SwitchboardError("Watchtower run preset is required.")
    if status not in WATCHTOWER_RUN_STATUSES:
        raise SwitchboardError("Watchtower run status is invalid.")
    init_workspace(workspace)
    run_id = new_watchtower_run_id()
    current_dir = watchtower_run_dir(workspace, run_id)
    current_dir.mkdir(parents=True, exist_ok=False)
    (current_dir / "reports").mkdir()
    created_at = now_iso()
    payload = normalize_watchtower_run(
        workspace,
        {
            "schemaVersion": 1,
            "runId": run_id,
            "status": status,
            "createdAt": created_at,
            "completedAt": created_at if status in {"completed", "failed", "canceled"} else None,
            "workspaceRoot": str(workspace.expanduser().resolve()),
            "preset": preset,
            "agents": agents or [],
            "counts": default_watchtower_counts(),
        },
    )
    ensure_watchtower_run_agent_paths(workspace, payload)
    atomic_write_json(current_dir / "run.json", payload)
    return payload


def read_watchtower_run(workspace: Path, run_id: str) -> dict[str, Any]:
    path = watchtower_run_path(workspace, run_id)
    if not path.exists():
        raise SwitchboardError("Watchtower run was not found.")
    try:
        return normalize_watchtower_run(workspace, json.loads(path.read_text(encoding="utf-8")))
    except json.JSONDecodeError as exc:
        raise SwitchboardError(f"Invalid Watchtower run JSON: {exc.msg}") from exc


def write_watchtower_run(workspace: Path, run: dict[str, Any]) -> dict[str, Any]:
    normalized = normalize_watchtower_run(workspace, run)
    current_dir = watchtower_run_dir(workspace, normalized["runId"])
    current_dir.mkdir(parents=True, exist_ok=True)
    (current_dir / "reports").mkdir(exist_ok=True)
    ensure_watchtower_run_agent_paths(workspace, normalized)
    atomic_write_json(current_dir / "run.json", normalized)
    return normalized


def update_watchtower_run(
    workspace: Path,
    run_id: str,
    *,
    status: str | None = None,
    counts: dict[str, Any] | None = None,
    agents: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    run = read_watchtower_run(workspace, run_id)
    if status is not None:
        if status not in WATCHTOWER_RUN_STATUSES:
            raise SwitchboardError("Watchtower run status is invalid.")
        run["status"] = status
        if status in {"completed", "failed", "canceled"} and run.get("completedAt") is None:
            run["completedAt"] = now_iso()
        if status in {"pending", "running"}:
            run["completedAt"] = None
    if counts is not None:
        run["counts"] = normalize_watchtower_counts(counts)
    if agents is not None:
        run["agents"] = agents
    return write_watchtower_run(workspace, run)


def update_watchtower_agent(
    workspace: Path,
    run_id: str,
    agent_id: str,
    *,
    status: str | None = None,
    execution_id: str | None = None,
    error_message: str | None = None,
) -> dict[str, Any]:
    if status not in WATCHTOWER_RUN_STATUSES:
        if status is not None:
            raise SwitchboardError("Watchtower agent status is invalid.")
    run = read_watchtower_run(workspace, run_id)
    matched = False
    agents: list[dict[str, Any]] = []
    for agent in run["agents"]:
        if agent.get("agentId") == agent_id:
            matched = True
            next_agent = dict(agent)
            if status is not None:
                next_agent["status"] = status
            if execution_id is not None:
                next_agent["executionId"] = execution_id
            if error_message is not None:
                next_agent["errorMessage"] = error_message.strip() or None
            elif status in {"pending", "running", "completed"}:
                next_agent["errorMessage"] = None
            agents.append(next_agent)
        else:
            agents.append(agent)
    if not matched:
        raise SwitchboardError("Watchtower run agent was not found.")
    run["agents"] = agents
    if any(agent.get("status") == "failed" for agent in agents):
        run["status"] = "failed"
        run["completedAt"] = now_iso()
    elif any(agent.get("status") == "canceled" for agent in agents):
        run["status"] = "canceled"
        run["completedAt"] = now_iso()
    elif agents and all(agent.get("status") == "completed" for agent in agents):
        run["status"] = "completed"
        run["completedAt"] = now_iso()
    elif any(agent.get("status") == "running" for agent in agents) or any(agent.get("status") == "pending" for agent in agents):
        run["status"] = "running"
        run["completedAt"] = None
    return write_watchtower_run(workspace, run)


def update_watchtower_agent_status(workspace: Path, run_id: str, agent_id: str, status: str) -> dict[str, Any]:
    if status not in WATCHTOWER_RUN_STATUSES:
        raise SwitchboardError("Watchtower agent status is invalid.")
    return update_watchtower_agent(workspace, run_id, agent_id, status=status)


def list_watchtower_runs_with_problems(workspace: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    init_workspace(workspace)
    root = watchtower_run_root(workspace)
    runs: list[dict[str, Any]] = []
    problems: list[dict[str, Any]] = []
    for entry in sorted(root.iterdir(), reverse=True):
        if not entry.is_dir():
            continue
        run_file = entry / "run.json"
        if not run_file.exists():
            continue
        try:
            runs.append(normalize_watchtower_run(workspace, json.loads(run_file.read_text(encoding="utf-8"))))
        except json.JSONDecodeError as exc:
            problems.append({"runId": entry.name, "path": str(run_file), "message": f"Invalid Watchtower run JSON: {exc.msg}"})
        except SwitchboardError as exc:
            problems.append({"runId": entry.name, "path": str(run_file), "message": str(exc)})
    return sorted(runs, key=lambda run: run["createdAt"], reverse=True), problems


def list_watchtower_runs(workspace: Path) -> list[dict[str, Any]]:
    runs, _problems = list_watchtower_runs_with_problems(workspace)
    return runs
