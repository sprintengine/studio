from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .store import SwitchboardError, atomic_write_json, create_inbox_task_if_source_missing, init_workspace, now_iso, switchboard_root


WATCHTOWER_RUN_STATUSES = ("pending", "running", "completed", "failed", "canceled")
WATCHTOWER_RUN_ID_RE = re.compile(r"^watchtower_[0-9]{8}T[0-9]{6}Z_[0-9a-f]{8}$")


@dataclass(frozen=True)
class WatchtowerProposalEntry:
    proposal: dict[str, Any] | None
    path: Path
    relative_path: str
    line: int | None
    raw_content: str
    error: str | None = None


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
    if not isinstance(agent_id, str) or not agent_id.strip():
        return None
    return {
        "agentId": agent_id.strip(),
        "specialistId": specialist_id.strip() if isinstance(specialist_id, str) and specialist_id.strip() else None,
        "status": status if status in WATCHTOWER_RUN_STATUSES else "pending",
        "outputDir": output_dir.strip() if isinstance(output_dir, str) and output_dir.strip() else f"outputs/{agent_id.strip()}",
        "reportPath": report_path.strip() if isinstance(report_path, str) and report_path.strip() else None,
    }


def ensure_watchtower_run_agent_paths(workspace: Path, run: dict[str, Any]) -> None:
    current_dir = watchtower_run_dir(workspace, run["runId"])
    for agent in run.get("agents", []):
        output_dir = agent.get("outputDir")
        if isinstance(output_dir, str) and output_dir.strip():
            run_child_path(current_dir, output_dir).mkdir(parents=True, exist_ok=True)
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
    (current_dir / "outputs").mkdir()
    (current_dir / "quarantine").mkdir()
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
    (current_dir / "outputs").mkdir(exist_ok=True)
    (current_dir / "quarantine").mkdir(exist_ok=True)
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


def update_watchtower_agent_status(workspace: Path, run_id: str, agent_id: str, status: str) -> dict[str, Any]:
    if status not in WATCHTOWER_RUN_STATUSES:
        raise SwitchboardError("Watchtower agent status is invalid.")
    run = read_watchtower_run(workspace, run_id)
    matched = False
    agents: list[dict[str, Any]] = []
    for agent in run["agents"]:
        if agent.get("agentId") == agent_id:
            matched = True
            agents.append({**agent, "status": status})
        else:
            agents.append(agent)
    if not matched:
        raise SwitchboardError("Watchtower run agent was not found.")
    run["agents"] = agents
    if any(agent.get("status") == "failed" for agent in agents):
        run["status"] = "failed"
        run["completedAt"] = now_iso()
    elif agents and all(agent.get("status") == "completed" for agent in agents):
        run["status"] = "completed"
        run["completedAt"] = now_iso()
    elif any(agent.get("status") == "running" for agent in agents):
        run["status"] = "running"
        run["completedAt"] = None
    return write_watchtower_run(workspace, run)


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


def safe_excerpt(value: str, limit: int = 4000) -> str:
    if len(value) <= limit:
        return value
    return value[:limit] + "\n...[truncated]"


def quarantine_file_name(entry: WatchtowerProposalEntry) -> str:
    base = re.sub(r"[^A-Za-z0-9._-]+", "-", entry.relative_path).strip("-")
    line_suffix = f"-line-{entry.line}" if entry.line is not None else ""
    return f"{base}{line_suffix}.json"


def write_quarantine_entry(workspace: Path, run_id: str, entry: WatchtowerProposalEntry, error: str) -> dict[str, Any]:
    payload = {
        "schemaVersion": 1,
        "runId": run_id,
        "originalPath": entry.relative_path,
        "line": entry.line,
        "validationError": error,
        "rawContent": safe_excerpt(entry.raw_content),
        "quarantinedAt": now_iso(),
    }
    path = watchtower_run_dir(workspace, run_id) / "quarantine" / quarantine_file_name(entry)
    atomic_write_json(path, payload)
    return {**payload, "path": str(path)}


def output_root_for_run(workspace: Path, run_id: str) -> Path:
    return watchtower_run_dir(workspace, run_id) / "outputs"


