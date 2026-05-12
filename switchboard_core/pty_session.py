from __future__ import annotations

import json
import os
import signal
import threading
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

try:
    from ptyprocess import PtyProcess  # type: ignore[import-untyped]
except ImportError:  # pragma: no cover - POSIX-only; Windows is a follow-up
    PtyProcess = None  # type: ignore[assignment]


Subscriber = Callable[[str, bytes | None], None]

RING_LIMIT_BYTES = 512 * 1024
PTY_READ_CHUNK = 4096
LOG_FLUSH_BYTES = 64 * 1024
LOG_FLUSH_INTERVAL_SECONDS = 1.0

# Exited sessions linger in the registry briefly so late attachers can
# still see the replay buffer + exit event. After this window the
# registry prunes them on the next access (or via prune_completed()).
EXITED_SESSION_TTL_SECONDS = 5 * 60


class PtySession:
    def __init__(
        self,
        *,
        execution_id: str,
        argv: list[str],
        cwd: Path,
        env: dict[str, str] | None,
        cols: int,
        rows: int,
        role: str,
        kind: str,
        stdout_log_path: Path,
        exit_file_path: Path,
        initial_input: bytes | None = None,
    ) -> None:
        if PtyProcess is None:
            raise RuntimeError(
                "ptyprocess is not installed; backend PTY sessions are unavailable. "
                "Install runtime requirements (pip install -r requirements.txt)."
            )

        self.execution_id = execution_id
        self.role = role
        self.kind = kind
        self.cols = int(cols)
        self.rows = int(rows)
        self.cwd = cwd
        self.started_at = datetime.now(timezone.utc).isoformat()
        self.exited_at: str | None = None
        self.exit_code: int | None = None

        self._stdout_log_path = stdout_log_path
        self._exit_file_path = exit_file_path
        self._log_handle = stdout_log_path.open("ab")
        self._log_unflushed_bytes = 0
        self._log_last_flush_at = time.monotonic()

        self._lock = threading.Lock()
        self._ring: deque[bytes] = deque()
        self._ring_bytes = 0
        self._subscribers: set[Subscriber] = set()
        self._closed = False
        self._exited_monotonic: float | None = None

        merged_env = os.environ.copy()
        if env:
            merged_env.update(env)

        try:
            self.process = PtyProcess.spawn(
                list(argv),
                cwd=str(cwd),
                env=merged_env,
                dimensions=(self.rows, self.cols),
                echo=False,
            )
        except Exception:
            # Spawn failed — release the log handle we already opened so
            # the file descriptor doesn't leak. Caller will propagate.
            try:
                self._log_handle.close()
            except OSError:
                pass
            raise

        if initial_input:
            self._write_all(initial_input)

        self._reader = threading.Thread(
            target=self._read_loop,
            name=f"PtySessionReader-{execution_id}",
            daemon=True,
        )
        self._reader.start()

    def _write_all(self, data: bytes) -> None:
        """Write all bytes to the PTY, looping over short writes.

        ``PtyProcess.write`` may return fewer bytes written than passed when
        the kernel TTY buffer is near-full. For prompts approaching that
        size (typically 4-8 KB) a single ``write`` call could truncate.
        """
        view = memoryview(data)
        offset = 0
        while offset < len(view):
            try:
                written = self.process.write(bytes(view[offset:]))
            except OSError:
                return
            if not written:
                return
            offset += int(written)

    @property
    def pid(self) -> int:
        return int(self.process.pid)

    def is_active(self) -> bool:
        with self._lock:
            return not self._closed

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "executionId": self.execution_id,
                "role": self.role,
                "kind": self.kind,
                "cols": self.cols,
                "rows": self.rows,
                "startedAt": self.started_at,
                "exitedAt": self.exited_at,
                "exitCode": self.exit_code,
                "status": "exited" if self._closed else "active",
                "pid": self.pid,
                "bufferedBytes": self._ring_bytes,
            }

    def write(self, data: bytes) -> None:
        if not data:
            return
        with self._lock:
            if self._closed:
                return
        try:
            self.process.write(data)
        except OSError:
            pass

    def resize(self, cols: int, rows: int) -> None:
        cols = int(cols)
        rows = int(rows)
        if cols <= 0 or rows <= 0:
            return
        with self._lock:
            self.cols = cols
            self.rows = rows
            if self._closed:
                return
        try:
            self.process.setwinsize(rows, cols)
        except OSError:
            pass

    def send_signal(self, sig: int) -> None:
        with self._lock:
            if self._closed:
                return
        try:
            self.process.kill(sig)
        except (OSError, ValueError):
            pass

    def subscribe(self, callback: Subscriber) -> Callable[[], None]:
        with self._lock:
            self._subscribers.add(callback)
            already_closed = self._closed
        if already_closed:
            try:
                callback("exit", None)
            except Exception:
                pass
        return lambda: self._unsubscribe(callback)

    def _unsubscribe(self, callback: Subscriber) -> None:
        with self._lock:
            self._subscribers.discard(callback)

    def replay_bytes(self) -> bytes:
        with self._lock:
            return b"".join(self._ring)

    def attach(self, callback: Subscriber) -> tuple[bytes, bool, Callable[[], None]]:
        with self._lock:
            replay = b"".join(self._ring)
            closed = self._closed
            if not closed:
                self._subscribers.add(callback)
        if closed:
            return replay, True, (lambda: None)
        return replay, False, (lambda: self._unsubscribe(callback))

    def terminate(self, *, force: bool = False) -> None:
        with self._lock:
            if self._closed:
                return
        if force:
            sig = getattr(signal, "SIGKILL", signal.SIGTERM)
        else:
            sig = signal.SIGTERM
        try:
            self.process.kill(sig)
        except (OSError, ValueError):
            pass

    def wait_until_closed(self, timeout: float | None = None) -> bool:
        self._reader.join(timeout=timeout)
        return not self._reader.is_alive()

    def _read_loop(self) -> None:
        try:
            while True:
                try:
                    chunk = self.process.read(PTY_READ_CHUNK)
                except EOFError:
                    break
                except OSError:
                    break
                if not chunk:
                    break
                self._handle_chunk(chunk)
        finally:
            self._handle_exit()

    def _handle_chunk(self, chunk: bytes) -> None:
        try:
            self._log_handle.write(chunk)
            self._log_unflushed_bytes += len(chunk)
            now = time.monotonic()
            if (
                self._log_unflushed_bytes >= LOG_FLUSH_BYTES
                or (now - self._log_last_flush_at) >= LOG_FLUSH_INTERVAL_SECONDS
            ):
                self._log_handle.flush()
                self._log_unflushed_bytes = 0
                self._log_last_flush_at = now
        except OSError:
            pass
        with self._lock:
            self._ring.append(chunk)
            self._ring_bytes += len(chunk)
            while self._ring_bytes > RING_LIMIT_BYTES and self._ring:
                evicted = self._ring.popleft()
                self._ring_bytes -= len(evicted)
            subscribers = list(self._subscribers)
        for cb in subscribers:
            try:
                cb("data", chunk)
            except Exception:
                pass

    def _handle_exit(self) -> None:
        try:
            self.process.wait()
        except Exception:
            pass
        exit_status = getattr(self.process, "exitstatus", None)
        signal_status = getattr(self.process, "signalstatus", None)
        if exit_status is not None:
            exit_code: int | None = int(exit_status)
        elif signal_status is not None:
            exit_code = -int(signal_status)
        else:
            exit_code = None
        exited_at = datetime.now(timezone.utc).isoformat()
        with self._lock:
            self._closed = True
            self.exit_code = exit_code
            self.exited_at = exited_at
            self._exited_monotonic = time.monotonic()
            subscribers = list(self._subscribers)
        try:
            self._log_handle.flush()
        except OSError:
            pass
        try:
            self._log_handle.close()
        except OSError:
            pass
        _atomic_write_exit_file(self._exit_file_path, exit_code, exited_at)
        for cb in subscribers:
            try:
                cb("exit", None)
            except Exception:
                pass


