#!/usr/bin/env python3
from pathlib import Path
import sys
import os
import json


REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import sprintengine_core.tool as direct_tool
from swarm_mcp import SwarmMcpServer
from swarm_mcp.auth import ActorContext


BACKEND_ENV = "SWARM_BACKEND"
ALLOWED_ROOT_ENV = "SWARM_MCP_ALLOWED_ROOT"
DIRECT_BACKENDS = {"direct", "direct-core", "core"}
MCP_BACKENDS = {"mcp", "mcp-local"}


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    backend, cleaned_argv, selected_by = _select_backend(argv)
    if _help_requested(cleaned_argv):
        print(f"[sprintengine] backend mode: {backend} (selected by {selected_by})", file=sys.stderr)
    if backend in DIRECT_BACKENDS:
        return direct_tool.main(cleaned_argv)
    if backend in MCP_BACKENDS:
        return _run_mcp_backend(cleaned_argv, backend)
    print(
        f"[sprintengine] unsupported backend mode: {backend}. "
        "Use direct-core or mcp-local.",
        file=sys.stderr,
    )
    return 2


def _select_backend(argv: list[str]) -> tuple[str, list[str], str]:
    backend = os.environ.get(BACKEND_ENV, "direct-core").strip() or "direct-core"
    selected_by = BACKEND_ENV if BACKEND_ENV in os.environ else "default"
    cleaned: list[str] = []
    index = 0
    while index < len(argv):
        value = argv[index]
        if value == "--backend":
            if index + 1 >= len(argv):
                print("[sprintengine] --backend requires a value: direct-core or mcp-local.", file=sys.stderr)
                raise SystemExit(2)
            backend = argv[index + 1].strip()
            selected_by = "--backend"
            index += 2
            continue
        if value.startswith("--backend="):
            backend = value.split("=", 1)[1].strip()
            selected_by = "--backend"
            index += 1
            continue
        cleaned.append(value)
        index += 1
    return backend, cleaned, selected_by


def _help_requested(argv: list[str]) -> bool:
    return any(value in {"-h", "--help"} for value in argv)


def _run_mcp_backend(argv: list[str], backend: str) -> int:
    parser = direct_tool.build_parser()
    args = parser.parse_args(argv)
    if getattr(args, "uses_state", True):
        state_path = args.state or direct_tool.default_state_path()
        direct_tool.reject_invalid_posix_state_path(state_path)
        args.state = state_path.resolve()
    elif args.state is not None:
        direct_tool.reject_invalid_posix_state_path(args.state)
        args.state = args.state.resolve()
    if not getattr(args, "uses_state", True):
        print(
            f"[sprintengine] backend mode {backend} does not support '{args.group}'. "
            "Use --backend direct-core for this command.",
            file=sys.stderr,
        )
        return 2

    try:
        tool_name, payload = _mcp_payload(args)
    except SystemExit as exc:
        message = _system_exit_message(exc)
        print(f"[sprintengine] backend mode {backend} cannot dispatch command: {message}", file=sys.stderr)
        return _system_exit_code(exc, default=2)

    try:
        state_path = Path(payload["statePath"]).resolve()
        actor = _actor_for(tool_name, payload, state_path)
        response = SwarmMcpServer(allowed_roots=_allowed_roots(state_path)).call_tool(tool_name, payload, actor)
    except Exception as exc:
        print(
            f"[sprintengine] backend mode {backend} failed before dispatch: {exc}",
            file=sys.stderr,
        )
        return 1

    if not response.get("ok"):
        error = response.get("error") or {}
        print(
            f"[sprintengine] backend mode {backend} returned {error.get('code', 'error')}: "
            f"{error.get('message', 'Swarm MCP operation failed.')}",
            file=sys.stderr,
        )
        return 1
    print(json.dumps(response["result"], indent=2))
    return 0


def _allowed_roots(state_path: Path) -> list[Path]:
    configured = os.environ.get(ALLOWED_ROOT_ENV, "").strip()
    if configured:
        return [Path(value).expanduser().resolve() for value in configured.split(os.pathsep) if value.strip()]
    return [REPO_ROOT.resolve(), state_path.parent.resolve()]


def _system_exit_message(exc: SystemExit) -> str:
    if exc.code is None:
        return "Swarm command exited."
    return str(exc.code)


def _system_exit_code(exc: SystemExit, *, default: int) -> int:
    return exc.code if isinstance(exc.code, int) else default


def _mcp_payload(args) -> tuple[str, dict]:
    base = {"statePath": str(args.state)}
    group = args.group
    action = getattr(args, "action", None)
    if group == "init":
        return "swarm.init", {**base, "goal": args.goal, "useWorktrees": bool(args.use_worktrees)}
    if group == "recover":
        return "swarm.recover", base
    if group == "join":
        return "swarm.join", {**base, "role": args.role, "id": args.id}
    if group == "summary":
        return "swarm.summary", base
    if group == "task":
        return _task_payload(action, args, base)
    if group == "plan":
        return _plan_payload(action, args, base)
    if group == "artifact":
        return _artifact_payload(action, args, base)
    raise SystemExit(f"MCP backend does not support command group: {group}")


