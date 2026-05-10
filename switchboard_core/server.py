from __future__ import annotations

import json
import os
import secrets
import threading
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from .store import (
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
    SwitchboardError,
)

SERVER_LOCK_STALE_SECONDS = 5 * 60


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
    server_lock = acquire_server_lock(root)

    try:
        stale_descriptor = read_descriptor(server_path)
        if stale_descriptor and descriptor_server_healthy(stale_descriptor):
            raise SwitchboardError("Switchboard backend already appears to be running for this workspace.")

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
        release_server_lock(server_lock)


def acquire_server_lock(root: Path) -> Path:
    lock_dir = root / "runner" / ".server.lock"
    lock_dir.parent.mkdir(parents=True, exist_ok=True)
    try:
        lock_dir.mkdir()
    except FileExistsError as exc:
        try:
            metadata = read_descriptor(lock_dir / "metadata.json") or {}
            age = __import__("time").time() - lock_dir.stat().st_mtime
        except OSError:
            metadata = {}
            age = 0
        has_pid = isinstance(metadata.get("pid"), int) and metadata.get("pid") > 0
        if descriptor_process_alive(metadata) or (not has_pid and age <= SERVER_LOCK_STALE_SECONDS):
            raise SwitchboardError("Switchboard backend already appears to be starting or running for this workspace.") from exc
        try:
            (lock_dir / "metadata.json").unlink(missing_ok=True)
            lock_dir.rmdir()
            lock_dir.mkdir()
        except OSError as stale_exc:
            raise SwitchboardError("Switchboard backend startup lock is held by another process.") from stale_exc
    atomic_write_json(lock_dir / "metadata.json", {"pid": os.getpid(), "startedAt": now_iso()})
    return lock_dir


def release_server_lock(lock_dir: Path) -> None:
    try:
        (lock_dir / "metadata.json").unlink(missing_ok=True)
        lock_dir.rmdir()
    except OSError:
        pass


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


def descriptor_process_alive(descriptor: dict[str, Any]) -> bool:
    pid = descriptor.get("pid")
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def descriptor_server_healthy(descriptor: dict[str, Any]) -> bool:
    if not descriptor_process_alive(descriptor):
        return False
    host = descriptor.get("host")
    port = descriptor.get("port")
    token = descriptor.get("token")
    if not isinstance(host, str) or not isinstance(port, int) or not isinstance(token, str):
        return False
    request = urllib.request.Request(f"http://{host}:{port}/health", headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(request, timeout=1) as response:
            return response.status == 200
    except OSError:
        return False


class SwitchboardRequestHandler(BaseHTTPRequestHandler):
    server: SwitchboardServer

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/health" and not parsed.path.startswith("/execution/"):
            self.respond({"ok": False, "message": "Not found."}, status=404)
            return
        if not self.authorized():
            self.respond({"ok": False, "message": "Unauthorized."}, status=401)
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
            self.respond({"ok": False, "message": "Not found."}, status=404)
            return
        self.respond(
            {
                "ok": True,
                "status": "healthy",
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
            payload = runner_stop(self.server.workspace)
            self.respond(payload)
            self.server.stop_event.set()
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        if parsed.path == "/runner/tick":
            self.respond(runner_tick(self.server.workspace))
            return
        if parsed.path == "/runner/status":
            self.respond(runner_status(self.server.workspace))
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
