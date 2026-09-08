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

# Only sources that embed literal `sprintengine.*` tool names belong here: this
# guard exists to fail the build when such a literal names a renamed/removed tool.
# The prompt composers moved out of `src/renderer/src/utils/` into
# `src/shared/sprintengine/` when main took over orchestration (MC-2149), so
# `sprintengineHandoff.ts` is now `handoff-prompt.ts`; `agentPrompt.ts` and
# `sprintengineAutoRun.ts` are `agent-prompt.ts` and `auto-run.ts`, and both now
# DO name tools literally, so they are guarded here too. Anything added here
# must actually contain a literal tool name — the empty-set assertion below is
# what keeps this list honest.
RENDERER_PROMPT_SOURCES = [
    "src/shared/sprintengine/handoff-prompt.ts",
    "src/shared/sprintengine/agent-prompt.ts",
    "src/shared/sprintengine/auto-run.ts",
    "src/main/mobile/sprintengine/session.ts",
]

TOOL_NAME_PATTERN = re.compile(r"\bsprintengine\.[a-z_]+(?:\.[a-z_]+)?\b")

GENERATED_TOOL_NAMES_PATH = "src/shared/sprintengineToolNames.generated.ts"

# Managed-mode dispatch is claim-first by design: the runtime (renderer/main)
# decides who runs and names the claim tool. The directive protocol and the
# `join --watch` loop it served were deleted in MC-1827; this stays as the
# regression pin that no prompt source reintroduces the hop.
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


def test_role_coordination_prompts_are_claim_first_and_name_real_tools() -> None:
    # The `.agents/skills/sprintengine/prompts/*.md` coordination prompts ride
    # every managed `agent.join`. They are MCP-only and claim-first: the
    # directive protocol (headless CLI) and CLI join invocations must never
    # reach a managed agent through this layer, and every tool they name must
    # exist so a rename fails the build instead of stalling a live run.
    prompts_dir = REPO_ROOT / ".agents" / "skills" / "sprintengine" / "prompts"
    prompt_paths = sorted(prompts_dir.glob("*.md"))
    assert prompt_paths, "role coordination prompts missing"
    for path in prompt_paths:
        text = path.read_text(encoding="utf-8")
        names = sorted(set(TOOL_NAME_PATTERN.findall(text)))
        unknown = [name for name in names if name not in TOOL_SCHEMAS]
        assert not unknown, f"{path.name} references MCP tools missing from TOOL_SCHEMAS: {unknown}"
        forbidden = [name for name in names if name in FORBIDDEN_TOOL_REFERENCES]
        assert not forbidden, (
            f"{path.name} references {forbidden}: managed-mode prompts are claim-first; "
            "the directive protocol is headless-CLI only"
        )
        assert "sprintengine join --role" not in text, (
            f"{path.name} embeds a `sprintengine join` CLI invocation; these prompts are MCP-only"
        )


def test_generated_tool_names_module_matches_schemas() -> None:
    # The TS module is generated from TOOL_SCHEMAS so a tool rename is a
    # build/test failure, never a stalled live run. Regenerate with
    # scripts/generate_sprintengine_tool_names.py.
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "generate_sprintengine_tool_names",
        REPO_ROOT / "scripts" / "generate_sprintengine_tool_names.py",
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    expected = module.render_module()
    current = (REPO_ROOT / GENERATED_TOOL_NAMES_PATH).read_text(encoding="utf-8")
    assert current == expected, (
        f"{GENERATED_TOOL_NAMES_PATH} is stale — run "
        "scripts/generate_sprintengine_tool_names.py"
    )
