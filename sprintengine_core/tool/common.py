"""Shared Sprint Engine CLI parsing and collection helpers."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from sprintengine_core import store as folder_store

def parse_bool(value: str) -> bool:
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise argparse.ArgumentTypeError("expected true or false")

def parse_json_object_arg(raw: Optional[str], flag: str) -> Dict[str, Any]:
    if raw is None:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"{flag} must be valid JSON: {exc.msg}.") from exc
    if not isinstance(parsed, dict):
        raise SystemExit(f"{flag} must be a JSON object.")
    return parsed

def unique_strings(values: List[Any]) -> List[str]:
    seen: set = set()
    result = []
    for v in values:
        if not isinstance(v, str):
            continue
        s = v.strip()
        if s and s not in seen:
            seen.add(s)
            result.append(s)
    return result

def path_is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False
