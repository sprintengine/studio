#!/usr/bin/env python3
from pathlib import Path
import runpy


SKILL_TOOL = Path(__file__).resolve().parents[1] / ".agents" / "skills" / "swarm-kanban" / "scripts" / "swarm_tool.py"

if __name__ == "__main__":
    runpy.run_path(str(SKILL_TOOL), run_name="__main__")
