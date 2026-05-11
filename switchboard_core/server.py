from __future__ import annotations

import base64
import json
import os
import queue as _queue
import secrets
import signal
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from . import pty_session
from .pty_session import get_registry
from .store import (
    acquire_runner_process_lock,
    append_runner_event,
    atomic_write_json,
    now_iso,
    read_runner_state,
    runner_public_payload,
    runner_pause,
    runner_resume,
    runner_start,
    runner_status,
    runner_stop,
    runner_tick,
    runner_run_loop,
    execution_logs,
    execution_stop,
    execution_status,
    execution_worktree_cleanup,
    switchboard_root,
)
from .watchtower_runner import start_watchtower_review, start_watchtower_triage

SERVER_API_VERSION = 2

SSE_KEEPALIVE_SECONDS = 15.0

SIGNAL_MAP: dict[str, int] = {}
for _sig_name in ("TERM", "INT", "KILL", "HUP", "QUIT"):
    _resolved = getattr(signal, f"SIG{_sig_name}", None)
    if _resolved is not None:
        SIGNAL_MAP[_sig_name] = int(_resolved)


class SwitchboardServer(ThreadingHTTPServer):
    def __init__(
        self,
        server_address: tuple[str, int],
        handler: type[BaseHTTPRequestHandler],
        workspace: Path,
        token: str,
        started_at: str,
        stop_event: threading.Event,
    ):
        super().__init__(server_address, handler)
        self.workspace = workspace
        self.token = token
        self.started_at = started_at
        self.stop_event = stop_event


def serve(workspace: Path) -> dict[str, Any]:
    root = switchboard_root(workspace)
    server_path = root / "runner" / "server.json"
    runner_lock = acquire_runner_process_lock(workspace)
    pty_session.enable_pty_mode()
    if not pty_session.pty_mode_enabled():
        append_runner_event(
            workspace,
            "warning",
            message=(
                "Live attach is disabled: ptyprocess is not installed. "
                "Run `.venv/bin/pip install -r requirements.txt` to enable it."
            ),
        )

    try:
        # We hold the singleton; any leftover descriptor is from a crashed
        # process. Clear it so clients don't try to attach to a dead server.
        if read_descriptor(server_path) is not None:
            try:
                server_path.unlink(missing_ok=True)
            except OSError:
                pass

        token = secrets.token_urlsafe(24)
        started_at = now_iso()
        stop_event = threading.Event()
        server = SwitchboardServer(("127.0.0.1", 0), SwitchboardRequestHandler, workspace, token, started_at, stop_event)
        descriptor = {
            "schemaVersion": 1,
            "transport": "http",
            "host": "127.0.0.1",
            "port": server.server_port,
            "pid": os.getpid(),
            "token": token,
            "startedAt": started_at,
        }
        (root / "runner").mkdir(parents=True, exist_ok=True)
        atomic_write_json(server_path, descriptor)
        supervisor = threading.Thread(target=runner_run_loop, kwargs={"workspace": workspace, "stop_event": stop_event}, daemon=True)
        supervisor.start()
        try:
            server.serve_forever()
        finally:
            stop_event.set()
            remove_descriptor_if_current(server_path, os.getpid())
        return {"ok": True, "server": descriptor}
    finally:
        runner_lock.release()