def parse_watchtower_output_file(workspace: Path, run_id: str, path: Path) -> list[WatchtowerProposalEntry]:
    root = output_root_for_run(workspace, run_id).resolve()
    relative_path = str(path.resolve().relative_to(root))
    raw = path.read_text(encoding="utf-8")
    if path.suffix == ".jsonl":
        entries: list[WatchtowerProposalEntry] = []
        for index, line in enumerate(raw.splitlines(), start=1):
            if not line.strip():
                continue
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError as exc:
                entries.append(WatchtowerProposalEntry(None, path, relative_path, index, line, f"Invalid JSON: {exc.msg}"))
                continue
            entries.append(WatchtowerProposalEntry(parsed if isinstance(parsed, dict) else None, path, relative_path, index, line))
        return entries
    if path.suffix == ".json":
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            return [WatchtowerProposalEntry(None, path, relative_path, None, raw, f"Invalid JSON: {exc.msg}")]
        return [WatchtowerProposalEntry(parsed if isinstance(parsed, dict) else None, path, relative_path, None, raw)]
    return []


def iter_watchtower_output_entries(workspace: Path, run_id: str) -> list[WatchtowerProposalEntry]:
    read_watchtower_run(workspace, run_id)
    root = output_root_for_run(workspace, run_id)
    root.mkdir(parents=True, exist_ok=True)
    entries: list[WatchtowerProposalEntry] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix not in {".json", ".jsonl"}:
            continue
        entries.extend(parse_watchtower_output_file(workspace, run_id, path))
    return entries


def validate_watchtower_proposal(entry: WatchtowerProposalEntry) -> list[str]:
    if entry.error:
        return [entry.error]
    proposal = entry.proposal
    if not isinstance(proposal, dict):
        return ["Proposed task must be a JSON object."]
    errors: list[str] = []
    if not isinstance(proposal.get("title"), str) or not proposal.get("title", "").strip():
        errors.append("title is required.")
    if not isinstance(proposal.get("description"), str) or not proposal.get("description", "").strip():
        errors.append("description is required.")
    if proposal.get("priority") is not None and not isinstance(proposal.get("priority"), (int, float)):
        errors.append("priority must be a number or null.")
    if "labels" in proposal and (
        not isinstance(proposal.get("labels"), list) or not all(isinstance(item, str) for item in proposal.get("labels", []))
    ):
        errors.append("labels must be a string array.")
    if "localId" in proposal and proposal.get("localId") is not None and not isinstance(proposal.get("localId"), str):
        errors.append("localId must be a string or null.")
    source = proposal.get("source")
    if isinstance(source, dict) and isinstance(source.get("externalId"), str) and source.get("externalId", "").strip():
        errors.append("source.externalId must be derived by Watchtower ingestion, not agent output.")
    return errors


def sanitize_identity_part(value: str) -> str:
    sanitized = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-._")
    return sanitized or "item"


def derived_watchtower_external_id(run_id: str, entry: dict[str, Any]) -> str:
    proposal = entry["proposal"]
    agent_id = sanitize_identity_part(proposal_agent_id(entry) or "unknown-agent")
    local_id = proposal.get("localId")
    if isinstance(local_id, str) and local_id.strip():
        suffix = sanitize_identity_part(local_id.strip())
    else:
        path = sanitize_identity_part(str(entry.get("path") or "output"))
        line = entry.get("line")
        suffix = f"{path}-line-{line}" if isinstance(line, int) else path
    return f"{run_id}_{agent_id}_{suffix}"


