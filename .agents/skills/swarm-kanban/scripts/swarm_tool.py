#!/usr/bin/env python3
"""Swarm coordination tool for specialist agents.

This tool updates the shared swarm coordination file used by swarm-mode agents.
It is intentionally file-based so architect and worker agents can coordinate
through structured state rather than ad-hoc chat.
"""

from __future__ import annotations

import argparse
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    import yaml  # type: ignore
except ImportError as exc:  # pragma: no cover - dependency check
    raise SystemExit(
        "PyYAML is required to use .agents/skills/swarm-kanban/scripts/swarm_tool.py. "
        "Install it in the agent environment with `python3 -m pip install pyyaml`."
    ) from exc


VALID_TASK_STATUSES = {"todo", "in_progress", "needs_input", "done"}
ACTIVE_TASK_STATUSES = {"in_progress", "needs_input"}
VALID_ROLES = {"architect", "product", "developer", "frontend", "tester", "security"}


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def default_state_path(start: Optional[Path] = None) -> Path:
    env_state_path = os.environ.get("SWARM_STATE_PATH")
    if env_state_path:
        return Path(env_state_path)

    current = (start or Path.cwd()).resolve()
    for candidate in [current, *current.parents]:
        state_path = candidate / "swarm" / "state.yaml"
        if state_path.exists():
            return state_path
        nested_state_paths = sorted((candidate / "swarm").glob("*/state.yaml"))
        if len(nested_state_paths) == 1:
            return nested_state_paths[0]
    return current / "swarm" / "state.yaml"


