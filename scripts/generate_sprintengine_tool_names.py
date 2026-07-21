#!/usr/bin/env python3
"""Generate the TS tool-name module from the Python MCP schemas.

The renderer's dispatch prompts name MCP tools; generating the names from
`sprintengine_mcp/schemas.py` makes a server-side rename a compile/test
failure instead of a stalled live run. Output is checked in;
`tests/sprintengine_tool/test_dispatch_contract.py` fails when it drifts.

Usage: python3 scripts/generate_sprintengine_tool_names.py [--check]
"""
from __future__ import annotations

import sys
import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

OUTPUT_PATH = REPO_ROOT / "src" / "shared" / "sprintengineToolNames.generated.ts"


def render_module() -> str:
    from sprintengine_mcp.auth import MUTATING_TOOLS
    from sprintengine_mcp.schemas import TOOL_SCHEMAS, list_tool_schemas

    names = sorted(TOOL_SCHEMAS)
    lines = [
        "// Generated from sprintengine_mcp/schemas.py — do not edit.",
        "// Regenerate: python3 scripts/generate_sprintengine_tool_names.py",
        "",
        "export const SPRINTENGINE_TOOL_NAMES = [",
        *[f"  '{name}'," for name in names],
        "] as const",
        "",
        "export type SprintEngineToolName = (typeof SPRINTENGINE_TOOL_NAMES)[number]",
        "",
        "// Canonical definitions are generated from the Python MCP owner. The Studio",
        "// gateway consumes these to advertise run-native tools even before a run",
        "// exists, without reimplementing schemas in Electron main.",
        f"export const SPRINTENGINE_TOOL_DEFINITIONS = {json.dumps(list_tool_schemas(), indent=2)} as const",
        "",
        "export const SPRINTENGINE_MUTATING_TOOL_NAMES = [",
        *[f"  '{name}'," for name in sorted(MUTATING_TOOLS)],
        "] as const",
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    content = render_module()
    if "--check" in sys.argv:
        current = OUTPUT_PATH.read_text(encoding="utf-8") if OUTPUT_PATH.exists() else ""
        if current != content:
            print(f"{OUTPUT_PATH} is stale; run scripts/generate_sprintengine_tool_names.py", file=sys.stderr)
            return 1
        return 0
    OUTPUT_PATH.write_text(content, encoding="utf-8")
    print(f"wrote {OUTPUT_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
