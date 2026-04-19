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
                "error": "Task is not ready to be claimed.",
                "task": {
                    "id": task.get("id"),
                    "status": task.get("status"),
                    "ownerAgentId": task.get("ownerAgentId"),
                },
                "write": False,
            }

        task["ownerAgentId"] = args.agent_id
        task["status"] = "in_progress"
        task["startedAt"] = now_iso()
        agent = ensure_agent_runtime(state, args.agent_id, task.get("role"))
        agent["status"] = "running"
        agent["currentTaskId"] = args.task_id
        recompute_swarm_phase(state)
        event = append_event(state, "task_claimed", args.agent_id, f"{args.agent_id} claimed {args.task_id}.")
        return {"ok": True, "task": task, "agent": agent, "event": event}

    return with_locked_state(args.state, run)


def cmd_claim_next_task(args: argparse.Namespace) -> Dict[str, Any]:
    def run(state: Dict[str, Any]) -> Dict[str, Any]:
        if not state.get("swarm", {}).get("planApproved", False):
            return {
                "ok": False,
                "error": "The architect plan is not approved yet. Workers must remain paused.",
                "write": False,
            }

        agent = ensure_agent_runtime(state, args.agent_id, args.role)
        active_task = next(
            (
                task
                for task in state.get("tasks", [])
                if task.get("ownerAgentId") == args.agent_id
                and task.get("status") in {"in_progress", "needs_input"}
            ),
            None,
        )
        if active_task:
            agent["role"] = args.role
            agent["status"] = "needs_input" if active_task.get("status") == "needs_input" else "running"
            agent["currentTaskId"] = active_task.get("id")
            return {
                "ok": True,
                "claimed": False,
                "reason": "agent_already_has_active_task",
                "task": active_task,
                "agent": agent,
            }

        for task in state.get("tasks", []):
            if task.get("role") != args.role:
                continue
            if not task_is_ready(state, task):
                continue

            task["ownerAgentId"] = args.agent_id
            task["status"] = "in_progress"
            task["startedAt"] = task.get("startedAt") or now_iso()
            agent["role"] = args.role
            agent["status"] = "running"
            agent["currentTaskId"] = task.get("id")
            recompute_swarm_phase(state)
            event = append_event(
                state,
                "task_claimed",
                args.agent_id,
                f"{args.agent_id} claimed next {args.role} task {task.get('id')}.",
            )
            return {"ok": True, "claimed": True, "task": task, "agent": agent, "event": event}

        agent["role"] = args.role
        agent["status"] = "idle"
        agent["currentTaskId"] = None
        recompute_swarm_phase(state)
        return {
            "ok": True,
            "claimed": False,
            "reason": "no_ready_task",
            "message": f"No ready {args.role} tasks are available right now.",
            "agent": agent,
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
            elif args.status == "done":
                agent["status"] = "idle"
                agent["currentTaskId"] = None
            else:
                agent["status"] = "idle"
                agent["currentTaskId"] = None

        recompute_swarm_phase(state)

        event = append_event(state, "task_status_changed", actor, f"{actor} moved {args.task_id} to {args.status}.")
        return {"ok": True, "task": task, "event": event}

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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Swarm coordination tool")
    parser.add_argument(
        "--state",
        type=Path,
        default=default_state_path(),
        help="Path to swarm/state.yaml (defaults to nearest swarm/state.yaml from cwd).",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    list_ready = subparsers.add_parser("list-ready-tasks", help="List ready tasks, optionally filtered by role.")
    list_ready.add_argument("--role", choices=sorted(VALID_ROLES))
    list_ready.set_defaults(handler=cmd_list_ready)

    run_summary = subparsers.add_parser("run-summary", help="Print a final run summary from completed task evidence.")
    run_summary.set_defaults(handler=cmd_run_summary)

    validate_tasks = subparsers.add_parser("validate-tasks", help="Validate a JSON task graph before replacing the board.")
    validate_tasks.add_argument("--file", type=Path)
    validate_tasks.add_argument("--tasks-json")
    validate_tasks.set_defaults(handler=cmd_validate_tasks)

    replace_tasks = subparsers.add_parser("replace-tasks", help="Replace the kanban task graph from a JSON task list.")
    replace_tasks.add_argument("--actor", default="architect")
    replace_tasks.add_argument("--file", type=Path)
    replace_tasks.add_argument("--tasks-json")
    replace_tasks.add_argument("--force", action="store_true")
    replace_tasks.set_defaults(handler=cmd_replace_tasks)

    mark_plan_ready = subparsers.add_parser(
        "mark-plan-ready",
        help="Mark the architect plan and task graph ready for user approval.",
    )
    mark_plan_ready.add_argument("--actor", default="architect")
    mark_plan_ready.add_argument("--plan", type=Path)
    mark_plan_ready.add_argument("--force", action="store_true")
    mark_plan_ready.set_defaults(handler=cmd_mark_plan_ready)

    claim_task = subparsers.add_parser("claim-task", help="Claim a ready task for an agent.")
    claim_task.add_argument("--task-id", required=True)
    claim_task.add_argument("--agent-id", required=True)
    claim_task.set_defaults(handler=cmd_claim_task)

    claim_next_task = subparsers.add_parser(
        "claim-next-task",
        help="Atomically claim the next ready task for an agent role.",
    )
    claim_next_task.add_argument("--role", required=True, choices=sorted(VALID_ROLES))
    claim_next_task.add_argument("--agent-id", required=True)
    claim_next_task.set_defaults(handler=cmd_claim_next_task)

    set_status = subparsers.add_parser("set-task-status", help="Update the status of a task.")
    set_status.add_argument("--task-id", required=True)
    set_status.add_argument("--status", required=True, choices=sorted(VALID_TASK_STATUSES))
    set_status.add_argument("--actor")
    set_status.add_argument("--summary")
    set_status.set_defaults(handler=cmd_set_task_status)

    add_note = subparsers.add_parser("add-note", help="Append a note to a task.")
    add_note.add_argument("--task-id", required=True)
    add_note.add_argument("--actor", required=True)
    add_note.add_argument("--note", required=True)
    add_note.set_defaults(handler=cmd_add_note)

    append_evidence = subparsers.add_parser("append-evidence", help="Append evidence to a task.")
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