def read_descriptor(path: Path) -> dict[str, Any] | None:
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
        return parsed if isinstance(parsed, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def remove_descriptor_if_current(path: Path, pid: int) -> None:
    descriptor = read_descriptor(path)
    if descriptor and descriptor.get("pid") == pid:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass


class SwitchboardRequestHandler(BaseHTTPRequestHandler):
    server: SwitchboardServer

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if (
            parsed.path != "/health"
            and not parsed.path.startswith("/execution/")
            and parsed.path != "/sessions"
        ):
            self.respond({"ok": False, "message": "Not found."}, status=404)
            return
        if not self.authorized():
            self.respond({"ok": False, "message": "Unauthorized."}, status=401)
            return
        if parsed.path == "/sessions":
            sessions = [s.snapshot() for s in get_registry().all_sessions()]
            self.respond({"ok": True, "sessions": sessions})
            return
        if parsed.path.startswith("/execution/"):
            parts = parsed.path.strip("/").split("/")
            if len(parts) == 3 and parts[2] == "status":
                self.respond_or_error(lambda: execution_status(self.server.workspace, parts[1]))
                return
            if len(parts) == 3 and parts[2] == "logs":
                query = urllib.parse.parse_qs(parsed.query)
                stream = query.get("stream", ["stdout"])[0]
                tail_text = query.get("tail", ["200"])[0]
                try:
                    tail = int(tail_text)
                except ValueError:
                    tail = 200
                self.respond_or_error(lambda: execution_logs(self.server.workspace, parts[1], stream=stream, tail=tail))
                return
            if len(parts) == 3 and parts[2] == "stream":
                self.handle_session_stream(parts[1])
                return
            self.respond({"ok": False, "message": "Not found."}, status=404)
            return
        self.respond(
            {
                "ok": True,
                "status": "healthy",
                "apiVersion": SERVER_API_VERSION,
                "serverPid": os.getpid(),
                "startedAt": self.server.started_at,
                "supervisorRunning": not self.server.stop_event.is_set(),
                "runner": runner_public_payload(read_runner_state(self.server.workspace)),
            }
        )

    def do_POST(self) -> None:
        if not self.authorized():
            self.respond({"ok": False, "message": "Unauthorized."}, status=401)
            return
        parsed = urllib.parse.urlparse(self.path)
        payload = self.read_payload()
        if parsed.path.startswith("/execution/"):
            parts = parsed.path.strip("/").split("/")
            if len(parts) == 3 and parts[2] == "cleanup-worktree":
                self.respond_or_error(lambda: execution_worktree_cleanup(self.server.workspace, parts[1], force=payload.get("force") is True))
                return
            if len(parts) == 3 and parts[2] == "stop":
                self.respond_or_error(lambda: execution_stop(self.server.workspace, parts[1], reason=payload.get("reason") if isinstance(payload.get("reason"), str) else None))
                return
            if len(parts) == 3 and parts[2] == "write":
                self.respond(self.handle_session_write(parts[1], payload))
                return
            if len(parts) == 3 and parts[2] == "resize":
                self.respond(self.handle_session_resize(parts[1], payload))
                return
            if len(parts) == 3 and parts[2] == "signal":
                self.respond(self.handle_session_signal(parts[1], payload))
                return
            self.respond({"ok": False, "message": "Not found."}, status=404)
            return
        if parsed.path == "/runner/start":
            self.respond(
                runner_start(
                    self.server.workspace,
                    provider=payload.get("provider", "local-process"),
                    cli=payload.get("cli", "codex"),
                    queues=payload.get("queues") if isinstance(payload.get("queues"), list) else None,
                    max_concurrency=payload.get("maxConcurrency", 1),
                )
            )
            return
        if parsed.path == "/runner/pause":
            self.respond(runner_pause(self.server.workspace))
            return
        if parsed.path == "/runner/resume":
            self.respond(runner_resume(self.server.workspace))
            return
        if parsed.path == "/runner/stop":
            response = runner_stop(self.server.workspace)
            self.respond(response)
            self.server.stop_event.set()
            grace = payload.get("graceSeconds") if isinstance(payload.get("graceSeconds"), (int, float)) else 3.0

            def _shutdown() -> None:
                try:
                    get_registry().shutdown_all(grace_seconds=float(grace))
                finally:
                    self.server.shutdown()

            threading.Thread(target=_shutdown, daemon=True).start()
            return
        if parsed.path == "/runner/tick":
            self.respond(runner_tick(self.server.workspace))
            return
        if parsed.path == "/runner/status":
            self.respond(runner_status(self.server.workspace))
            return
        if parsed.path == "/watchtower/start-review":
            preset = payload.get("preset")
            self.respond_or_error(lambda: start_watchtower_review(self.server.workspace, preset=preset if isinstance(preset, str) else "lean_code_review"))
            return
        if parsed.path == "/watchtower/start-triage":
            scope = payload.get("scope")
            task_id = payload.get("taskId")
            self.respond_or_error(
                lambda: start_watchtower_triage(
                    self.server.workspace,
                    scope=scope if isinstance(scope, str) else "all",
                    task_id=task_id if isinstance(task_id, str) else None,
                )
            )
            return
        self.respond({"ok": False, "message": "Not found."}, status=404)

    def authorized(self) -> bool:
        return self.headers.get("Authorization") == f"Bearer {self.server.token}"

    def read_payload(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or "0")
        if length <= 0:
            return {}
        parsed = json.loads(self.rfile.read(length).decode("utf-8"))
        return parsed if isinstance(parsed, dict) else {}

    def respond(self, payload: dict[str, Any], *, status: int = 200) -> None:
        body = json.dumps(payload, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def respond_or_error(self, fn: Any) -> None:
        try:
            self.respond(fn())
        except Exception as exc:
            self.respond({"ok": False, "message": str(exc)}, status=400)

    def handle_session_write(self, execution_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        session = get_registry().get(execution_id)
        if not session:
            return {"ok": False, "message": "Session not found."}
        data = payload.get("data")
        if not isinstance(data, str):
            return {"ok": False, "message": "Missing base64 'data'."}
        try:
            raw = base64.b64decode(data, validate=True)
        except Exception as exc:
            return {"ok": False, "message": f"Invalid base64: {exc}"}
        session.write(raw)
        return {"ok": True}

    def handle_session_resize(self, execution_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        session = get_registry().get(execution_id)
        if not session:
            return {"ok": False, "message": "Session not found."}
        cols = payload.get("cols")
        rows = payload.get("rows")
        if not isinstance(cols, int) or not isinstance(rows, int) or cols <= 0 or rows <= 0:
            return {"ok": False, "message": "Positive integer cols and rows are required."}
        session.resize(cols, rows)
        return {"ok": True}

    def handle_session_signal(self, execution_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        session = get_registry().get(execution_id)
        if not session:
            return {"ok": False, "message": "Session not found."}
        name = payload.get("signal", "TERM")
        if not isinstance(name, str):
            return {"ok": False, "message": "Invalid signal."}
        sig = SIGNAL_MAP.get(name.upper())
        if sig is None:
            return {"ok": False, "message": f"Unknown signal: {name}"}
        session.send_signal(int(sig))
        return {"ok": True}

    def handle_session_stream(self, execution_id: str) -> None:
        session = get_registry().get(execution_id)
        if not session:
            self.respond({"ok": False, "message": "Session not found."}, status=404)
            return

        events: _queue.Queue[tuple[str, bytes | None]] = _queue.Queue()

        def on_event(name: str, data: bytes | None) -> None:
            events.put((name, data))

        replay, already_closed, unsubscribe = session.attach(on_event)

        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
        except OSError:
            unsubscribe()
            return

        try:
            if replay:
                if not self._sse_write("replay", base64.b64encode(replay).decode("ascii")):
                    return
            if already_closed:
                self._sse_write(
                    "exit",
                    json.dumps({"exitCode": session.exit_code, "exitedAt": session.exited_at}),
                )
                return

            while True:
                try:
                    name, data = events.get(timeout=SSE_KEEPALIVE_SECONDS)
                except _queue.Empty:
                    try:
                        self.wfile.write(b": keepalive\n\n")
                        self.wfile.flush()
                    except OSError:
                        return
                    continue
                if name == "data" and data is not None:
                    if not self._sse_write("data", base64.b64encode(data).decode("ascii")):
                        return
                elif name == "exit":
                    self._sse_write(
                        "exit",
                        json.dumps({"exitCode": session.exit_code, "exitedAt": session.exited_at}),
                    )
                    return
        finally:
            unsubscribe()

    def _sse_write(self, event_name: str, data_str: str) -> bool:
        body = f"event: {event_name}\ndata: {data_str}\n\n".encode("utf-8")
        try:
            self.wfile.write(body)
            self.wfile.flush()
            return True
        except OSError:
            return False
