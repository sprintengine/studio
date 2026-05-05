"""Health report primitives for CLI and MCP diagnostics."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any


CORE_VERSION = "0.1.0"
HEALTH_SCHEMA_VERSION = 1


def path_is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def build_health_report(
    *,
    state_path: Path | None = None,
    allowed_root: Path | None = None,
    backend_mode: str = "direct-core",
    version: str = CORE_VERSION,
) -> dict[str, Any]:
    report: dict[str, Any] = {
        "version": version,
        "schemaVersion": HEALTH_SCHEMA_VERSION,
        "backendMode": backend_mode,
        "allowedRoot": _allowed_root_status(state_path, allowed_root),
        "capabilities": _capabilities(state_path),
    }
    return report


def _allowed_root_status(state_path: Path | None, allowed_root: Path | None) -> dict[str, Any]:
    if allowed_root is None:
        return {"configured": False, "allowed": True}
    root = allowed_root.resolve()
    if state_path is None:
        return {"configured": True, "allowed": False, "root": str(root)}
    try:
        allowed = path_is_relative_to(state_path.resolve(), root)
    except OSError:
        allowed = False
    return {"configured": True, "allowed": allowed, "root": str(root)}


def _capabilities(state_path: Path | None) -> dict[str, bool]:
    if state_path is None:
        return {"read": False, "write": False}
    parent = state_path.parent
    return {
        "read": state_path.is_file() and os.access(state_path, os.R_OK),
        "write": parent.exists() and os.access(parent, os.W_OK),
    }
