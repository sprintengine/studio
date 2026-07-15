"""Authentication policy for sprintengine MCP tools."""

from __future__ import annotations

from dataclasses import dataclass
from os import environ
from typing import Any

AUDITED_TOOLS = {
    "sprintengine.handover",
    "sprintengine.init",
    "sprintengine.recover",
    "sprintengine.roster.configure",
    "sprintengine.agent.join",
    "sprintengine.agent.next_directive",
    "sprintengine.agent.heartbeat",
    "sprintengine.agent.leave",
    "sprintengine.subscribe",
    "sprintengine.join",
    "sprintengine.dispatch.ack",
    "sprintengine.triage.needs_input",
    "sprintengine.task.next",
    "sprintengine.task.claim",
    "sprintengine.task.status",
    "sprintengine.task.resolve_input",
    "sprintengine.task.release",
    "sprintengine.task.log",
    "sprintengine.task.publish",
    "sprintengine.task.note",
    "sprintengine.task.comment",
    "sprintengine.task.advance",
    "sprintengine.plan.add_task",
    "sprintengine.plan.update_task",
    "sprintengine.plan.delete_task",
    "sprintengine.plan.add_dependency",
    "sprintengine.plan.remove_dependency",
    "sprintengine.plan.start_review",
    "sprintengine.artifact.add",
    "sprintengine.artifact.ready",
    "sprintengine.artifact.approve",
    "sprintengine.artifact.request_changes",
}

MUTATING_TOOLS = AUDITED_TOOLS

MCP_USER_ID_ENV = "SPRINTENGINE_MCP_USER_ID"
MCP_USER_AUTHORIZED_ENV = "SPRINTENGINE_MCP_USER_AUTHORIZED"


@dataclass(frozen=True)
class ActorContext:
    """Authenticated user identity passed by the local MCP client."""

    id: str
    role: str = ""
    authenticated: bool = True
    mcp_authorized: bool = True

    @classmethod
    def from_value(cls, value: Any) -> "ActorContext | None":
        if value is None:
            return None
        if isinstance(value, cls):
            return value
        if not isinstance(value, dict):
            raise AuthorizationError("Actor context must be an object.")
        actor_id = str(value.get("id") or "").strip()
        role = str(value.get("role") or "").strip()
        authenticated = _optional_bool(value, "authenticated", default=True)
        mcp_authorized = _optional_bool(value, "mcpAuthorized", "mcp_authorized", default=True)
        if not actor_id:
            raise AuthorizationError("Actor context is missing id.")
        return cls(id=actor_id, role=role, authenticated=authenticated, mcp_authorized=mcp_authorized)

    @classmethod
    def from_environment(cls, values: dict[str, str] | None = None) -> "ActorContext | None":
        source = environ if values is None else values
        actor_id = str(source.get(MCP_USER_ID_ENV) or "").strip()
        if not actor_id:
            return None
        if not _truthy(source.get(MCP_USER_AUTHORIZED_ENV)):
            return None
        return cls(id=actor_id, role="user", authenticated=True, mcp_authorized=True)


class AuthorizationError(PermissionError):
    """Raised when an MCP actor is not allowed to perform an operation."""


def require_mcp_user(tool_name: str, actor: ActorContext | None) -> ActorContext:
    if actor is None:
        raise AuthorizationError(f"{tool_name} requires authenticated actor context.")
    if not actor.authenticated:
        raise AuthorizationError(f"{tool_name} requires authenticated actor context.")
    if not actor.mcp_authorized:
        raise AuthorizationError(f"{tool_name} requires MCP-authorized actor context.")
    return actor


def authorize_tool(tool_name: str, payload: dict[str, Any], actor: ActorContext | None, state_path) -> None:
    del payload, state_path
    require_mcp_user(tool_name, actor)


def _optional_bool(value: dict[str, Any], *keys: str, default: bool) -> bool:
    for key in keys:
        if key not in value:
            continue
        candidate = value[key]
        if isinstance(candidate, bool):
            return candidate
        raise AuthorizationError(f"Actor context field {key} must be a boolean.")
    return default


def _truthy(value: str | None) -> bool:
    if value is None:
        return False
    return value.strip().lower() in {"1", "true", "yes", "on"}
