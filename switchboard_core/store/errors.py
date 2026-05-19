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

"""Operator-facing Switchboard exceptions."""

class SwitchboardError(Exception):
    """Operator-facing CLI error."""


class RunnerAlreadyRunningError(SwitchboardError):
    """Raised when another live process holds the runner singleton lock."""

    def __init__(self, pid: int | None) -> None:
        if pid and pid > 0:
            message = f"Switchboard backend already running for this workspace (pid {pid})."
        else:
            message = "Switchboard backend already running for this workspace."
        super().__init__(message)
        self.pid = pid if pid and pid > 0 else None

