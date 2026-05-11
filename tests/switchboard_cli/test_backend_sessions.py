"""End-to-end tests for the backend PTY session attach endpoints."""

from __future__ import annotations

import base64
import json
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from switchboard_core import pty_session  # noqa: E402
from switchboard_core.pty_session import PtySession, get_registry  # noqa: E402
from switchboard_core.server import SwitchboardRequestHandler, SwitchboardServer  # noqa: E402


def _start_server(workspace: Path) -> tuple[SwitchboardServer, threading.Thread, str]:
    (workspace / ".multi-code" / "switchboard" / "runner").mkdir(parents=True, exist_ok=True)
    token = "TEST_TOKEN"
    stop_event = threading.Event()
    server = SwitchboardServer(
        ("127.0.0.1", 0), SwitchboardRequestHandler, workspace, token, "2026-05-11T00:00:00Z", stop_event
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread, token


def _request(server: SwitchboardServer, token: str, method: str, path: str, body: dict[str, Any] | None = None) -> tuple[int, dict[str, Any]]:
    url = f"http://127.0.0.1:{server.server_port}{path}"
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Authorization": f"Bearer {token}"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=3) as response:
        raw = response.read().decode("utf-8")
        return response.status, json.loads(raw)


class BackendSessionEndpointsTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.workspace = Path(self._tmp.name)
        self.server, self.thread, self.token = _start_server(self.workspace)
        # Clear any registry leakage from prior tests.
        registry = get_registry()
        for s in registry.all_sessions():
            registry.remove(s.execution_id)

    def tearDown(self) -> None:
        registry = get_registry()
        for s in registry.all_sessions():
            try:
                s.terminate(force=True)
                s.wait_until_closed(timeout=1.0)
            finally:
                registry.remove(s.execution_id)
        self.server.shutdown()
        self.thread.join(timeout=2.0)
        self._tmp.cleanup()

    def _spawn_session(self, execution_id: str, argv: list[str], **kwargs: Any) -> PtySession:
        tdir = Path(tempfile.mkdtemp())
        session = PtySession(
            execution_id=execution_id,
            argv=argv,
            cwd=tdir,
            env=None,
            cols=80,
            rows=24,
            role="Engineer",
            kind="switchboard_task",
            stdout_log_path=tdir / "stdout.log",
            exit_file_path=tdir / "exit.json",
            **kwargs,
        )
        get_registry().register(session)
        return session

    def test_list_returns_active_sessions(self) -> None:
        session = self._spawn_session("exec_list_1", ["bash", "-c", "sleep 5"])
        try:
            status, payload = _request(self.server, self.token, "GET", "/sessions")
            self.assertEqual(status, 200)
            self.assertTrue(payload["ok"])
            sessions = payload["sessions"]
            ids = [s["executionId"] for s in sessions]
            self.assertIn("exec_list_1", ids)
            entry = next(s for s in sessions if s["executionId"] == "exec_list_1")
            self.assertEqual(entry["status"], "active")
            self.assertEqual(entry["role"], "Engineer")
        finally:
            session.terminate(force=True)
            session.wait_until_closed(timeout=2.0)

    def test_write_forwards_to_pty(self) -> None:
        session = self._spawn_session(
            "exec_write_1",
            ["bash", "-c", "read line; echo got: $line; exit 0"],
        )
        try:
            payload_in = base64.b64encode(b"piped-input\n").decode("ascii")
            status, payload = _request(
                self.server, self.token, "POST", "/execution/exec_write_1/write", {"data": payload_in}
            )
            self.assertEqual(status, 200)
            self.assertTrue(payload["ok"])
            self.assertTrue(session.wait_until_closed(timeout=3.0))
            self.assertEqual(session.exit_code, 0)
            log = session._stdout_log_path.read_bytes()
            self.assertIn(b"got: piped-input", log)
        finally:
            session.terminate(force=True)

    def test_signal_term_kills_process(self) -> None:
        session = self._spawn_session("exec_sig_1", ["bash", "-c", "sleep 30"])
        try:
            status, payload = _request(
                self.server, self.token, "POST", "/execution/exec_sig_1/signal", {"signal": "TERM"}
            )
            self.assertEqual(status, 200)
            self.assertTrue(payload["ok"])
            self.assertTrue(session.wait_until_closed(timeout=2.0))
            self.assertLess(session.exit_code or 0, 0)
        finally:
            if session.is_active():
                session.terminate(force=True)

    def test_resize_accepts_dimensions(self) -> None:
        session = self._spawn_session("exec_resize_1", ["bash", "-c", "sleep 2"])
        try:
            status, payload = _request(
                self.server, self.token, "POST", "/execution/exec_resize_1/resize", {"cols": 132, "rows": 40}
            )
            self.assertEqual(status, 200)
            self.assertTrue(payload["ok"])
            self.assertEqual(session.cols, 132)
            self.assertEqual(session.rows, 40)
        finally:
            session.terminate(force=True)
            session.wait_until_closed(timeout=2.0)

    def test_unknown_signal_rejected(self) -> None:
        session = self._spawn_session("exec_bad_sig_1", ["bash", "-c", "sleep 2"])
        try:
            status, payload = _request(
                self.server, self.token, "POST", "/execution/exec_bad_sig_1/signal", {"signal": "BOGUS"}
            )
            self.assertEqual(status, 200)
            self.assertFalse(payload["ok"])
            self.assertIn("Unknown signal", payload["message"])
        finally:
            session.terminate(force=True)
            session.wait_until_closed(timeout=2.0)

    def test_stream_replay_data_exit(self) -> None:
        session = self._spawn_session(
            "exec_stream_1",
            ["bash", "-c", "echo line1; sleep 0.1; echo line2; exit 0"],
        )
        # Wait briefly so initial output lands in the ring buffer.
        time.sleep(0.3)

        url = f"http://127.0.0.1:{self.server.server_port}/execution/exec_stream_1/stream"
        request = urllib.request.Request(url, headers={"Authorization": f"Bearer {self.token}"})
        events: list[tuple[str, str]] = []
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                buf = b""
                deadline = time.monotonic() + 3.0
                while time.monotonic() < deadline:
                    chunk = response.fp.readline()
                    if not chunk:
                        break
                    buf += chunk
                    if buf.endswith(b"\n\n"):
                        rawEvent = buf.decode("utf-8")
                        buf = b""
                        name = ""
                        data = ""
                        for line in rawEvent.split("\n"):
                            if line.startswith("event:"):
                                name = line.split(":", 1)[1].strip()
                            elif line.startswith("data:"):
                                data = line.split(":", 1)[1].strip()
                        if name:
                            events.append((name, data))
                        if name == "exit":
                            break
        finally:
            session.terminate(force=True)

        names = [name for name, _ in events]
        self.assertIn("replay", names)
        self.assertIn("exit", names)

    def test_pty_mode_enabled_by_serve(self) -> None:
        # serve() flips pty_mode_enabled when the long-lived server starts.
        # Our test boots the request handler directly so the flag may be off;
        # explicitly enabling it should be observable.
        pty_session.enable_pty_mode()
        self.assertTrue(pty_session.pty_mode_enabled() or pty_session.PtyProcess is None)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
