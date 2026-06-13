"""Renderer-to-MCP dispatch contract.

The renderer's dispatch prompts name MCP tools as literal strings; renaming or
removing a tool server-side would silently break those prompts at runtime.
This test extracts every `sprintengine.*` tool reference from the renderer
dispatch/prompt sources and asserts each one is advertised in TOOL_SCHEMAS, so
a tool rename fails the build instead of stalling a live run.
"""

from __future__ import annotations

import re

from helpers import REPO_ROOT
from sprintengine_mcp.schemas import TOOL_SCHEMAS

RENDERER_PROMPT_SOURCES = [
    "src/renderer/src/utils/sprintengineAutoRun.ts",
    "src/renderer/src/utils/sprintengineHandoff.ts",
    "src/renderer/src/utils/agentPrompt.ts",
    "src/renderer/src/utils/multiloop.ts",
    "src/main/mobile/sprintengine/session.ts",
]

TOOL_NAME_PATTERN = re.compile(r"\bsprintengine\.[a-z_]+(?:\.[a-z_]+)?\b")

# Managed-mode dispatch is claim-first by design: the runtime (renderer/main)
# decides who runs and names the claim tool; agents never route through the
# directive protocol. The directive tool survives only for the headless CLI
# (`join --watch`), which lives in Python, not in these sources.
FORBIDDEN_TOOL_REFERENCES = {"sprintengine.agent.next_directive"}


def test_renderer_prompt_tool_names_exist_in_mcp_schemas() -> None:
    for source in RENDERER_PROMPT_SOURCES:
        text = (REPO_ROOT / source).read_text(encoding="utf-8")
        names = sorted(set(TOOL_NAME_PATTERN.findall(text)))
        assert names, f"{source} references no sprintengine tools — update RENDERER_PROMPT_SOURCES"
        unknown = [name for name in names if name not in TOOL_SCHEMAS]
        assert not unknown, f"{source} references MCP tools missing from TOOL_SCHEMAS: {unknown}"
        forbidden = [name for name in names if name in FORBIDDEN_TOOL_REFERENCES]
        assert not forbidden, (
            f"{source} references {forbidden}: managed-mode prompts are claim-first; "
            "the directive protocol is headless-CLI only"
        )
