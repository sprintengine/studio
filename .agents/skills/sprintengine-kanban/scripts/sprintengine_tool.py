#!/usr/bin/env python3
"""Entrypoint for the repo-root Sprint Engine CLI wrapper."""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.sprintengine_tool import main


if __name__ == "__main__":
    raise SystemExit(main())