def _task_payload(action: str, args, base: dict) -> tuple[str, dict]:
    if action == "next":
        return "swarm.task.next", {**base, "role": args.role, "id": args.id}
    if action == "claim":
        return "swarm.task.claim", {**base, "taskId": args.task_id, "id": args.id}
    if action == "status":
        payload = {**base, "taskId": args.task_id, "status": args.status, "id": args.id, "summary": args.summary}
        payload.update(_feedback_payload(args))
        return "swarm.task.status", payload
    if action == "log":
        return "swarm.task.log", {
            **base,
            "taskId": args.task_id,
            "id": args.id,
            "summary": args.summary,
            "file": args.file or [],
            "command": args.command or [],
            "result": args.result or [],
        }
    if action == "note":
        return "swarm.task.note", {**base, "taskId": args.task_id, "id": args.id, "note": args.note}
    if action == "list":
        return "swarm.task.list", {**base, "role": args.role}
    raise SystemExit(f"MCP backend does not support task action: {action}")


def _plan_payload(action: str, args, base: dict) -> tuple[str, dict]:
    if action == "add-task":
        return "swarm.plan.add_task", {
            **base,
            "actor": args.actor,
            "taskId": args.task_id,
            "title": args.title,
            "description": args.description,
            "role": args.role,
            "dependsOn": args.depends_on or [],
            "path": args.path or [],
            "acceptance": args.acceptance or [],
            "note": args.note or [],
        }
    if action == "update-task":
        return "swarm.plan.update_task", {
            **base,
            "actor": args.actor,
            "taskId": args.task_id,
            "title": args.title,
            "description": args.description,
            "clearDescription": args.clear_description,
            "role": args.role,
            "path": args.path,
            "clearPaths": args.clear_paths,
            "acceptance": args.acceptance,
            "clearAcceptance": args.clear_acceptance,
            "note": args.note,
            "clearNotes": args.clear_notes,
            "force": args.force,
        }
    if action == "delete-task":
        return "swarm.plan.delete_task", {
            **base,
            "actor": args.actor,
            "taskId": args.task_id,
            "unlinkDependents": args.unlink_dependents,
            "force": args.force,
        }
    if action in {"add-dependency", "remove-dependency"}:
        tool = "swarm.plan.add_dependency" if action == "add-dependency" else "swarm.plan.remove_dependency"
        return tool, {
            **base,
            "actor": args.actor,
            "taskId": args.task_id,
            "dependsOn": args.depends_on or [],
            "force": args.force,
        }
    if action == "start-review":
        return "swarm.plan.start_review", {**base, "role": args.role, "id": args.id}
    if action == "review-status":
        return "swarm.plan.review_status", base
    if action == "address-reviews":
        return "swarm.plan.address_reviews", {**base, "actor": args.actor}
    if action == "list":
        raise SystemExit("MCP backend does not support plan action: list")
    raise SystemExit(f"MCP backend does not support plan action: {action}")


def _artifact_payload(action: str, args, base: dict) -> tuple[str, dict]:
    if action == "add":
        return "swarm.artifact.add", {
            **base,
            "actor": args.actor,
            "artifactId": args.artifact_id,
            "taskId": args.task_id,
            "kind": args.kind,
            "title": args.title,
            "path": args.path,
            "createdBy": args.created_by,
            "recommendedTask": args.recommended_task or [],
            "ready": args.ready,
        }
    if action == "list":
        return "swarm.artifact.list", {
            **base,
            "taskId": args.task_id,
            "kind": args.kind,
            "status": args.status,
        }
    if action == "ready":
        payload = {**base, "artifactId": args.artifact_id, "id": args.id}
        payload.update(_feedback_payload(args))
        return "swarm.artifact.ready", payload
    if action == "approve":
        return "swarm.artifact.approve", {**base, "artifactId": args.artifact_id, "id": args.id}
    if action == "request-changes":
        return "swarm.artifact.request_changes", {
            **base,
            "artifactId": args.artifact_id,
            "id": args.id,
            "feedback": args.feedback,
        }
    raise SystemExit(f"MCP backend does not support artifact action: {action}")


def _feedback_payload(args) -> dict:
    payload = {}
    for attr, camel, _ in direct_tool.FEEDBACK_SCORE_FIELDS:
        value = getattr(args, attr, None)
        if value is not None:
            payload[camel] = value
    if getattr(args, "top_friction", ""):
        payload["topFriction"] = args.top_friction
    if getattr(args, "suggested_improvement", ""):
        payload["suggestedImprovement"] = args.suggested_improvement
    if getattr(args, "issue_json", None):
        payload["issueJson"] = args.issue_json
    if getattr(args, "finding_json", None):
        payload["findingJson"] = args.finding_json
    return payload


def _actor_for(tool_name: str, payload: dict, state_path: Path) -> ActorContext | None:
    del tool_name, payload, state_path
    return ActorContext.from_environment()


if __name__ == "__main__":
    raise SystemExit(main())
