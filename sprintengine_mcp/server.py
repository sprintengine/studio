"""Standalone local-first MCP boundary for the Sprint Engine coordination core."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable

from sprintengine_core.analysis import analyze_feedback_metrics
from sprintengine_core.audit import record_audit_event
from sprintengine_core.health import build_health_report
from sprintengine_core.tool import (
    FEEDBACK_SCORE_FIELDS,
    cmd_artifact_add,
    cmd_artifact_approve,
    cmd_artifact_list,
    cmd_artifact_ready,
    cmd_artifact_request_changes,
    cmd_init,
    cmd_join,
    cmd_plan_add_dependency,
    cmd_plan_add_task,
    cmd_plan_address_reviews,
    cmd_plan_delete_task,
    cmd_plan_list,
    cmd_plan_remove_dependency,
    cmd_plan_review_status,
    cmd_plan_start_review,
    cmd_plan_update_task,
    cmd_recover,
    cmd_roster_add,
    cmd_roster_list,
    cmd_summary,
    cmd_task_claim,
    cmd_task_list,
    cmd_task_log,
    cmd_task_next,
    cmd_task_note,
    cmd_task_comment,
    cmd_task_ready,
    cmd_task_status,
    load_state,
)

from .auth import MUTATING_TOOLS, ActorContext, AuthorizationError, authorize_tool
from .schemas import TOOL_SCHEMAS, list_tool_schemas


class McpToolError(Exception):
    """Structured MCP boundary error."""

    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}

    def to_dict(self) -> dict[str, Any]:
        error = {"code": self.code, "message": self.message}
        if self.details:
            error["details"] = self.details
        return error


class SprintEngineMcpServer:
    """Dependency-free local MCP tool dispatcher over Sprint Engine handlers."""

    def __init__(
        self,
        allowed_roots: list[str | Path] | None = None,
        stdio_actor: ActorContext | dict[str, Any] | None = None,
    ):
        self.allowed_roots = [Path(root).expanduser().resolve() for root in (allowed_roots or [])]
        self.stdio_actor = self._actor(stdio_actor)

    def list_tools(self) -> list[dict[str, Any]]:
        return list_tool_schemas()

    def call_tool(
        self,
        tool_name: str,
        payload: dict[str, Any] | None = None,
        actor: ActorContext | dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        start = time.monotonic()
        payload = payload or {}
        actor_context: ActorContext | None = None
        state_path: Path | None = None
        try:
            actor_context = self._actor(actor)
            if tool_name not in TOOL_SCHEMAS:
                raise McpToolError("unknown_tool", f"Unknown sprintengine MCP tool: {tool_name}")
            if not isinstance(payload, dict):
                raise McpToolError("invalid_payload", "Tool payload must be an object.")
            state_path = self._state_path(payload, required=tool_name != "sprintengine.health")
            authorize_tool(tool_name, payload, actor_context, state_path)
            if tool_name == "sprintengine.health":
                result = build_health_report(
                    state_path=state_path,
                    allowed_root=self.allowed_roots[0] if self.allowed_roots else None,
                    backend_mode="mcp-local",
                )
            else:
                assert state_path is not None
                result = self._dispatch(tool_name, state_path, payload, actor_context)
            self._audit(tool_name, state_path, actor_context, payload, start, "success", None)
            return {"ok": True, "tool": tool_name, "result": result}
        except McpToolError as exc:
            self._audit(tool_name, state_path, actor_context, payload, start, "failure", exc)
            return {"ok": False, "tool": tool_name, "error": exc.to_dict()}
        except AuthorizationError as exc:
            mapped = McpToolError("unauthorized", str(exc))
            self._audit(tool_name, state_path, actor_context, payload, start, "failure", mapped)
            return {"ok": False, "tool": tool_name, "error": mapped.to_dict()}
        except SystemExit as exc:
            mapped = McpToolError("core_error", _system_exit_message(exc))
            self._audit(tool_name, state_path, actor_context, payload, start, "failure", mapped)
            return {"ok": False, "tool": tool_name, "error": mapped.to_dict()}
        except Exception as exc:
            mapped = McpToolError("internal_error", "SprintEngine MCP operation failed.", {"errorClass": exc.__class__.__name__})
            self._audit(tool_name, state_path, actor_context, payload, start, "failure", mapped)
            return {"ok": False, "tool": tool_name, "error": mapped.to_dict()}

    def _dispatch(
        self,
        tool_name: str,
        state_path: Path,
        payload: dict[str, Any],
        actor: ActorContext | None,
    ) -> dict[str, Any]:
        handlers: dict[str, Callable[[Any], dict[str, Any]]] = {
            "sprintengine.init": cmd_init,
            "sprintengine.recover": cmd_recover,
            "sprintengine.roster.add": cmd_roster_add,
            "sprintengine.roster.list": cmd_roster_list,
            "sprintengine.join": cmd_join,
            "sprintengine.summary": cmd_summary,
            "sprintengine.task.next": cmd_task_next,
            "sprintengine.task.claim": cmd_task_claim,
            "sprintengine.task.status": cmd_task_status,
            "sprintengine.task.ready": cmd_task_ready,
            "sprintengine.task.log": cmd_task_log,
            "sprintengine.task.note": cmd_task_note,
            "sprintengine.task.comment": cmd_task_comment,
            "sprintengine.task.list": cmd_task_list,
            "sprintengine.plan.add_task": cmd_plan_add_task,
            "sprintengine.plan.update_task": cmd_plan_update_task,
            "sprintengine.plan.delete_task": cmd_plan_delete_task,
            "sprintengine.plan.add_dependency": cmd_plan_add_dependency,
            "sprintengine.plan.remove_dependency": cmd_plan_remove_dependency,
            "sprintengine.plan.start_review": cmd_plan_start_review,
            "sprintengine.plan.review_status": cmd_plan_review_status,
            "sprintengine.plan.address_reviews": cmd_plan_address_reviews,
            "sprintengine.artifact.add": cmd_artifact_add,
            "sprintengine.artifact.list": cmd_artifact_list,
            "sprintengine.artifact.ready": cmd_artifact_ready,
            "sprintengine.artifact.approve": cmd_artifact_approve,
            "sprintengine.artifact.request_changes": cmd_artifact_request_changes,
        }
        if tool_name == "sprintengine.feedback.summarize":
            state = load_state(state_path)
            return {"ok": True, "summary": analyze_feedback_metrics(state_path.parent, state)["summary"]}
        if tool_name == "sprintengine.feedback.recommend_actions":
            state = load_state(state_path)
            return {"ok": True, "recommendations": analyze_feedback_metrics(state_path.parent, state)["recommendations"]}
        handler = handlers[tool_name]
        args = self._namespace(tool_name, state_path, payload, actor)
        return handler(args)

    def _namespace(
        self,
        tool_name: str,
        state_path: Path,
        payload: dict[str, Any],
        actor: ActorContext | None,
    ) -> SimpleNamespace:
        base: dict[str, Any] = {"state": state_path}
        if tool_name == "sprintengine.init":
            base["goal"] = payload.get("goal")
            base["use_worktrees"] = bool(payload.get("useWorktrees", False))
            base["agent"] = list(payload.get("agent") or [])
        elif tool_name == "sprintengine.join":
            base.update(role=payload["role"], id=payload["id"])
        elif tool_name == "sprintengine.roster.add":
            base.update(role=payload["role"], id=payload["id"], actor=payload.get("actor") or (actor.id if actor else "architect"))
        elif tool_name == "sprintengine.roster.list":
            pass
        elif tool_name == "sprintengine.task.next":
            base.update(role=payload["role"], id=payload["id"])
        elif tool_name == "sprintengine.task.claim":
            base.update(task_id=payload["taskId"], id=payload["id"])
        elif tool_name == "sprintengine.task.status":
            base.update(task_id=payload["taskId"], status=payload["status"], id=payload["id"], summary=payload.get("summary"))
            base.update(
                needs_input_kind=payload.get("needsInputKind"),
                needs_input_reason=payload.get("needsInputReason"),
                needs_input_artifact_id=payload.get("needsInputArtifactId"),
                needs_input_question=payload.get("needsInputQuestion"),
                needs_input_suggested_resolution=payload.get("needsInputSuggestedResolution"),
            )
            _add_feedback_defaults(base, payload)
        elif tool_name == "sprintengine.task.ready":
            base.update(task_id=payload["taskId"], id=payload["id"], triaged_by=payload.get("triagedBy") or "user")
        elif tool_name == "sprintengine.task.log":
            base.update(
                task_id=payload["taskId"],
                id=payload["id"],
                summary=payload.get("summary"),
                file=list(payload.get("file") or []),
                command=list(payload.get("command") or []),
                result=list(payload.get("result") or []),
                scope_expansion_json=list(payload.get("scopeExpansionJson") or payload.get("scopeExpansion") or []),
            )
        elif tool_name == "sprintengine.task.note":
            base.update(task_id=payload["taskId"], id=payload["id"], note=payload["note"])
        elif tool_name == "sprintengine.task.comment":
            base.update(task_id=payload["taskId"], id=payload["id"], body=payload["body"], source=payload.get("source") or "user")
        elif tool_name == "sprintengine.task.list":
            base["role"] = payload.get("role")
        elif tool_name == "sprintengine.plan.add_task":
            base.update(
                actor=payload.get("actor") or (actor.id if actor else "architect"),
                task_id=payload.get("taskId"),
                title=payload["title"],
                description=payload.get("description", ""),
                role=payload["role"],
                depends_on=list(payload.get("dependsOn") or []),
                path=list(payload.get("path") or []),
                acceptance=list(payload.get("acceptance") or []),
                note=list(payload.get("note") or []),
                task_note=list(payload.get("taskNote") or []),
                manual_dispatch=bool(payload.get("manualDispatch", False)),
                dispatch_status=payload.get("dispatchStatus") or "todo",
                triaged_by=payload.get("triagedBy") or "none",
            )
        elif tool_name == "sprintengine.plan.update_task":
            base.update(
                actor=payload.get("actor") or (actor.id if actor else "architect"),
                task_id=payload["taskId"],
                title=payload.get("title"),
                description=payload.get("description"),
                clear_description=bool(payload.get("clearDescription", False)),
                role=payload.get("role"),
                path=payload.get("path"),
                clear_paths=bool(payload.get("clearPaths", False)),
                acceptance=payload.get("acceptance"),
                clear_acceptance=bool(payload.get("clearAcceptance", False)),
                note=payload.get("note"),
                clear_notes=bool(payload.get("clearNotes", False)),
                task_note=payload.get("taskNote"),
                clear_task_notes=bool(payload.get("clearTaskNotes", False)),
                force=bool(payload.get("force", False)),
            )
        elif tool_name == "sprintengine.plan.delete_task":
            base.update(
                actor=payload.get("actor") or (actor.id if actor else "architect"),
                task_id=payload["taskId"],
                unlink_dependents=bool(payload.get("unlinkDependents", False)),
                force=bool(payload.get("force", False)),
            )
        elif tool_name in {"sprintengine.plan.add_dependency", "sprintengine.plan.remove_dependency"}:
            base.update(
                actor=payload.get("actor") or (actor.id if actor else "architect"),
                task_id=payload["taskId"],
                depends_on=list(payload.get("dependsOn") or []),
                force=bool(payload.get("force", False)),
            )
        elif tool_name == "sprintengine.plan.start_review":
            base.update(role=payload["role"], id=payload["id"])
        elif tool_name == "sprintengine.plan.address_reviews":
            base["actor"] = payload.get("actor") or (actor.id if actor else "architect")
        elif tool_name == "sprintengine.artifact.add":
            base.update(
                actor=payload.get("actor") or (actor.id if actor else "agent"),
                artifact_id=payload.get("artifactId"),
                task_id=payload["taskId"],
                kind=payload["kind"],
                title=payload["title"],
                path=payload["path"],
                created_by=payload.get("createdBy"),
                recommended_task=list(payload.get("recommendedTask") or []),
                ready=bool(payload.get("ready", False)),
            )
        elif tool_name == "sprintengine.artifact.list":
            base.update(task_id=payload.get("taskId"), kind=payload.get("kind"), status=payload.get("status"))
        elif tool_name == "sprintengine.artifact.ready":
            base.update(artifact_id=payload["artifactId"], id=payload["id"])
            _add_feedback_defaults(base, payload)
        elif tool_name == "sprintengine.artifact.approve":
            base.update(artifact_id=payload["artifactId"], id=payload["id"])
        elif tool_name == "sprintengine.artifact.request_changes":
            base.update(artifact_id=payload["artifactId"], id=payload["id"], feedback=payload["feedback"])
        return SimpleNamespace(**base)

    def _state_path(self, payload: dict[str, Any], *, required: bool) -> Path | None:
        raw = payload.get("statePath")
        if not raw:
            if required:
                raise McpToolError("invalid_state_path", "statePath is required.")
            return None
        if not isinstance(raw, str):
            raise McpToolError("invalid_state_path", "statePath must be a string.")
        if _looks_like_foreign_platform_path(raw):
            raise McpToolError(
                "invalid_state_path",
                "statePath appears to mix Windows and POSIX path formats. Use the path format for this process.",
            )
        path = Path(raw).expanduser().resolve()
        if self.allowed_roots and not any(_is_relative_to(path, root) for root in self.allowed_roots):
            raise McpToolError("state_path_not_allowed", "statePath is outside the configured allowed roots.")
        return path

    def _actor(self, actor: ActorContext | dict[str, Any] | None) -> ActorContext | None:
        try:
            return ActorContext.from_value(actor)
        except AuthorizationError:
            raise
        except Exception as exc:
            raise McpToolError("invalid_actor", "Actor context is invalid.", {"errorClass": exc.__class__.__name__}) from exc

    def _audit(
        self,
        tool_name: str,
        state_path: Path | None,
        actor: ActorContext | None,
        payload: dict[str, Any],
        start: float,
        result: str,
        error: Exception | None,
    ) -> None:
        if state_path is None or tool_name not in MUTATING_TOOLS:
            return
        try:
            record_audit_event(
                state_path,
                operation_name=tool_name,
                actor=actor.id if actor else "anonymous",
                result=result,
                duration_ms=max(0, int((time.monotonic() - start) * 1000)),
                task_id=str(payload.get("taskId") or "") or None,
                artifact_id=str(payload.get("artifactId") or "") or None,
                backend_mode="mcp-local",
                error=error,
            )
        except Exception:
            pass


def call_tool(
    tool_name: str,
    payload: dict[str, Any] | None = None,
    actor: ActorContext | dict[str, Any] | None = None,
    allowed_roots: list[str | Path] | None = None,
) -> dict[str, Any]:
    return SprintEngineMcpServer(allowed_roots=allowed_roots).call_tool(tool_name, payload, actor)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Local-first sprintengine MCP server")
    parser.add_argument("--allowed-root", action="append", default=[], help="Workspace root allowed to contain Sprint Engine state paths.")
    args = parser.parse_args(argv)
    server = SprintEngineMcpServer(allowed_roots=args.allowed_root, stdio_actor=ActorContext.from_environment())
    for line in sys.stdin:
        if not line.strip():
            continue
        response = _handle_stdio_message(server, line)
        print(json.dumps(response, sort_keys=True), flush=True)
    return 0


def _handle_stdio_message(server: SprintEngineMcpServer, line: str) -> dict[str, Any]:
    try:
        message = json.loads(line)
    except json.JSONDecodeError as exc:
        return {"ok": False, "error": {"code": "invalid_json", "message": exc.msg}}
    request_id = message.get("id")
    method = message.get("method")
    if method == "initialize":
        params = message.get("params") or {}
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "protocolVersion": params.get("protocolVersion", "2024-11-05"),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "sprintengine-mcp", "version": "0.1.0"},
            },
        }
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": request_id, "result": {"tools": server.list_tools()}}
    if method == "tools/call":
        params = message.get("params") or {}
        result = server.call_tool(params.get("name", ""), params.get("arguments") or {}, server.stdio_actor)
        return {"jsonrpc": "2.0", "id": request_id, "result": result}
    if "tool" in message:
        return server.call_tool(message.get("tool", ""), message.get("payload") or {}, server.stdio_actor)
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": "method_not_found", "message": f"Unsupported method: {method}"}}


def _add_feedback_defaults(target: dict[str, Any], payload: dict[str, Any]) -> None:
    for attr, camel, _ in FEEDBACK_SCORE_FIELDS:
        target[attr] = payload.get(attr, payload.get(camel))
    target["top_friction"] = payload.get("topFriction", payload.get("top_friction", ""))
    target["suggested_improvement"] = payload.get("suggestedImprovement", payload.get("suggested_improvement", ""))
    target["issue_json"] = _json_list(payload.get("issueJson", payload.get("issue_json", [])))
    target["finding_json"] = _json_list(payload.get("findingJson", payload.get("finding_json", [])))


def _json_list(values: Any) -> list[str]:
    output = []
    for value in values or []:
        output.append(value if isinstance(value, str) else json.dumps(value))
    return output


def _looks_like_foreign_platform_path(raw: str) -> bool:
    if os.name != "nt" and re.match(r"^[A-Za-z]:[\\/]", raw):
        return True
    if os.name != "nt" and "\\" in raw:
        return True
    if os.name == "nt" and raw.startswith("/mnt/"):
        return True
    return False


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _system_exit_message(exc: SystemExit) -> str:
    if exc.code is None:
        return "SprintEngine core exited."
    return str(exc.code)


if __name__ == "__main__":
    raise SystemExit(main())