def _atomic_write_exit_file(path: Path, exit_code: int | None, exited_at: str) -> None:
    """Atomically write the exit metadata so partial reads can't see truncated JSON."""
    payload = json.dumps({"exitCode": exit_code, "exitedAt": exited_at})
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    try:
        tmp_path.write_text(payload, encoding="utf-8")
        tmp_path.replace(path)
    except OSError:
        # Best-effort cleanup; the runner's reconcile loop will recover by
        # observing the dead pid and marking the execution abandoned.
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass


class PtySessionRegistry:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sessions: dict[str, PtySession] = {}

    def register(self, session: PtySession) -> None:
        # Opportunistic prune so a long-running server doesn't hold every
        # session it has ever spawned.
        self.prune_completed()
        with self._lock:
            self._sessions[session.execution_id] = session

    def get(self, execution_id: str) -> PtySession | None:
        with self._lock:
            return self._sessions.get(execution_id)

    def active_sessions(self) -> list[PtySession]:
        with self._lock:
            return [s for s in self._sessions.values() if not s._closed]

    def all_sessions(self) -> list[PtySession]:
        with self._lock:
            return list(self._sessions.values())

    def remove(self, execution_id: str) -> None:
        with self._lock:
            self._sessions.pop(execution_id, None)

    def prune_completed(self, *, ttl_seconds: float = EXITED_SESSION_TTL_SECONDS) -> int:
        """Drop exited sessions whose grace window has elapsed.

        Returns the number of sessions pruned. Called opportunistically
        on each ``register`` so a long-running server doesn't accumulate
        every session it has ever spawned.
        """
        now = time.monotonic()
        removed = 0
        with self._lock:
            stale_ids = [
                exec_id
                for exec_id, session in self._sessions.items()
                if session._closed
                and session._exited_monotonic is not None
                and (now - session._exited_monotonic) >= ttl_seconds
            ]
            for exec_id in stale_ids:
                self._sessions.pop(exec_id, None)
                removed += 1
        return removed

    def shutdown_all(self, *, grace_seconds: float = 3.0) -> None:
        with self._lock:
            sessions = [s for s in self._sessions.values() if not s._closed]
        for session in sessions:
            session.terminate(force=False)
        deadline = time.monotonic() + grace_seconds
        for session in sessions:
            remaining = max(0.0, deadline - time.monotonic())
            session.wait_until_closed(timeout=remaining)
        for session in sessions:
            if session.is_active():
                session.terminate(force=True)
                session.wait_until_closed(timeout=1.0)


_REGISTRY: PtySessionRegistry | None = None
_REGISTRY_LOCK = threading.Lock()
_PTY_MODE_ENABLED = False


def get_registry() -> PtySessionRegistry:
    global _REGISTRY
    with _REGISTRY_LOCK:
        if _REGISTRY is None:
            _REGISTRY = PtySessionRegistry()
        return _REGISTRY


def enable_pty_mode() -> None:
    global _PTY_MODE_ENABLED
    with _REGISTRY_LOCK:
        _PTY_MODE_ENABLED = True


def pty_mode_enabled() -> bool:
    with _REGISTRY_LOCK:
        return _PTY_MODE_ENABLED and PtyProcess is not None