class StateLock:
    def __init__(self, path: Path, timeout_seconds: float = 30.0, poll_seconds: float = 0.2):
        self.path = path
        self.timeout_seconds = timeout_seconds
        self.poll_seconds = poll_seconds
        self.fd: Optional[int] = None

    def acquire(self) -> None:
        deadline = time.monotonic() + self.timeout_seconds
        payload = json.dumps({"pid": os.getpid(), "createdAt": now_iso()})

        while True:
            try:
                self.fd = os.open(str(self.path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(self.fd, payload.encode("utf-8"))
                return
            except FileExistsError:
                if time.monotonic() >= deadline:
                    raise SystemExit(
                        f"Timed out waiting for swarm state lock: {self.path}. "
                        "Another agent may still be updating the board."
                    )
                time.sleep(self.poll_seconds)

    def release(self) -> None:
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass

    def __enter__(self) -> "StateLock":
        self.acquire()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.release()


def load_state(path: Path) -> Dict[str, Any]:
    if not path.exists():
        raise SystemExit(f"State file not found: {path}")

    with path.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}

    if not isinstance(data, dict):
        raise SystemExit(f"Unexpected state shape in {path}")

    data.setdefault("events", [])
    data.setdefault("artifacts", [])
    data.setdefault("tasks", [])
    data.setdefault("agents", {})
    data.setdefault("roles", {})
    data.setdefault("swarm", {})
    return data


def save_state(path: Path, state: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(state, handle, indent=2)
        handle.write("\n")


def with_locked_state(path: Path, handler) -> Dict[str, Any]:
    lock = StateLock(path.with_suffix(f"{path.suffix}.lock"))
    with lock:
        state = load_state(path)
        result = handler(state)
        if result.get("write", True):
            save_state(path, state)
        result.pop("write", None)
        return result


def find_task(state: Dict[str, Any], task_id: str) -> Dict[str, Any]:
    for task in state.get("tasks", []):
        if task.get("id") == task_id:
            return task
    raise SystemExit(f"Task not found: {task_id}")


def append_event(state: Dict[str, Any], event_type: str, actor: str, message: str) -> Dict[str, Any]:
    event = {
        "id": f"EVT-{len(state['events']) + 1:03d}",
        "timestamp": now_iso(),
        "type": event_type,
        "actor": actor,
        "message": message,
    }
    state["events"].append(event)
    swarm = state.setdefault("swarm", {})
    swarm["updatedAt"] = now_iso()
    return event


def append_artifact(
    state: Dict[str, Any],
    artifact_type: str,
    title: str,
    *,
    content: Optional[str] = None,
    path: Optional[str] = None,
) -> Dict[str, Any]:
    artifact = {
        "id": f"ART-{len(state['artifacts']) + 1:03d}",
        "type": artifact_type,
        "title": title,
    }
    if content:
        artifact["content"] = content
    if path:
        artifact["path"] = path
    state["artifacts"].append(artifact)
    return artifact


def ensure_agent_runtime(state: Dict[str, Any], agent_id: str, role: Optional[str] = None) -> Dict[str, Any]:
    agents = state.setdefault("agents", {})
    agent = agents.setdefault(
        agent_id,
        {
            "role": role or "developer",
            "status": "idle",
            "currentTaskId": None,
        },
    )
    if role and not agent.get("role"):
        agent["role"] = role
    agent.setdefault("status", "idle")
    agent.setdefault("currentTaskId", None)
    return agent


def find_task_by_id(state: Dict[str, Any], task_id: Any) -> Optional[Dict[str, Any]]:
    for task in state.get("tasks", []):
        if isinstance(task, dict) and task.get("id") == task_id:
            return task
    return None


def set_agent_idle(agent: Dict[str, Any]) -> None:
    agent["status"] = "idle"
    agent["currentTaskId"] = None


def set_agent_active(agent: Dict[str, Any], task: Dict[str, Any]) -> None:
    agent["status"] = "needs_input" if task.get("status") == "needs_input" else "running"
    agent["currentTaskId"] = task.get("id")


def clear_runtime_refs_for_task(state: Dict[str, Any], task_id: str) -> List[str]:
    cleared = []
    agents = state.get("agents", {})
    if not isinstance(agents, dict):
        return cleared

    for agent_id, agent in agents.items():
        if not isinstance(agent, dict):
            continue
        if agent.get("currentTaskId") == task_id:
            set_agent_idle(agent)
            cleared.append(str(agent_id))
    return cleared


def reconcile_agent_runtime(state: Dict[str, Any], agent_id: str, role: str) -> Dict[str, Any]:
    agent = ensure_agent_runtime(state, agent_id, role)
    agent["role"] = role
    repairs = []

    current_task_id = agent.get("currentTaskId")
    if current_task_id:
        current_task = find_task_by_id(state, current_task_id)
        if not current_task or current_task.get("status") not in ACTIVE_TASK_STATUSES:
            set_agent_idle(agent)
            repairs.append(f"cleared stale currentTaskId {current_task_id}")
        elif current_task.get("ownerAgentId") in (None, "", agent_id):
            current_task["ownerAgentId"] = agent_id
            set_agent_active(agent, current_task)
            return {"agent": agent, "activeTask": current_task, "repairs": repairs}
        else:
            set_agent_idle(agent)
            repairs.append(
                f"cleared currentTaskId {current_task_id} because task owner is {current_task.get('ownerAgentId')}"
            )

    active_task = next(
        (
            task
            for task in state.get("tasks", [])
            if isinstance(task, dict)
            and task.get("ownerAgentId") == agent_id
            and task.get("status") in ACTIVE_TASK_STATUSES
        ),
        None,
    )
    if active_task:
        set_agent_active(agent, active_task)
        return {"agent": agent, "activeTask": active_task, "repairs": repairs}

    set_agent_idle(agent)
    return {"agent": agent, "activeTask": None, "repairs": repairs}


def assign_task_to_agent(
    state: Dict[str, Any],
    task: Dict[str, Any],
    agent_id: str,
) -> Dict[str, Any]:
    previous_owner = task.get("ownerAgentId")
    task["ownerAgentId"] = agent_id
    task["status"] = "in_progress"
    task["startedAt"] = task.get("startedAt") or now_iso()
    agent = ensure_agent_runtime(state, agent_id, task.get("role"))
    set_agent_active(agent, task)
    return {"agent": agent, "previousOwnerAgentId": previous_owner}


def recompute_swarm_phase(state: Dict[str, Any]) -> None:
    swarm = state.setdefault("swarm", {})
    tasks = state.get("tasks", [])
    if not swarm.get("planApproved", False):
        swarm["status"] = "awaiting_approval"
        return
    if tasks and all(task.get("status") == "done" for task in tasks):
        swarm["status"] = "completed"
        return
    swarm["status"] = "executing"


def task_validation_payload(validation: Dict[str, List[str]]) -> Dict[str, Any]:
    return {
        "ok": len(validation["errors"]) == 0,
        "checkedAt": now_iso(),
        "errors": validation["errors"],
        "warnings": validation["warnings"],
    }


def ensure_task_evidence(task: Dict[str, Any]) -> Dict[str, Any]:
    evidence = task.setdefault("evidence", {})
    evidence.setdefault("summary", "")
    evidence.setdefault("touchedFiles", [])
    evidence.setdefault("commandsRan", [])
    evidence.setdefault("results", [])
    return evidence


def safe_mailbox_segment(value: str) -> str:
    normalized = value.strip()
    if not normalized or normalized in {".", ".."}:
        raise SystemExit("Mailbox agent id must be non-empty.")
    if "/" in normalized or "\\" in normalized:
        raise SystemExit(f"Mailbox agent id must not contain path separators: {value!r}")
    return normalized


def mailbox_root(state_path: Path) -> Path:
    return state_path.parent / "mailboxes"


def agent_mailbox_path(state_path: Path, agent_id: str) -> Path:
    return mailbox_root(state_path) / safe_mailbox_segment(agent_id)


def mailbox_message_id(prefix: str = "MSG") -> str:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"{prefix}-{timestamp}-{os.getpid()}"


def read_mailbox_message(path: Path) -> Dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Mailbox message is not valid JSON: {path}") from exc
    if not isinstance(payload, dict):
        raise SystemExit(f"Mailbox message must be an object: {path}")
    payload.setdefault("id", path.stem)
    return payload


def write_mailbox_message(
    state_path: Path,
    *,
    to_agent: str,
    from_agent: str,
    subject: str,
    body: str,
    message_id: Optional[str] = None,
    reply_to: Optional[str] = None,
) -> Dict[str, Any]:
    agent_id = safe_mailbox_segment(to_agent)
    message_id = safe_mailbox_segment(message_id or mailbox_message_id())
    inbox = agent_mailbox_path(state_path, agent_id)
    inbox.mkdir(parents=True, exist_ok=True)

    payload = {
        "id": message_id,
        "from": from_agent,
        "to": agent_id,
        "subject": subject,
        "body": body,
        "createdAt": now_iso(),
    }
    if reply_to:
        payload["replyTo"] = reply_to
    message_path = inbox / f"{message_id}.json"
    with message_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")
    return {"message": payload, "path": str(message_path)}


def find_reply_messages(
    state_path: Path,
    *,
    inbox_agent: str,
    request_id: str,
    expected_from_agent: Optional[str] = None,
) -> List[Dict[str, Any]]:
    inbox = agent_mailbox_path(state_path, inbox_agent)
    inbox.mkdir(parents=True, exist_ok=True)

    replies = []
    for path in sorted(path for path in inbox.glob("*.json") if path.is_file()):
        message = read_mailbox_message(path)
        if expected_from_agent and message.get("from") != expected_from_agent:
            continue
        if message.get("replyTo") != request_id and message.get("inReplyTo") != request_id:
            continue
        replies.append({"message": message, "path": str(path)})
    return replies


def consume_mailbox_paths(paths: List[Path]) -> None:
    if not paths:
        return

    read_dir = paths[0].parent / "read"
    read_dir.mkdir(parents=True, exist_ok=True)
    consumed_at = now_iso()
    for path in paths:
        message = read_mailbox_message(path)
        message["consumedAt"] = consumed_at
        target = read_dir / path.name
        with path.open("w", encoding="utf-8") as handle:
            json.dump(message, handle, indent=2)
            handle.write("\n")
        os.replace(path, target)


def normalize_task_card(raw_task: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(raw_task, dict):
        raise SystemExit("Each task must be an object.")

    task_id = str(raw_task.get("id", "")).strip()
    title = str(raw_task.get("title", "")).strip()
    role = str(raw_task.get("role", "")).strip()
    if not task_id:
        raise SystemExit("Each task must include a non-empty id.")
    if not title:
        raise SystemExit(f"Task {task_id} must include a non-empty title.")
    if role not in VALID_ROLES:
        raise SystemExit(f"Task {task_id} has invalid role {role!r}.")

    status = str(raw_task.get("status", "todo")).strip() or "todo"
    if status not in VALID_TASK_STATUSES:
        raise SystemExit(f"Task {task_id} has invalid status {status!r}.")

    evidence = raw_task.get("evidence")
    if not isinstance(evidence, dict):
        evidence = {}

    return {
        "id": task_id,
        "title": title,
        "description": str(raw_task.get("description", "")).strip(),
        "role": role,
        "status": status,
        "ownerAgentId": raw_task.get("ownerAgentId") or None,
        "dependsOn": [str(item).strip() for item in raw_task.get("dependsOn", []) if str(item).strip()],
        "ownedPaths": [str(item).strip() for item in raw_task.get("ownedPaths", []) if str(item).strip()],
        "acceptanceCriteria": [
            str(item).strip() for item in raw_task.get("acceptanceCriteria", []) if str(item).strip()
        ],
        "implementationNotes": [
            str(item).strip() for item in raw_task.get("implementationNotes", []) if str(item).strip()
        ],
        "evidence": {
            "summary": str(evidence.get("summary", "")).strip(),
            "touchedFiles": [str(item).strip() for item in evidence.get("touchedFiles", []) if str(item).strip()],
            "commandsRan": [str(item).strip() for item in evidence.get("commandsRan", []) if str(item).strip()],
            "results": [str(item).strip() for item in evidence.get("results", []) if str(item).strip()],
        },
        "questionsForUser": [
            str(item).strip() for item in raw_task.get("questionsForUser", []) if str(item).strip()
        ],
        "notes": [str(item).strip() for item in raw_task.get("notes", []) if str(item).strip()],
        "artifacts": raw_task.get("artifacts", []) if isinstance(raw_task.get("artifacts", []), list) else [],
        "startedAt": raw_task.get("startedAt") or None,
        "completedAt": raw_task.get("completedAt") or None,
    }


def load_tasks_payload(args: argparse.Namespace) -> List[Dict[str, Any]]:
    if args.tasks_json:
        payload = json.loads(args.tasks_json)
    elif args.file:
        with args.file.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    else:
        raise SystemExit("Provide --file or --tasks-json.")

    tasks = payload.get("tasks") if isinstance(payload, dict) else payload
    if not isinstance(tasks, list):
        raise SystemExit("Task payload must be a list or an object with a tasks list.")
    return [normalize_task_card(task) for task in tasks]


def validate_task_graph(tasks: List[Dict[str, Any]]) -> Dict[str, List[str]]:
    errors: List[str] = []
    warnings: List[str] = []
    task_ids = [task["id"] for task in tasks]
    task_id_set = set(task_ids)

    if len(task_ids) != len(task_id_set):
        seen = set()
        duplicates = []
        for task_id in task_ids:
            if task_id in seen and task_id not in duplicates:
                duplicates.append(task_id)
            seen.add(task_id)
        errors.append(f"Duplicate task ids: {', '.join(duplicates)}")

    for task in tasks:
        task_id = task["id"]
        if not task["description"]:
            warnings.append(f"{task_id}: description is empty.")
        if not task["ownedPaths"]:
            warnings.append(f"{task_id}: ownedPaths is empty; file ownership will be unclear.")
        if not task["acceptanceCriteria"]:
            warnings.append(f"{task_id}: acceptanceCriteria is empty.")
        if not task["implementationNotes"]:
            warnings.append(f"{task_id}: implementationNotes is empty.")
        for dependency_id in task["dependsOn"]:
            if dependency_id not in task_id_set:
                errors.append(f"{task_id}: dependency {dependency_id!r} does not exist.")
            if dependency_id == task_id:
                errors.append(f"{task_id}: task cannot depend on itself.")

    path_owners: Dict[str, List[str]] = {}
    for task in tasks:
        for path in task["ownedPaths"]:
            path_owners.setdefault(path, []).append(task["id"])
    for path, owners in path_owners.items():
        if len(owners) > 1:
            warnings.append(
                f"Owned path {path!r} appears in multiple tasks ({', '.join(owners)}). "
                "Make sure these tasks are dependency-ordered if they may touch the same files."
            )

    return {"errors": errors, "warnings": warnings}


def task_is_ready(state: Dict[str, Any], task: Dict[str, Any]) -> bool:
    if not state.get("swarm", {}).get("planApproved", False):
        return False
    if task.get("status") != "todo":
        return False
    if task.get("ownerAgentId"):
        return False

    tasks = state.get("tasks", [])
    for dependency_id in task.get("dependsOn", []):
        dependency = next((candidate for candidate in tasks if candidate.get("id") == dependency_id), None)
        if dependency is None or dependency.get("status") != "done":
            return False
    return True


def unique_strings(values: List[Any]) -> List[str]:
    seen = set()
    result = []
    for value in values:
        if not isinstance(value, str):
            continue
        normalized = value.strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return result


def build_run_summary(state: Dict[str, Any]) -> Dict[str, Any]:
    tasks = state.get("tasks", [])
    completed = [task for task in tasks if task.get("status") == "done"]
    open_questions = []
    task_summaries = []
    touched_files: List[Any] = []
    commands_ran: List[Any] = []
    results: List[str] = []

    for task in completed:
        evidence = ensure_task_evidence(task)
        task_id = task.get("id", "unknown")
        title = task.get("title", "Untitled task")
        summary = evidence.get("summary") or "No completion summary recorded."
        task_summaries.append(
            {
                "id": task_id,
                "title": title,
                "summary": summary,
                "ownerAgentId": task.get("ownerAgentId"),
                "completedAt": task.get("completedAt"),
            }
        )
        touched_files.extend(evidence.get("touchedFiles", []))
        commands_ran.extend(evidence.get("commandsRan", []))
        results.extend([f"{task_id}: {item}" for item in evidence.get("results", []) if isinstance(item, str)])

    for task in tasks:
        task_id = task.get("id", "unknown")
        for question in task.get("questionsForUser", []):
            if isinstance(question, str) and question.strip():
                open_questions.append(f"{task_id}: {question.strip()}")

    swarm = state.get("swarm", {})
    return {
        "goal": swarm.get("goal", ""),
        "status": swarm.get("status", "planning"),
        "planApproved": bool(swarm.get("planApproved", False)),
        "tasks": {
            "total": len(tasks),
            "completed": len(completed),
            "remaining": max(0, len(tasks) - len(completed)),
        },
        "touchedFiles": unique_strings(touched_files),
        "commandsRan": unique_strings(commands_ran),
        "results": results,
        "completedTasks": task_summaries,
        "openQuestions": open_questions,
        "manualVerification": "Manually test the uncommitted workspace changes before committing or reverting.",
    }


def cmd_list_ready(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        ready_tasks = []
        for task in state.get("tasks", []):
            if args.role and task.get("role") != args.role:
                continue
            if task_is_ready(state, task):
                ready_tasks.append(
                    {
                        "id": task.get("id"),
                        "title": task.get("title"),
                        "role": task.get("role"),
                        "dependsOn": task.get("dependsOn", []),
                        "ownedPaths": task.get("ownedPaths", []),
                    }
                )
        return {"ok": True, "readyTasks": ready_tasks, "write": False}

    return with_locked_state(args.state, run)


def cmd_run_summary(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        return {"ok": True, "summary": build_run_summary(state), "write": False}

    return with_locked_state(args.state, run)


def cmd_send_message(args: argparse.Namespace) -> Dict[str, Any]:
    root = mailbox_root(args.state)
    root.mkdir(parents=True, exist_ok=True)
    lock = StateLock(root / ".mailbox.lock")
    with lock:
        result = write_mailbox_message(
            args.state,
            to_agent=args.to_agent,
            from_agent=args.from_agent,
            subject=args.subject,
            body=args.body,
            message_id=args.message_id,
            reply_to=args.reply_to,
        )
    return {"ok": True, **result}


def cmd_send_and_receive(args: argparse.Namespace) -> Dict[str, Any]:
    root = mailbox_root(args.state)
    root.mkdir(parents=True, exist_ok=True)
    request_id = args.message_id or mailbox_message_id("REQ")
    response_instruction = (
        "\n\nReply by sending a correlated mailbox message with:\n"
        f"swarm send-message --from-agent {args.to_agent} --to-agent {args.from_agent} "
        f"--subject \"Re: {args.subject}\" --body \"<response>\" --reply-to {request_id}"
    )
    body = args.body if args.no_reply_instruction else f"{args.body}{response_instruction}"

    lock = StateLock(root / ".mailbox.lock")
    with lock:
        sent = write_mailbox_message(
            args.state,
            to_agent=args.to_agent,
            from_agent=args.from_agent,
            subject=args.subject,
            body=body,
            message_id=request_id,
        )

    deadline = time.monotonic() + max(0.0, args.timeout_seconds)
    poll_seconds = max(0.2, args.poll_seconds)
    last_replies: List[Dict[str, Any]] = []

    while True:
        with lock:
            replies = find_reply_messages(
                args.state,
                inbox_agent=args.from_agent,
                request_id=request_id,
                expected_from_agent=args.to_agent if args.require_responder else None,
            )
            if replies:
                last_replies = replies
                if args.consume:
                    consume_mailbox_paths([Path(reply["path"]) for reply in replies])
                break

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return {
                "ok": False,
                "timeout": True,
                "message": f"No reply received for {request_id} within {args.timeout_seconds:g} seconds.",
                "sent": sent,
                "replyTo": request_id,
            }
        time.sleep(min(poll_seconds, remaining))

    return {
        "ok": True,
        "sent": sent,
        "replyTo": request_id,
        "replyCount": len(last_replies),
        "replies": last_replies,
    }


def cmd_broadcast_message(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        agents = state.get("agents", {})
        if not isinstance(agents, dict):
            return {"ok": False, "error": "State agents field is not an object.", "write": False}

        recipients = []
        for agent_id, agent in agents.items():
            if args.role and isinstance(agent, dict) and agent.get("role") != args.role:
                continue
            if args.exclude and agent_id in args.exclude:
                continue
            recipients.append(agent_id)

        root = mailbox_root(args.state)
        root.mkdir(parents=True, exist_ok=True)
        lock = StateLock(root / ".mailbox.lock")
        messages = []
        with lock:
            for index, agent_id in enumerate(recipients, start=1):
                result = write_mailbox_message(
                    args.state,
                    to_agent=agent_id,
                    from_agent=args.from_agent,
                    subject=args.subject,
                    body=args.body,
                    message_id=f"{mailbox_message_id('BCAST')}-{index}",
                )
                messages.append(result)

        return {"ok": True, "recipientCount": len(recipients), "messages": messages, "write": False}

    return with_locked_state(args.state, run)


def cmd_get_mailbox(args: argparse.Namespace) -> Dict[str, Any]:
    inbox = agent_mailbox_path(args.state, args.agent_id)
    inbox.mkdir(parents=True, exist_ok=True)

    root = mailbox_root(args.state)
    root.mkdir(parents=True, exist_ok=True)
    lock = StateLock(root / ".mailbox.lock")
    with lock:
        message_paths = sorted(
            path for path in inbox.glob("*.json") if path.is_file()
        )
        if args.limit is not None:
            message_paths = message_paths[: max(0, args.limit)]

        messages = [read_mailbox_message(path) for path in message_paths]

        if args.consume and message_paths:
            read_dir = inbox / "read"
            read_dir.mkdir(parents=True, exist_ok=True)
            consumed_at = now_iso()
            for path, message in zip(message_paths, messages):
                message["consumedAt"] = consumed_at
                target = read_dir / path.name
                with path.open("w", encoding="utf-8") as handle:
                    json.dump(message, handle, indent=2)
                    handle.write("\n")
                os.replace(path, target)

    return {
        "ok": True,
        "agentId": args.agent_id,
        "mailbox": str(inbox),
        "count": len(messages),
        "messages": messages,
    }


def cmd_replace_tasks(args: argparse.Namespace) -> Dict[str, Any]:
    next_tasks = load_tasks_payload(args)
    validation = validate_task_graph(next_tasks)
    if validation["errors"]:
        return {"ok": False, "validation": validation}

    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        if state.get("swarm", {}).get("planApproved", False) and not args.force:
            return {
                "ok": False,
                "error": "Plan is already approved. Use --force only if you intentionally want to replace tasks.",
                "write": False,
            }

        state["tasks"] = next_tasks
        swarm = state.setdefault("swarm", {})
        swarm["planReady"] = False
        swarm["planReadyAt"] = None
        swarm["planReadyBy"] = None
        swarm["taskGraphReplacedAt"] = now_iso()
        swarm["taskValidation"] = task_validation_payload(validation)
        agents = state.setdefault("agents", {})
        for agent in agents.values():
            if isinstance(agent, dict):
                agent["status"] = "idle"
                agent["currentTaskId"] = None

        recompute_swarm_phase(state)
        event = append_event(
            state,
            "tasks_replaced",
            args.actor,
            f"{args.actor} replaced the swarm task graph with {len(next_tasks)} tasks.",
        )
        return {"ok": True, "taskCount": len(next_tasks), "validation": validation, "event": event}

    return with_locked_state(args.state, run)


def cmd_validate_tasks(args: argparse.Namespace) -> Dict[str, Any]:
    tasks = load_tasks_payload(args)
    validation = validate_task_graph(tasks)
    return {
        "ok": len(validation["errors"]) == 0,
        "taskCount": len(tasks),
        "validation": validation,
    }


def cmd_mark_plan_ready(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        swarm = state.setdefault("swarm", {})
        if swarm.get("planApproved", False) and not args.force:
            return {
                "ok": False,
                "error": "Plan is already approved. Refusing to mark planning readiness again without --force.",
                "write": False,
            }

        tasks = [normalize_task_card(task) for task in state.get("tasks", [])]
        validation = validate_task_graph(tasks)
        validation_payload = task_validation_payload(validation)
        swarm["taskValidation"] = validation_payload
        if validation["errors"]:
            return {
                "ok": False,
                "error": "Task graph has validation errors. Fix them before marking the plan ready.",
                "validation": validation,
            }

        task_graph_replaced = bool(swarm.get("taskGraphReplacedAt")) or any(
            event.get("type") == "tasks_replaced" for event in state.get("events", [])
        )
        if not task_graph_replaced and not args.force:
            return {
                "ok": False,
                "error": "Task graph has not been replaced by the architect yet. Run replace-tasks first.",
                "validation": validation,
            }

        plan_path = args.plan or args.state.parent / "plan.md"
        plan_warning = None
        try:
            plan_content = plan_path.read_text(encoding="utf-8")
            if "Draft placeholder" in plan_content or "Architect to fill in" in plan_content:
                plan_warning = "Plan file still appears to contain placeholder text."
        except FileNotFoundError:
            if not args.force:
                return {
                    "ok": False,
                    "error": f"Plan file not found: {plan_path}.",
                    "validation": validation,
                    "write": False,
                }
            plan_warning = f"Plan file not found: {plan_path}."

        if plan_warning:
            validation_payload["warnings"] = [*validation_payload["warnings"], plan_warning]

        swarm["planReady"] = True
        swarm["planReadyAt"] = now_iso()
        swarm["planReadyBy"] = args.actor
        swarm["taskValidation"] = validation_payload

        event = append_event(
            state,
            "plan_ready",
            args.actor,
            f"{args.actor} marked the architect plan ready for user review.",
        )
        return {"ok": True, "planReady": True, "validation": validation_payload, "event": event}

    return with_locked_state(args.state, run)


def cmd_claim_task(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        if not state.get("swarm", {}).get("planApproved", False):
            return {
                "ok": False,
                "error": "The architect plan is not approved yet. Workers must remain paused.",
                "write": False,
            }
        if not task_is_ready(state, task):
            return {
                "ok": False,
                "error": "Task is not ready to be claimed. If this is restarted work, reuse the same --agent-id that already owns the task.",
                "task": {
                    "id": task.get("id"),
                    "role": task.get("role"),
                    "status": task.get("status"),
                    "ownerAgentId": task.get("ownerAgentId"),
                },
                "write": False,
            }

        assignment = assign_task_to_agent(state, task, args.agent_id)
        agent = assignment["agent"]
        recompute_swarm_phase(state)
        event = append_event(state, "task_claimed", args.agent_id, f"{args.agent_id} claimed {args.task_id}.")
        return {
            "ok": True,
            "task": task,
            "agent": agent,
            "event": event,
        }

    return with_locked_state(args.state, run)


def cmd_claim_next_task(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        if not state.get("swarm", {}).get("planApproved", False):
            return {
                "ok": False,
                "error": "The architect plan is not approved yet. Workers must remain paused.",
                "write": False,
            }

        runtime = reconcile_agent_runtime(state, args.agent_id, args.role)
        agent = runtime["agent"]
        active_task = runtime["activeTask"]
        if active_task:
            return {
                "ok": True,
                "claimed": False,
                "reason": "agent_already_has_active_task",
                "task": active_task,
                "agent": agent,
                "repairs": runtime["repairs"],
            }

        for task in state.get("tasks", []):
            if task.get("role") != args.role:
                continue
            if not task_is_ready(state, task):
                continue

            assignment = assign_task_to_agent(state, task, args.agent_id)
            agent = assignment["agent"]
            recompute_swarm_phase(state)
            event = append_event(
                state,
                "task_claimed",
                args.agent_id,
                f"{args.agent_id} claimed next {args.role} task {task.get('id')}.",
            )
            return {
                "ok": True,
                "claimed": True,
                "task": task,
                "agent": agent,
                "event": event,
                "repairs": runtime["repairs"],
            }

        recompute_swarm_phase(state)
        return {
            "ok": True,
            "claimed": False,
            "reason": "no_ready_task",
            "message": f"No ready {args.role} tasks are available right now.",
            "agent": agent,
            "repairs": runtime["repairs"],
        }

    return with_locked_state(args.state, run)


def cmd_set_task_status(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        actor = args.actor or task.get("ownerAgentId") or task.get("role") or "agent"

        task["status"] = args.status
        if args.status == "in_progress" and not task.get("startedAt"):
            task["startedAt"] = now_iso()
        if args.status == "done":
            task["completedAt"] = now_iso()
        if args.summary:
            ensure_task_evidence(task)["summary"] = args.summary

        if task.get("ownerAgentId"):
            agent = ensure_agent_runtime(state, task["ownerAgentId"], task.get("role"))
            if args.status == "in_progress":
                agent["status"] = "running"
                agent["currentTaskId"] = args.task_id
            elif args.status == "needs_input":
                agent["status"] = "needs_input"
                agent["currentTaskId"] = args.task_id

        cleared_agents: List[str] = []
        if args.status not in ACTIVE_TASK_STATUSES:
            cleared_agents = clear_runtime_refs_for_task(state, args.task_id)

        recompute_swarm_phase(state)

        event = append_event(state, "task_status_changed", actor, f"{actor} moved {args.task_id} to {args.status}.")
        return {"ok": True, "task": task, "event": event, "clearedAgents": cleared_agents}

    return with_locked_state(args.state, run)


def cmd_add_note(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        task.setdefault("notes", []).append(args.note)
        event = append_event(state, "task_note_added", args.actor, f"{args.actor} added a note to {args.task_id}.")
        return {"ok": True, "task": task, "event": event}

    return with_locked_state(args.state, run)


def cmd_append_evidence(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        task = find_task(state, args.task_id)
        evidence = ensure_task_evidence(task)
        if args.summary:
            evidence["summary"] = args.summary
        evidence["touchedFiles"].extend(args.file or [])
        evidence["commandsRan"].extend(args.command or [])
        evidence["results"].extend(args.result or [])

        event = append_event(state, "task_evidence_appended", args.actor, f"{args.actor} appended evidence to {args.task_id}.")
        return {"ok": True, "task": task, "event": event}

    return with_locked_state(args.state, run)


def cmd_create_consultation(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        content_lines = [
            f"Request ID: {args.request_id}",
            f"From: {args.from_role}",
            f"To: {args.to_role}",
            f"Title: {args.title}",
        ]
        if args.task_id:
            content_lines.append(f"Task ID: {args.task_id}")
        if args.context:
            content_lines.extend(["", "Context:"])
            content_lines.extend([f"- {item}" for item in args.context])
        if args.question:
            content_lines.extend(["", "Questions:"])
            content_lines.extend([f"- {item}" for item in args.question])

        artifact = append_artifact(state, "consultation_request", args.title, content="\n".join(content_lines))
        event = append_event(
            state,
            "consultation_requested",
            args.from_role,
            f"{args.from_role} requested {args.to_role} consultation: {args.title}.",
        )
        return {"ok": True, "artifact": artifact, "event": event}

    return with_locked_state(args.state, run)


def cmd_complete_consultation(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        content_lines = [
            f"Request ID: {args.request_id}",
            f"Responder: {args.actor}",
            f"Summary: {args.summary}",
        ]
        if args.recommendation:
            content_lines.extend(["", "Recommendations:"])
            content_lines.extend([f"- {item}" for item in args.recommendation])

        artifact = append_artifact(
            state,
            "consultation_response",
            f"Consultation Response {args.request_id}",
            content="\n".join(content_lines),
        )
        event = append_event(
            state,
            "consultation_completed",
            args.actor,
            f"{args.actor} completed consultation {args.request_id}.",
        )
        return {"ok": True, "artifact": artifact, "event": event}

    return with_locked_state(args.state, run)


class SwarmArgumentParser(argparse.ArgumentParser):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        kwargs.setdefault("formatter_class", argparse.RawDescriptionHelpFormatter)
        super().__init__(*args, **kwargs)


TOP_LEVEL_HELP = """\
Agent discovery rule:
  Run `swarm --help` when a swarm terminal starts.
  Before using any subcommand for the first time, run `swarm <command> --help`.
  Follow the exact flags shown here; do not invent plural aliases.

Common worker flow:
  swarm get-mailbox --agent-id frontend-1 --consume
  swarm claim-next-task --role frontend --agent-id frontend-1
  swarm append-evidence --task-id T3 --actor frontend-1 --summary "Updated UI" --file src/file.ts --command "npm run typecheck" --result "Passed"
  swarm set-task-status --task-id T3 --status done --actor frontend-1 --summary "Implemented and verified."

Common architect flow:
  swarm validate-tasks --file swarm/tasks.json
  swarm replace-tasks --actor architect --file swarm/tasks.json
  swarm mark-plan-ready --actor architect

Strict flag notes:
  append-evidence uses repeatable --file, --command, and --result flags.
  A restarted Claude process should reuse the same swarm agent id, such as developer-1, to continue that slot's active work.
  There is no --touched-files, --commands-ran, --results, --recipient, --message, or --team flag.
  When calling the Python script directly, pass global --state before the subcommand.
"""


def build_parser() -> argparse.ArgumentParser:
    parser = SwarmArgumentParser(description="Swarm coordination tool", epilog=TOP_LEVEL_HELP)
    parser.add_argument(
        "--state",
        type=Path,
        default=default_state_path(),
        help="Path to swarm/state.yaml (defaults to nearest swarm/state.yaml from cwd).",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    list_ready = subparsers.add_parser(
        "list-ready-tasks",
        help="List ready tasks, optionally filtered by role.",
        epilog="Example:\n  swarm list-ready-tasks --role frontend",
    )
    list_ready.add_argument("--role", choices=sorted(VALID_ROLES))
    list_ready.set_defaults(handler=cmd_list_ready)

    run_summary = subparsers.add_parser(
        "run-summary",
        help="Print a final run summary from completed task evidence.",
        epilog="Example:\n  swarm run-summary",
    )
    run_summary.set_defaults(handler=cmd_run_summary)

    get_mailbox = subparsers.add_parser(
        "get-mailbox",
        help="Read an agent mailbox.",
        epilog="Example:\n  swarm get-mailbox --agent-id frontend-1 --consume",
    )
    get_mailbox.add_argument("--agent-id", required=True)
    get_mailbox.add_argument("--consume", action="store_true", help="Move returned messages into the mailbox read folder.")
    get_mailbox.add_argument("--limit", type=int)
    get_mailbox.set_defaults(handler=cmd_get_mailbox)

    send_message = subparsers.add_parser(
        "send-message",
        help="Send a message to one agent mailbox.",
        epilog=(
            "Example:\n"
            "  swarm send-message --from-agent frontend-1 --to-agent architect "
            "--subject \"Re: UX question\" --body \"Recommended approach...\" --reply-to REQ-123\n\n"
            "Strict flags:\n"
            "  Use --from-agent, --to-agent, --subject, and --body. There is no --recipient or --message flag."
        ),
    )
    send_message.add_argument("--to-agent", required=True)
    send_message.add_argument("--from-agent", required=True)
    send_message.add_argument("--subject", required=True)
    send_message.add_argument("--body", required=True)
    send_message.add_argument("--message-id")
    send_message.add_argument("--reply-to")
    send_message.set_defaults(handler=cmd_send_message)

    send_and_receive = subparsers.add_parser(
        "send-and-receive",
        help="Send a mailbox message and wait for a correlated reply.",
        epilog=(
            "Example:\n"
            "  swarm send-and-receive --from-agent architect --to-agent product "
            "--subject \"Product validation request\" --body \"Validate this MVP scope.\" "
            "--timeout-seconds 1800 --consume\n\n"
            "Replies should use the request id with send-message --reply-to <request-id>."
        ),
    )
    send_and_receive.add_argument("--to-agent", required=True)
    send_and_receive.add_argument("--from-agent", required=True)
    send_and_receive.add_argument("--subject", required=True)
    send_and_receive.add_argument("--body", required=True)
    send_and_receive.add_argument("--message-id")
    send_and_receive.add_argument("--timeout-seconds", type=float, default=900.0)
    send_and_receive.add_argument("--poll-seconds", type=float, default=5.0)
    send_and_receive.add_argument("--consume", action="store_true", help="Move the matched reply into the read folder.")
    send_and_receive.add_argument(
        "--no-reply-instruction",
        action="store_true",
        help="Do not append the suggested reply command to the outgoing body.",
    )
    send_and_receive.add_argument(
        "--require-responder",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Only accept replies from the requested recipient agent.",
    )
    send_and_receive.set_defaults(handler=cmd_send_and_receive)

    broadcast_message = subparsers.add_parser(
        "broadcast-message",
        help="Send a message to all agent mailboxes.",
        epilog=(
            "Examples:\n"
            "  swarm broadcast-message --from-agent architect --subject \"Plan ready\" --body \"Review your mailbox.\"\n"
            "  swarm broadcast-message --from-agent architect --role frontend --exclude frontend-2 --subject \"Heads up\" --body \"...\""
        ),
    )
    broadcast_message.add_argument("--from-agent", required=True)
    broadcast_message.add_argument("--subject", required=True)
    broadcast_message.add_argument("--body", required=True)
    broadcast_message.add_argument("--role", choices=sorted(VALID_ROLES))
    broadcast_message.add_argument("--exclude", action="append")
    broadcast_message.set_defaults(handler=cmd_broadcast_message)

    validate_tasks = subparsers.add_parser(
        "validate-tasks",
        help="Validate a JSON task graph before replacing the board.",
        epilog="Example:\n  swarm validate-tasks --file swarm/tasks.json",
    )
    validate_tasks.add_argument("--file", type=Path)
    validate_tasks.add_argument("--tasks-json")
    validate_tasks.set_defaults(handler=cmd_validate_tasks)

    replace_tasks = subparsers.add_parser(
        "replace-tasks",
        help="Replace the kanban task graph from a JSON task list.",
        epilog="Example:\n  swarm replace-tasks --actor architect --file swarm/tasks.json",
    )
    replace_tasks.add_argument("--actor", default="architect")
    replace_tasks.add_argument("--file", type=Path)
    replace_tasks.add_argument("--tasks-json")
    replace_tasks.add_argument("--force", action="store_true")
    replace_tasks.set_defaults(handler=cmd_replace_tasks)

    mark_plan_ready = subparsers.add_parser(
        "mark-plan-ready",
        help="Mark the architect plan and task graph ready for user approval.",
        epilog="Example:\n  swarm mark-plan-ready --actor architect",
    )
    mark_plan_ready.add_argument("--actor", default="architect")
    mark_plan_ready.add_argument("--plan", type=Path)
    mark_plan_ready.add_argument("--force", action="store_true")
    mark_plan_ready.set_defaults(handler=cmd_mark_plan_ready)

    claim_task = subparsers.add_parser(
        "claim-task",
        help="Claim a ready task for an agent.",
        epilog="Example:\n  swarm claim-task --task-id T3 --agent-id frontend-1",
    )
    claim_task.add_argument("--task-id", required=True)
    claim_task.add_argument("--agent-id", required=True)
    claim_task.set_defaults(handler=cmd_claim_task)

    claim_next_task = subparsers.add_parser(
        "claim-next-task",
        help="Atomically claim the next ready task for an agent role.",
        epilog=(
            "Example:\n"
            "  swarm claim-next-task --role frontend --agent-id frontend-1\n\n"
            "If frontend-1 is restarted, reuse --agent-id frontend-1. The command returns its existing active task before claiming new work."
        ),
    )
    claim_next_task.add_argument("--role", required=True, choices=sorted(VALID_ROLES))
    claim_next_task.add_argument("--agent-id", required=True)
    claim_next_task.set_defaults(handler=cmd_claim_next_task)

    set_status = subparsers.add_parser(
        "set-task-status",
        help="Update the status of a task.",
        epilog=(
            "Examples:\n"
            "  swarm set-task-status --task-id T3 --status in_progress --actor frontend-1\n"
            "  swarm set-task-status --task-id T3 --status done --actor frontend-1 --summary \"Implemented and verified.\""
        ),
    )
    set_status.add_argument("--task-id", required=True)
    set_status.add_argument("--status", required=True, choices=sorted(VALID_TASK_STATUSES))
    set_status.add_argument("--actor")
    set_status.add_argument("--summary")
    set_status.set_defaults(handler=cmd_set_task_status)

    add_note = subparsers.add_parser(
        "add-note",
        help="Append a note to a task.",
        epilog="Example:\n  swarm add-note --task-id T3 --actor frontend-1 --note \"Blocked on missing API detail.\"",
    )
    add_note.add_argument("--task-id", required=True)
    add_note.add_argument("--actor", required=True)
    add_note.add_argument("--note", required=True)
    add_note.set_defaults(handler=cmd_add_note)

    append_evidence = subparsers.add_parser(
        "append-evidence",
        help="Append evidence to a task.",
        epilog=(
            "Example:\n"
            "  swarm append-evidence --task-id T3 --actor frontend-1 --summary \"Updated board UI\" "
            "--file src/renderer/src/components/panels/SwarmBoardPanel.tsx "
            "--file src/renderer/src/utils/swarm.ts "
            "--command \"npm run typecheck\" "
            "--result \"Passed\"\n\n"
            "Strict flags:\n"
            "  Repeat --file once per touched path.\n"
            "  Repeat --command once per command run.\n"
            "  Repeat --result once per result or verification note.\n"
            "  There is no --touched-files, --commands-ran, or --results flag."
        ),
    )
    append_evidence.add_argument("--task-id", required=True)
    append_evidence.add_argument("--actor", required=True)
    append_evidence.add_argument("--summary")
    append_evidence.add_argument("--file", action="append")
    append_evidence.add_argument("--command", action="append")
    append_evidence.add_argument("--result", action="append")
    append_evidence.set_defaults(handler=cmd_append_evidence)

    create_consultation = subparsers.add_parser(
        "create-consultation",
        help="Create a structured specialist consultation request artifact.",
        epilog=(
            "Example:\n"
            "  swarm create-consultation --request-id UX-001 --from-role architect --to-role frontend "
            "--title \"Need UX input\" --task-id T4 --question \"Where should plan approval live?\""
        ),
    )
    create_consultation.add_argument("--request-id", required=True)
    create_consultation.add_argument("--from-role", required=True, choices=sorted(VALID_ROLES))
    create_consultation.add_argument("--to-role", required=True, choices=sorted(VALID_ROLES))
    create_consultation.add_argument("--title", required=True)
    create_consultation.add_argument("--task-id")
    create_consultation.add_argument("--context", action="append")
    create_consultation.add_argument("--question", action="append")
    create_consultation.set_defaults(handler=cmd_create_consultation)

    complete_consultation = subparsers.add_parser(
        "complete-consultation",
        help="Complete a consultation with a structured response artifact.",
        epilog=(
            "Example:\n"
            "  swarm complete-consultation --request-id UX-001 --actor frontend "
            "--summary \"Recommend a top-level approval banner.\" "
            "--recommendation \"Use a persistent approval strip above the board.\""
        ),
    )
    complete_consultation.add_argument("--request-id", required=True)
    complete_consultation.add_argument("--actor", required=True)
    complete_consultation.add_argument("--summary", required=True)
    complete_consultation.add_argument("--recommendation", action="append")
    complete_consultation.set_defaults(handler=cmd_complete_consultation)

    return parser


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    args.state = args.state.resolve()
    result = args.handler(args)
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
