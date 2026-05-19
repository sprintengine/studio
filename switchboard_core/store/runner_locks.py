from __future__ import annotations

import errno
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

try:
    import fcntl as _fcntl_module
    _msvcrt_module = None
except ImportError:  # Windows
    _fcntl_module = None
    import msvcrt as _msvcrt_module  # type: ignore[import-not-found]

"""Runner singleton and runner state lock helpers."""

def runner_dir(workspace: Path) -> Path:
    return switchboard_root(workspace) / "runner"


def runner_state_path(workspace: Path) -> Path:
    return runner_dir(workspace) / "state.json"


def runner_events_path(workspace: Path) -> Path:
    return runner_dir(workspace) / "events.jsonl"


def runner_lock_dir(workspace: Path) -> Path:
    return runner_dir(workspace) / ".runner.lock"


@contextmanager
def locked_runner(workspace: Path) -> Iterator[None]:
    init_workspace(workspace)
    lock_dir = runner_lock_dir(workspace)
    deadline = time.monotonic() + 5
    while True:
        try:
            lock_dir.mkdir()
            break
        except FileExistsError as exc:
            try:
                age = datetime.now(timezone.utc).timestamp() - lock_dir.stat().st_mtime
            except OSError:
                age = 0
            if age > STALE_RUNNER_LOCK_SECONDS:
                try:
                    lock_dir.rmdir()
                    continue
                except OSError:
                    pass
            if time.monotonic() >= deadline:
                raise SwitchboardError("Switchboard runner is locked by another process.") from exc
            time.sleep(0.05)
    try:
        yield
    finally:
        try:
            lock_dir.rmdir()
        except OSError:
            pass


def runner_pid_path(workspace: Path) -> Path:
    return runner_dir(workspace) / "runner.pid"


def _read_runner_pid_file(path: Path) -> int | None:
    try:
        content = path.read_text(encoding="utf-8")
    except OSError:
        return None
    # Skip the leading sentinel byte on Windows; the PID is written after it.
    for token in content.replace("\x00", " ").split():
        try:
            value = int(token)
        except ValueError:
            continue
        if value > 0:
            return value
    return None


def _read_runner_pid_file_with_retry(path: Path, *, deadline_seconds: float = 0.5) -> int | None:
    # Brief retry covers the millisecond window between the holder
    # acquiring the kernel lock and writing its PID into the file. The
    # holder is guaranteed to write within a few syscalls of acquisition.
    deadline = time.monotonic() + deadline_seconds
    while True:
        pid = _read_runner_pid_file(path)
        if pid is not None:
            return pid
        if time.monotonic() >= deadline:
            return None
        time.sleep(0.01)


@dataclass
class RunnerProcessLock:
    path: Path
    handle: Any
    pid: int
    _released: bool = False

    def release(self) -> None:
        if self._released:
            return
        self._released = True
        handle = self.handle
        try:
            if _fcntl_module is not None:
                try:
                    _fcntl_module.flock(handle.fileno(), _fcntl_module.LOCK_UN)
                except OSError:
                    pass
            elif _msvcrt_module is not None:
                try:
                    handle.seek(0)
                    _msvcrt_module.locking(handle.fileno(), _msvcrt_module.LK_UNLCK, 1)
                except OSError:
                    pass
        finally:
            try:
                handle.close()
            except OSError:
                pass
            try:
                if _read_runner_pid_file(self.path) == self.pid:
                    self.path.unlink(missing_ok=True)
            except OSError:
                pass


def acquire_runner_process_lock(workspace: Path) -> RunnerProcessLock:
    """Acquire the process-level Switchboard runner singleton.

    The lock is an OS-level advisory lock on `runner/runner.pid`.
    When the holding process exits (clean or SIGKILL) the kernel releases
    the lock — there is no stale-TTL window.

    Raises:
        RunnerAlreadyRunningError: another live process holds the lock.
    """
    init_workspace(workspace)
    path = runner_pid_path(workspace)
    handle = path.open("a+", encoding="utf-8")
    try:
        if _fcntl_module is not None:
            try:
                _fcntl_module.flock(handle.fileno(), _fcntl_module.LOCK_EX | _fcntl_module.LOCK_NB)
            except (BlockingIOError, OSError) as exc:
                if isinstance(exc, OSError) and exc.errno not in (
                    errno.EAGAIN,
                    errno.EWOULDBLOCK,
                    errno.EACCES,
                ):
                    raise
                existing_pid = _read_runner_pid_file_with_retry(path)
                raise RunnerAlreadyRunningError(existing_pid) from exc
        elif _msvcrt_module is not None:
            handle.seek(0, os.SEEK_END)
            if handle.tell() == 0:
                handle.write("\x00")
                handle.flush()
            handle.seek(0)
            try:
                _msvcrt_module.locking(handle.fileno(), _msvcrt_module.LK_NBLCK, 1)
            except OSError as exc:
                existing_pid = _read_runner_pid_file_with_retry(path)
                raise RunnerAlreadyRunningError(existing_pid) from exc
        else:  # pragma: no cover — no locking primitive available
            raise SwitchboardError("Platform lacks fcntl/msvcrt; cannot acquire runner singleton lock.")
        if _msvcrt_module is not None:
            # Preserve the sentinel byte we locked; write the PID after it.
            handle.seek(1)
            handle.truncate()
            handle.write(str(os.getpid()))
        else:
            handle.seek(0)
            handle.truncate()
            handle.write(str(os.getpid()))
        handle.flush()
        try:
            os.fsync(handle.fileno())
        except (OSError, AttributeError):
            pass
        return RunnerProcessLock(path=path, handle=handle, pid=os.getpid())
    except RunnerAlreadyRunningError:
        try:
            handle.close()
        except OSError:
            pass
        raise
    except Exception:
        try:
            handle.close()
        except OSError:
            pass
        raise
