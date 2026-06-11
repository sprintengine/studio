"""Streamable HTTP transport for the local Sprint Engine MCP boundary."""

from __future__ import annotations

import json
import secrets
import sys
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from .auth import ActorContext
from .server import McpRequestContext, SprintEngineMcpServer, _handle_jsonrpc_message

SESSION_HEADER = "Mcp-Session-Id"
PROTOCOL_VERSION_HEADER = "MCP-Protocol-Version"
MULTICODE_RUN_HEADER = "X-Multicode-Run-Id"


@dataclass(frozen=True)
class HttpMcpSession:
    id: str
    run_token: str
    actor: ActorContext | None
    context: McpRequestContext | None = None


@dataclass(frozen=True)
class HttpMcpRegisteredRun:
    id: str
    token: str
    context: McpRequestContext


class HttpMcpRunRegistry:
    def __init__(self, actor: ActorContext | None):
        self._actor = actor
        self._sessions: dict[str, HttpMcpSession] = {}
        self._runs_by_id: dict[str, HttpMcpRegisteredRun] = {}
        self._runs_by_token: dict[str, HttpMcpRegisteredRun] = {}

    def register(self, payload: dict[str, Any]) -> HttpMcpRegisteredRun:
        run_id = _required_string(payload, "runId")
        existing = self._runs_by_id.get(run_id)
        if existing is not None:
            return existing
        workspace_root = _path_field(payload, "workspaceRoot")
        state_path = _path_field(payload, "statePath")
        allowed_roots = tuple(_path_value(root, "allowedRoots") for root in _required_string_list(payload, "allowedRoots"))
        if not allowed_roots:
            raise ValueError("allowedRoots must not be empty.")
        if not any(_is_relative_to(workspace_root, root) for root in allowed_roots):
            raise ValueError("workspaceRoot is outside allowedRoots.")
        if not any(_is_relative_to(state_path, root) for root in allowed_roots):
            raise ValueError("statePath is outside allowedRoots.")
        if not _is_relative_to(state_path, workspace_root):
            raise ValueError("statePath must be inside workspaceRoot.")
        actor_id = _required_string(payload, "actorId")
        actor = ActorContext(id=actor_id, role="user", authenticated=True, mcp_authorized=True)
        registry_roots = tuple(_registry_root(value) for value in payload.get("registryRoots") or [])
        user_root = _optional_path_field(payload, "userRoot")
        # Agent-scoped registrations bind the session token to one agent's
        # role and id: `tools/list` filters to that role's capability surface
        # and out-of-surface calls fail with tool_not_permitted_for_role.
        # Registrations without agentId/role stay run-scoped (operator
        # surface), which keeps older app builds working.
        agent_id = str(payload.get("agentId") or "").strip()
        agent_role = str(payload.get("role") or "").strip()
        context = McpRequestContext(
            actor=actor,
            state_path=state_path,
            workspace_root=workspace_root,
            allowed_roots=allowed_roots,
            plugin_registry_roots=registry_roots,
            user_root=user_root,
            actor_id=actor_id,
            agent_id=agent_id,
            role=agent_role,
        )
        token = secrets.token_urlsafe(32)
        run = HttpMcpRegisteredRun(id=run_id, token=token, context=context)
        self._runs_by_id[run_id] = run
        self._runs_by_token[token] = run
        return run

    def create(self, run_token: str | None) -> HttpMcpSession:
        run = self.get_run(run_token)
        if run is None:
            raise KeyError("registered run token is required.")
        session_id = secrets.token_urlsafe(24)
        session = HttpMcpSession(id=session_id, run_token=run.token, actor=run.context.actor or self._actor, context=run.context)
        self._sessions[session_id] = session
        return session

    def get_run(self, run_token: str | None) -> HttpMcpRegisteredRun | None:
        if not run_token:
            return None
        return self._runs_by_token.get(run_token)

    def get(self, session_id: str | None, run_token: str | None) -> HttpMcpSession | None:
        if not session_id:
            return None
        session = self._sessions.get(session_id)
        if session is None:
            return None
        if not run_token or not secrets.compare_digest(session.run_token, run_token):
            return None
        return session

    def delete_session(self, session_id: str | None, run_token: str | None) -> bool:
        session = self.get(session_id, run_token)
        if session is None:
            return False
        self._sessions.pop(session.id, None)
        return True

    def delete_run(self, run_id: str | None) -> bool:
        if not run_id:
            return False
        run = self._runs_by_id.pop(run_id, None)
        if run is None:
            return False
        self._runs_by_token.pop(run.token, None)
        stale_protocol_sessions = [key for key, session in self._sessions.items() if session.run_token == run.token]
        for key in stale_protocol_sessions:
            self._sessions.pop(key, None)
        return True