def validate_watchtower_outputs(workspace: Path, run_id: str, *, quarantine: bool = True) -> dict[str, Any]:
    entries = iter_watchtower_output_entries(workspace, run_id)
    valid: list[dict[str, Any]] = []
    invalid: list[dict[str, Any]] = []
    seen_external_ids: dict[str, dict[str, Any]] = {}
    for entry in entries:
        errors = validate_watchtower_proposal(entry)
        if errors:
            error = " ".join(errors)
            quarantined = write_quarantine_entry(workspace, run_id, entry, error) if quarantine else None
            invalid.append(
                {
                    "path": entry.relative_path,
                    "line": entry.line,
                    "error": error,
                    "quarantine": quarantined,
                }
            )
            continue
        assert entry.proposal is not None
        valid_entry = {"path": entry.relative_path, "line": entry.line, "proposal": entry.proposal}
        external_id = derived_watchtower_external_id(run_id, valid_entry)
        previous = seen_external_ids.get(external_id)
        if previous:
            error = f"Duplicate proposed task identity: {external_id} also appears in {previous['path']}."
            quarantined = write_quarantine_entry(workspace, run_id, entry, error) if quarantine else None
            invalid.append(
                {
                    "path": entry.relative_path,
                    "line": entry.line,
                    "error": error,
                    "quarantine": quarantined,
                }
            )
            continue
        seen_external_ids[external_id] = valid_entry
        valid.append({**valid_entry, "externalId": external_id})
    run = read_watchtower_run(workspace, run_id)
    update_watchtower_run(
        workspace,
        run_id,
        counts={
            **run["counts"],
            "valid": len(valid),
            "invalid": len(invalid),
        },
    )
    return {"ok": True, "runId": run_id, "valid": valid, "invalid": invalid}


def proposal_agent_id(entry: dict[str, Any]) -> str | None:
    path = entry.get("path")
    if not isinstance(path, str):
        return None
    parts = Path(path).parts
    return parts[0] if parts else None


def comment_for_proposal(run_id: str, entry: dict[str, Any]) -> dict[str, Any]:
    proposal = entry["proposal"]
    evidence = proposal.get("evidence") if isinstance(proposal.get("evidence"), dict) else {}
    files = evidence.get("files") if isinstance(evidence.get("files"), list) else []
    summary = evidence.get("summary") if isinstance(evidence.get("summary"), str) else ""
    body_parts = [f"Imported from Watchtower run {run_id}."]
    agent_id = proposal_agent_id(entry)
    if agent_id:
        body_parts.append(f"Agent output: {agent_id}.")
    if summary.strip():
        body_parts.append(summary.strip())
    relative_files = [item for item in files if isinstance(item, str) and item.strip()]
    if relative_files:
        body_parts.append("Evidence files: " + ", ".join(relative_files))
    return {
        "id": str(uuid.uuid4()),
        "author": {"type": "system", "id": "watchtower", "name": "Watchtower"},
        "kind": "import",
        "body": " ".join(body_parts),
        "createdAt": now_iso(),
    }


def ingest_watchtower_outputs(workspace: Path, run_id: str) -> dict[str, Any]:
    validation = validate_watchtower_outputs(workspace, run_id, quarantine=True)
    created: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for entry in validation["valid"]:
        proposal = entry["proposal"]
        external_id = entry["externalId"]
        located = create_inbox_task_if_source_missing(
            workspace,
            source_type="watchtower",
            external_id=external_id,
            title=proposal["title"],
            description=proposal["description"],
            priority=proposal.get("priority"),
            labels=proposal.get("labels") if isinstance(proposal.get("labels"), list) else None,
            source={"type": "watchtower", "externalId": external_id, "externalKey": None, "externalUrl": None},
            comments=[comment_for_proposal(run_id, entry)],
        )
        if located is None:
            skipped.append({"path": entry["path"], "line": entry["line"], "externalId": external_id, "reason": "duplicate"})
            continue
        created.append(
            {
                "path": entry["path"],
                "line": entry["line"],
                "externalId": external_id,
                "taskId": located.task["id"],
            }
        )
    update_watchtower_run(
        workspace,
        run_id,
        counts={
            "valid": len(validation["valid"]),
            "invalid": len(validation["invalid"]),
            "ingested": len(created) + len(skipped),
        },
    )
    return {
        "ok": True,
        "runId": run_id,
        "created": created,
        "skipped": skipped,
        "invalid": validation["invalid"],
        "summary": {
            "created": len(created),
            "skipped": len(skipped),
            "invalid": len(validation["invalid"]),
        },
    }
