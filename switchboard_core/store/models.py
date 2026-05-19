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

"""Small immutable records used by the Switchboard store."""

@dataclass(frozen=True)
class LocatedTask:
    task: dict[str, Any]
    folder_status: str
    path: Path
    warnings: list[str]


@dataclass(frozen=True)
class FolderLock:
    folder: Path
    lock_dir: Path
    lock_file: Path


@dataclass(frozen=True)
class LockStatus:
    folder_status: str
    path: Path
    locked: bool
    stale: bool
    owner: str | None
    session_id: str | None
    created_at: str | None
    heartbeat_at: str | None
    age_seconds: float | None
