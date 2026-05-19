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

"""Switchboard metrics file helpers."""

def switchboard_metrics_dir(workspace: Path) -> Path:
    return switchboard_root(workspace) / "metrics"


def agent_feedback_metrics_path(workspace: Path) -> Path:
    return switchboard_metrics_dir(workspace) / "agent-feedback.jsonl"


def append_agent_feedback_record(workspace: Path, record: dict[str, Any]) -> str:
    path = agent_feedback_metrics_path(workspace)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True) + "\n")
    return relative_to_switchboard_root(workspace, path)