class SprintEngineHttpMcpServer(ThreadingHTTPServer):
    def __init__(
        self,
        server_address: tuple[str, int],
        mcp_server: SprintEngineMcpServer,
        *,
        actor: ActorContext | None,
        auth_token: str,
    ):
        if not auth_token:
            raise ValueError("HTTP MCP mode requires an app admin token.")
        super().__init__(server_address, SprintEngineHttpMcpRequestHandler)
        self.mcp_server = mcp_server
        self.admin_token = auth_token
        self.runs = HttpMcpRunRegistry(actor)


class SprintEngineHttpMcpRequestHandler(BaseHTTPRequestHandler):
    server: SprintEngineHttpMcpServer

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0]
        if path in {"/mcp/runs", "/mcp/sessions"}:
            self._handle_register_run()
            return
        if path != "/mcp":
            self._write_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return
        if not self._local_origin_allowed():
            self._write_json(HTTPStatus.FORBIDDEN, {"error": "origin_not_allowed"})
            return
        run_token = self._bearer_token()
        if self.server.runs.get_run(run_token) is None:
            self._write_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            self._write_json(HTTPStatus.BAD_REQUEST, {"error": "invalid_content_length"})
            return
        try:
            raw = self.rfile.read(length).decode("utf-8")
            message = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._write_json(HTTPStatus.BAD_REQUEST, {"error": "invalid_json"})
            return
        if not isinstance(message, dict):
            self._write_json(HTTPStatus.BAD_REQUEST, {"error": "invalid_jsonrpc_message"})
            return

        method = message.get("method")
        if method == "initialize":
            try:
                session = self.server.runs.create(run_token)
            except KeyError:
                self._write_json(
                    HTTPStatus.BAD_REQUEST,
                    {
                        "jsonrpc": "2.0",
                        "id": message.get("id"),
                        "error": {"code": "invalid_run", "message": "A registered Sprint Engine run token is required."},
                    },
                )
                return
            response = _handle_jsonrpc_message(self.server.mcp_server, message, session.actor, context=session.context)
            if response is None:
                self._write_empty(HTTPStatus.ACCEPTED, session.id)
            else:
                self._write_json(HTTPStatus.OK, response, session.id)
            return

        session = self.server.runs.get(self.headers.get(SESSION_HEADER), run_token)
        if session is None:
            self._write_json(
                HTTPStatus.BAD_REQUEST,
                {
                    "jsonrpc": "2.0",
                    "id": message.get("id"),
                    "error": {"code": "invalid_session", "message": f"{SESSION_HEADER} is required."},
                },
            )
            return

        response = _handle_jsonrpc_message(self.server.mcp_server, message, session.actor, context=session.context)
        if response is None:
            self._write_empty(HTTPStatus.ACCEPTED, session.id)
            return
        self._write_json(HTTPStatus.OK, response, session.id)

    def do_GET(self) -> None:
        if self.path.split("?", 1)[0] != "/mcp":
            self._write_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return
        if not self._local_origin_allowed():
            self._write_json(HTTPStatus.FORBIDDEN, {"error": "origin_not_allowed"})
            return
        if self.server.runs.get_run(self._bearer_token()) is None:
            self._write_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return
        self._write_json(HTTPStatus.METHOD_NOT_ALLOWED, {"error": "sse_not_supported"})

    def do_DELETE(self) -> None:
        path = self.path.split("?", 1)[0]
        if path not in {"/mcp", "/mcp/runs", "/mcp/sessions"}:
            self._write_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return
        if not self._local_origin_allowed():
            self._write_json(HTTPStatus.FORBIDDEN, {"error": "origin_not_allowed"})
            return
        if path in {"/mcp/runs", "/mcp/sessions"}:
            if not self._admin_authorized():
                self._write_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
                return
            deleted = self.server.runs.delete_run(self.headers.get(MULTICODE_RUN_HEADER))
            self._write_json(HTTPStatus.OK if deleted else HTTPStatus.NOT_FOUND, {"deleted": deleted})
            return
        run_token = self._bearer_token()
        if self.server.runs.get_run(run_token) is None:
            self._write_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return
        deleted = self.server.runs.delete_session(self.headers.get(SESSION_HEADER), run_token)
        self._write_json(HTTPStatus.OK if deleted else HTTPStatus.NOT_FOUND, {"deleted": deleted})

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _bearer_token(self) -> str:
        header = self.headers.get("Authorization") or ""
        prefix = "Bearer "
        return header[len(prefix):] if header.startswith(prefix) else ""

    def _admin_authorized(self) -> bool:
        return secrets.compare_digest(self._bearer_token(), self.server.admin_token)

    def _handle_register_run(self) -> None:
        if not self._local_origin_allowed():
            self._write_json(HTTPStatus.FORBIDDEN, {"error": "origin_not_allowed"})
            return
        if not self._admin_authorized():
            self._write_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            self._write_json(HTTPStatus.BAD_REQUEST, {"error": "invalid_content_length"})
            return
        try:
            raw = self.rfile.read(length).decode("utf-8")
            payload = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._write_json(HTTPStatus.BAD_REQUEST, {"error": "invalid_json"})
            return
        if not isinstance(payload, dict):
            self._write_json(HTTPStatus.BAD_REQUEST, {"error": "invalid_run_registration"})
            return
        try:
            run = self.server.runs.register(payload)
        except ValueError as exc:
            self._write_json(HTTPStatus.BAD_REQUEST, {"error": "invalid_run_registration", "message": str(exc)})
            return
        self._write_json(HTTPStatus.OK, {"runId": run.id, "runToken": run.token})

    def _local_origin_allowed(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True
        try:
            parsed = urlparse(origin)
        except ValueError:
            return False
        return parsed.hostname in {"127.0.0.1", "localhost", "::1"}

    def _write_empty(self, status: HTTPStatus, session_id: str | None = None) -> None:
        self.send_response(int(status))
        if session_id:
            self.send_header(SESSION_HEADER, session_id)
        self.end_headers()

    def _write_json(self, status: HTTPStatus, payload: dict[str, Any], session_id: str | None = None) -> None:
        body = json.dumps(payload, sort_keys=True).encode("utf-8")
        self.send_response(int(status))
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if session_id:
            self.send_header(SESSION_HEADER, session_id)
        self.end_headers()
        self.wfile.write(body)


def serve_http(
    mcp_server: SprintEngineMcpServer,
    *,
    host: str,
    port: int,
    actor: ActorContext | None,
    auth_token: str | None,
) -> int:
    if not auth_token:
        print("SprintEngine HTTP MCP mode requires --auth-token or SPRINTENGINE_MCP_HTTP_TOKEN.", file=sys.stderr)
        return 2
    if host != "127.0.0.1":
        print("SprintEngine HTTP MCP mode only supports host 127.0.0.1.", file=sys.stderr)
        return 2
    httpd = SprintEngineHttpMcpServer((host, port), mcp_server, actor=actor, auth_token=auth_token)
    actual_host, actual_port = httpd.server_address
    print(json.dumps({"transport": "http", "host": actual_host, "port": actual_port, "path": "/mcp"}), file=sys.stderr, flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


def _required_string(payload: dict[str, Any], field: str) -> str:
    value = payload.get(field)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-empty string.")
    return value.strip()


def _required_string_list(payload: dict[str, Any], field: str) -> list[str]:
    value = payload.get(field)
    if not isinstance(value, list) or not all(isinstance(item, str) and item.strip() for item in value):
        raise ValueError(f"{field} must be a non-empty string array.")
    return [item.strip() for item in value]


def _path_field(payload: dict[str, Any], field: str) -> Path:
    return _path_value(_required_string(payload, field), field)


def _optional_path_field(payload: dict[str, Any], field: str) -> Path | None:
    value = payload.get(field)
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a string.")
    return _path_value(value, field)


def _path_value(value: str, field: str) -> Path:
    if _looks_like_foreign_platform_path(value):
        raise ValueError(f"{field} appears to mix Windows and POSIX path formats.")
    return Path(value).expanduser().resolve()


def _registry_root(value: Any) -> dict[str, str] | str:
    if isinstance(value, str):
        return str(_path_value(value, "registryRoots"))
    if isinstance(value, dict):
        root = value.get("root") or value.get("path")
        if not isinstance(root, str):
            raise ValueError("registryRoots entries must contain a root string.")
        entry = {"root": str(_path_value(root, "registryRoots"))}
        plugin_id = value.get("id") or value.get("pluginId") or value.get("plugin_id")
        if isinstance(plugin_id, str) and plugin_id.strip():
            entry["id"] = plugin_id.strip()
        return entry
    raise ValueError("registryRoots entries must be strings or objects.")


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _looks_like_foreign_platform_path(raw: str) -> bool:
    if sys.platform == "win32":
        return raw.startswith("/")
    return bool(len(raw) >= 3 and raw[1] == ":" and raw[2] in {"\\", "/"})
