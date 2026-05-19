"""Path and time helpers for the Sprint Engine CLI."""

from __future__ import annotations

import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

def repository_root_for_tool() -> Path:
    starts = [Path.cwd().resolve(), Path(__file__).resolve()]
    seen = set()
    for start in starts:
        base = start.parent if start.is_file() else start
        candidates = [base, *base.parents]
        for candidate in candidates:
            key = str(candidate)
            if key in seen:
                continue
            seen.add(key)
            if (candidate / ".agents" / "skills" / "sprintengine").exists() or (candidate / ".git").exists():
                return candidate
    return Path(__file__).resolve().parents[1]


REPO_ROOT = repository_root_for_tool()
PROMPTS_DIR = REPO_ROOT / ".agents" / "skills" / "sprintengine" / "prompts"

MULTICODE_DIR_NAME = ".multi-code"
SPRINTENGINE_DIR_NAME = "sprintengine"


def sprintengine_root_for(workspace_root: Path) -> Path:
    return workspace_root / MULTICODE_DIR_NAME / SPRINTENGINE_DIR_NAME


def sprintengine_state_path_for(workspace_root: Path, team_slug: str) -> Path:
    return sprintengine_root_for(workspace_root) / team_slug / "run.yaml"


def workspace_root_for_state_path(state_path: Path) -> Path:
    resolved = state_path.resolve()
    parts = resolved.parts
    for index in range(len(parts) - 2):
        if parts[index] == MULTICODE_DIR_NAME and parts[index + 1] == SPRINTENGINE_DIR_NAME:
            return Path(*parts[:index])
    return resolved.parent.parent.parent.parent


def project_relative_path(workspace_root: Path, path: Path) -> str:
    try:
        return path.resolve().relative_to(workspace_root.resolve()).as_posix()
    except ValueError:
        return str(path)


def resolve_vcs_path(workspace_root: Path, value: str) -> Path:
    path = Path(value)
    if path.is_absolute():
        return path
    return workspace_root / path


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def default_state_path(start: Optional[Path] = None) -> Path:
    import sys
    env_path = os.environ.get("SPRINTENGINE_STATE_PATH")
    if env_path:
        print(f"[sprintengine] state path from SPRINTENGINE_STATE_PATH: {env_path}", file=sys.stderr)
        return Path(env_path)
    current = (start or Path.cwd()).resolve()
    print(f"[sprintengine] SPRINTENGINE_STATE_PATH not set, scanning from: {current}", file=sys.stderr)
    for candidate in [current, *current.parents]:
        sprintengine_root = sprintengine_root_for(candidate)
        p = sprintengine_root / "run.yaml"
        if p.exists():
            print(f"[sprintengine] found: {p}", file=sys.stderr)
            return p
        nested = sorted(sprintengine_root.glob("*/run.yaml"))
        if len(nested) == 1:
            print(f"[sprintengine] found nested: {nested[0]}", file=sys.stderr)
            return nested[0]
        if len(nested) > 1:
            names = [f.parent.name for f in nested]
            print(f"[sprintengine] multiple teams found in {sprintengine_root}/: {names}", file=sys.stderr)
            raise SystemExit(
                f"Multiple Sprint Engine teams found: {', '.join(names)}\n"
                f"Specify which one with: --state <path>\n"
                + "\n".join(f"  {f}" for f in nested)
            )
    fallback = sprintengine_root_for(current) / "run.yaml"
    print(f"[sprintengine] nothing found, defaulting to: {fallback}", file=sys.stderr)
    return fallback


def reject_invalid_posix_state_path(path: Path) -> None:
    raw = str(path)
    if os.name == "nt":
        return
    if re.match(r"^[A-Za-z]:[\\/]", raw):
        raise SystemExit(
            "Invalid POSIX state path: "
            f"{raw}\n"
            "This looks like a Windows path. Use the mounted WSL path, for example /mnt/c/..."
        )

