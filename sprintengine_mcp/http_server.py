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
from .protocol import LEGACY_HTTP_ASSUMED_VERSION, is_supported_protocol_version
from .server import McpRequestContext, SprintEngineMcpServer, _handle_jsonrpc_message

SESSION_HEADER = "Mcp-Session-Id"
PROTOCOL_VERSION_HEADER = "MCP-Protocol-Version"
METHOD_HEADER = "Mcp-Method"
NAME_HEADER = "Mcp-Name"
MULTICODE_RUN_HEADER = "X-Multicode-Run-Id"

# The revision that removed the handshake and the session id (SEP-2575, SEP-2567)
# and made the routing headers mandatory (SEP-2243). Declaring it is what obliges
# a request to carry `Mcp-Method` (and `Mcp-Name` where the method names a target);
# below it the headers stay optional, and are still validated when sent.
STATELESS_PROTOCOL_VERSION = "2026-07-28"

# Methods that name their target in `params.name`, and therefore carry `Mcp-Name`.
NAMED_TARGET_METHODS = frozenset({"tools/call"})


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
        # The declared repo this session was spawned into (MC-1610), derived by
        # the launcher from the session's worktree cwd. It binds the session's
        # work queue to one tree the same way `role` binds its tool surface: a
        # session sitting in the mobile worktree must not claim desktop work.
        # Absent (single-repo runs, older callers, operator surface) leaves the
        # session unbound, which is exactly the pre-multi-repo behavior.
        agent_repo = str(payload.get("repo") or "").strip()
        # The one task this session may work (MC-2136), derived by the launcher
        # from the task worktree it spawned the session into. Binds the claim
        # queue to that task the same way `repo` binds it to a tree: a session
        # sitting in T4's worktree must not end up owning T7, whose work would
        # then be committed from a tree that never saw it.
        agent_task = str(payload.get("taskId") or "").strip()
        # Compose-time gate for the workspace_knowledge layer skill. Tri-state:
        # key absent (older caller) -> None -> the server falls back to its env;
        # key present -> truthiness of the workspace's configured knowledge root.
        knowledge_root_configured: bool | None = None
        if "knowledgeRoot" in payload:
            knowledge_root_configured = bool(str(payload.get("knowledgeRoot") or "").strip())
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
            repo=agent_repo,
            task_id=agent_task,
            knowledge_root_configured=knowledge_root_configured,
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
        session = HttpMcpSession(id=session_id, run_token=run.token, actor=self.actor_for(run), context=run.context)
        self._sessions[session_id] = session
        return session

    def actor_for(self, run: HttpMcpRegisteredRun) -> ActorContext | None:
        """The actor a request on this run speaks as, with or without a session.

        A session copies exactly this (see `create`) and nothing else that is not
        already on the run, which is why a session-less request can resolve the
        same identity straight off the bearer run token.
        """
        return run.context.actor or self._actor

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
        run = self.server.runs.get_run(run_token)
        if run is None:
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

        # The request contract, in order (item 2141): auth (above) -> declared version ->
        # routing headers -> context. Everything below the auth check is per-request, so a
        # client that never handshakes is answered exactly like one that did.
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        declared_version = self._declared_protocol_version(params)
        if not is_supported_protocol_version(declared_version):
            # Not a downgrade: over HTTP the client has already committed to this
            # version for this request, so answering it as if we agreed would be
            # the version lie this work exists to remove.
            self._write_json(
                HTTPStatus.BAD_REQUEST,
                {"error": "unsupported_protocol_version", "message": f"This server does not serve MCP protocol version {declared_version!r}."},
            )
            return
        header_error = self._routing_header_error(message, params, declared_version)
        if header_error is not None:
            self._write_json(HTTPStatus.BAD_REQUEST, header_error)
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

        session_header = self.headers.get(SESSION_HEADER)
        if session_header:
            session = self.server.runs.get(session_header, run_token)
            if session is None:
                # A session id we do not know, or one belonging to another run, is a
                # client bug. Quietly serving it at run scope instead would be the
                # swallowed-error pattern: the caller believes it is talking to a
                # session that no longer exists.
                self._write_json(
                    HTTPStatus.BAD_REQUEST,
                    {
                        "jsonrpc": "2.0",
                        "id": message.get("id"),
                        "error": {"code": "invalid_session", "message": f"{SESSION_HEADER} is not a live session for this run."},
                    },
                )
                return
            actor, context, session_id = session.actor, session.context, session.id
        else:
            # Session-less (2026-07-28): the bearer run token already carries the
            # actor and `McpRequestContext` a session would only have copied from it,
            # so there is nothing a handshake would have established. The response
            # carries no session header, because no session was created.
            actor, context, session_id = self.server.runs.actor_for(run), run.context, None

        response = _handle_jsonrpc_message(self.server.mcp_server, message, actor, context=context)
        if response is None:
            self._write_empty(HTTPStatus.ACCEPTED, session_id)
            return
        self._write_json(HTTPStatus.OK, response, session_id)

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

    def _declared_protocol_version(self, params: dict[str, Any]) -> object:
        """What version this request says it speaks.

        Header first, then `params._meta.protocolVersion`, then the spec's rule for
        a request that declares nothing. A present but malformed declaration is
        returned as-is rather than treated as absent, so it fails the supported
        check instead of being silently read as the legacy assumption.
        """
        header = self.headers.get(PROTOCOL_VERSION_HEADER)
        if header is not None and header.strip():
            return header.strip()
        meta = params.get("_meta")
        if isinstance(meta, dict) and "protocolVersion" in meta:
            declared = meta.get("protocolVersion")
            return declared.strip() if isinstance(declared, str) else declared
        return LEGACY_HTTP_ASSUMED_VERSION

    def _routing_header_error(self, message: dict[str, Any], params: dict[str, Any], declared_version: object) -> dict[str, Any] | None:
        """Validate `Mcp-Method`/`Mcp-Name` against the body (SEP-2243).

        Sent, they must agree with the body — a proxy routing on the header while
        the server executes the body is the failure these headers exist to make
        impossible. Required only once the request declares the version that made
        them mandatory; `Mcp-Name` only where the method names a target.
        """
        method = message.get("method")
        required = declared_version == STATELESS_PROTOCOL_VERSION
        declared_method = (self.headers.get(METHOD_HEADER) or "").strip()
        if not declared_method:
            if required:
                return {"error": "missing_required_header", "message": f"{METHOD_HEADER} is required at MCP protocol version {STATELESS_PROTOCOL_VERSION}."}
        elif declared_method != method:
            return {"error": "header_body_mismatch", "message": f"{METHOD_HEADER} {declared_method!r} does not match the request method {method!r}."}
        declared_name = (self.headers.get(NAME_HEADER) or "").strip()
        if not declared_name:
            if required and method in NAMED_TARGET_METHODS:
                return {"error": "missing_required_header", "message": f"{NAME_HEADER} is required on {method} at MCP protocol version {STATELESS_PROTOCOL_VERSION}."}
        elif declared_name != params.get("name"):
            return {"error": "header_body_mismatch", "message": f"{NAME_HEADER} {declared_name!r} does not match the request target {params.get('name')!r}."}
        return None

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
