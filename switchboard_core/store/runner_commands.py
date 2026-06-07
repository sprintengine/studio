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

"""Runner prompt rendering and CLI command materialization."""

def execution_root(workspace: Path) -> Path:
    return switchboard_root(workspace) / "executions"


def execution_dir(workspace: Path, execution_id: str) -> Path:
    return execution_root(workspace) / execution_id


def worktree_root(workspace: Path) -> Path:
    return switchboard_root(workspace) / "worktrees"


def worktree_dir(workspace: Path, execution_id: str) -> Path:
    validate_execution_id(execution_id)
    return worktree_root(workspace) / execution_id


def role_for_queue(queue: str) -> str:
    return {"ready": "developer", "testing": "tester", "review": "spec_reviewer"}[queue]


def claimed_status_for_queue(queue: str) -> str:
    return CLAIM_TRANSITIONS[queue]


def next_publish_for_queue(queue: str) -> str:
    return {"ready": "testing", "testing": "review", "review": "done"}[queue]


def build_runner_prompt(*, workspace: Path, task_id: str, queue: str, execution_id: str, run_workspace: Path | None = None) -> str:
    return with_turn_done_instruction(_build_runner_prompt_body(workspace=workspace, task_id=task_id, queue=queue, execution_id=execution_id, run_workspace=run_workspace))


def _build_runner_prompt_body(*, workspace: Path, task_id: str, queue: str, execution_id: str, run_workspace: Path | None = None) -> str:
    role = role_for_queue(queue)
    workspace_for_agent = (run_workspace or workspace).expanduser().resolve()
    workspace_root = workspace.expanduser().resolve()
    pass_target = next_publish_for_queue(queue)
    soul_bootstrap = [
        "Fetch your Soul from the Souls CLI before doing any role-specific work.",
        "",
        "```bash",
        f"souls get {role}",
        "```",
        "",
        "Treat the returned text as your role, judgment, and quality bar.",
        "",
        "If the `souls` command is unavailable, stop and report that the Souls CLI is unavailable instead of guessing the role prompt.",
    ]
    role_rules = {
        "developer": [
            "- Implement the requested change in the execution worktree.",
            "- When you publish implementation work, Switchboard will commit worktree changes, push the execution branch, create or reuse a GitHub pull request, and record the PR URL as evidence.",
            "- Do not move the task forward unless implementation evidence is complete.",
            f"- When implementation is complete, publish with evidence: switchboard publish --workspace {workspace_root} {task_id} --to {pass_target} --summary \"...\" --command \"...\" --touched-file \"...\" --comment \"...\"",
        ],
        "tester": [
            "- Validate behavior against the task description, acceptance expectations, evidence, and full comment history.",
            "- Run focused tests or manual checks and record exactly what you ran.",
            "- For UI, renderer, browser-visible, or end-to-end behavior, check available MCP tools in the current client session when practical, for example with `/mcp`. If a Playwright or browser automation MCP is available, use it for interaction checks, screenshots, navigation flows, and rendered evidence before relying only on static inspection.",
            "- If browser MCP tools are not available, use the strongest local alternative and record the gap in your evidence.",
            "- Do not make implementation fixes. If the failure is in tests or test harness only, explain that clearly before changing test-only files.",
            f"- Before publishing or requesting changes, assess the implementation attempt you reviewed: switchboard assess-agent --workspace {workspace_root} {task_id} --target-execution <execution-id-from-show> --reviewer-agent \"switchboard-{role}\" --reviewer-role \"{role}\" --summary \"...\" --correctness-pct 0-100 --evidence-quality-pct 0-100 --instruction-following-pct 0-100 --claims-checked <n> --hallucinated-claims <n>",
            f"- If validation passes, publish with evidence: switchboard publish --workspace {workspace_root} {task_id} --to {pass_target} --summary \"...\" --command \"...\" --comment \"...\"",
            f"- If validation fails, request changes back to Ready: switchboard request-changes --workspace {workspace_root} {task_id} --reason \"Expected ... but observed ... Repro: ...\"",
        ],
        "spec_reviewer": [
            "- Review correctness, requirement coverage, acceptance criteria, tests, and verification evidence against the task description and full comment history.",
            "- Do not make implementation fixes. Leave concrete requested changes for the next developer pass.",
            f"- Before publishing or requesting changes, assess the implementation attempt you reviewed: switchboard assess-agent --workspace {workspace_root} {task_id} --target-execution <execution-id-from-show> --reviewer-agent \"switchboard-{role}\" --reviewer-role \"{role}\" --summary \"...\" --correctness-pct 0-100 --evidence-quality-pct 0-100 --instruction-following-pct 0-100 --claims-checked <n> --hallucinated-claims <n> --missed-requirements <n> --implementation-mistakes <n>",
            f"- If review passes, publish with a verdict: switchboard publish --workspace {workspace_root} {task_id} --to {pass_target} --summary \"...\" --comment \"...\"",
            f"- If review finds required changes, request changes back to Ready: switchboard request-changes --workspace {workspace_root} {task_id} --reason \"Required changes: ... Evidence: ...\"",
        ],
    }[role]
    return "\n".join(
        [
            *soul_bootstrap,
            "",
            f"You are the Switchboard {role} agent for task {task_id}.",
            "",
            f"Workspace: {workspace_for_agent}",
            f"Switchboard root workspace: {workspace_root}",
            f"Execution ID: {execution_id}",
            f"Claimed queue: {queue}",
            "",
            "Rules:",
            "- Do not edit Switchboard task JSON files or Lock files directly.",
            "- Use the local `switchboard` command for task activity.",
            f"- Inspect the task before acting with: switchboard show --workspace {workspace_root} {task_id}",
            "- The show output includes the task description, evidence, and full comment history; read the comments before deciding what to do.",
            f"- Add progress notes with: switchboard comment --workspace {workspace_root} {task_id} --body \"...\" --author \"{role}\" --author-type agent --author-id \"switchboard-{role}\"",
            *role_rules,
            "- If blocked or unable to proceed for reasons other than requested changes, add a comment and stop without moving the task.",
        ]
    )


AGENT_TURN_DONE_SENTINEL = "[sprint-engine:done]"


def with_turn_done_instruction(prompt: str) -> str:
    """Appends the standard end-of-turn sentinel instruction to an agent
    prompt. The runtime watches the pty output for AGENT_TURN_DONE_SENTINEL
    and tears the session down when it appears, replacing the legacy
    --print process-exit signal so the agent can run interactively against
    a Claude subscription instead of full-rate API billing."""
    return (
        prompt.rstrip("\n")
        + "\n\nTurn completion signal:\n"
        + f"- When you have finished your work for this turn, print this exact line on its own as the last thing you do: {AGENT_TURN_DONE_SENTINEL}\n"
        + "- The runner uses that line to detect that your turn is complete and to release the session. Do not skip it."
    )


def runner_command_for(state: dict[str, Any]) -> list[str] | None:
    """Capability check only: returns the runner argv shape used for resolving
    whether the configured CLI is available on PATH. Prefer
    :func:`materialize_runner_command` when constructing an actual launch
    descriptor; this function is preserved for backward compatibility with
    callers that only need to test resolvability."""
    override = os.environ.get("SWITCHBOARD_LOCAL_PROCESS_COMMAND") or os.environ.get("SWITCHBOARD_RUNNER_COMMAND")
    if override and override.strip():
        return shlex.split(override)
    cli = str(state.get("cli") or "codex")
    command_name = "claude" if cli == "claude-code" else cli
    resolved = shutil.which(command_name)
    if not resolved:
        return None
    if cli == "codex":
        # Codex retains its non-interactive stdin-pipe shape for now. Its
        # billing model does not have the same subscription-vs-API split
        # the Claude switch addresses; the migration to interactive +
        # send-after-ready can land in a follow-up.
        return [resolved, "exec", "--dangerously-bypass-approvals-and-sandbox", "-"]
    if cli == "claude-code":
        # Claude now drives an interactive session with the prompt passed as
        # a positional argument and a printed sentinel for completion. This
        # routes the agent through the user's Claude subscription rather
        # than full-rate API billing that `--print` incurs.
        return [resolved, "--permission-mode", "bypassPermissions"]
    return [resolved]


def materialize_runner_command(
    state: dict[str, Any],
    *,
    execution_id: str,
    prompt: str,
) -> dict[str, Any] | None:
    """Returns the spawn-descriptor fragments the Electron runtime needs for
    a specific execution: command argv, injection mode, completion signal.
    Distinct from :func:`runner_command_for` because the materialized argv
    depends on the per-execution id and the rendered prompt."""
    override = os.environ.get("SWITCHBOARD_LOCAL_PROCESS_COMMAND") or os.environ.get("SWITCHBOARD_RUNNER_COMMAND")
    if override and override.strip():
        return {
            "command": shlex.split(override),
            "injection": {"mode": "stdin-pipe"},
            "completion": {"mode": "process-exit"},
        }
    cli = str(state.get("cli") or "codex")
    command_name = "claude" if cli == "claude-code" else cli
    resolved = shutil.which(command_name)
    if not resolved:
        return None
    if cli == "claude-code":
        return {
            "command": [
                resolved,
                "--permission-mode",
                "bypassPermissions",
                "--session-id",
                execution_id,
                prompt,
            ],
            "injection": {"mode": "positional-arg"},
            "completion": {"mode": "output-sentinel", "sentinel": AGENT_TURN_DONE_SENTINEL},
        }
    if cli == "codex":
        return {
            "command": [
                resolved,
                "exec",
                "--dangerously-bypass-approvals-and-sandbox",
                "-",
            ],
            "injection": {"mode": "stdin-pipe"},
            "completion": {"mode": "process-exit"},
        }
    return {
        "command": [resolved],
        "injection": {"mode": "stdin-pipe"},
        "completion": {"mode": "process-exit"},
    }



def validate_runner_capability(workspace: Path, state: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    workspace_root = workspace.expanduser().resolve()
    if not workspace_root.is_dir():
        errors.append("workspace root must exist and be a directory.")
    command = runner_command_for(state)
    if not command:
        errors.append(f"Runner CLI executable was not found: {state.get('cli', 'codex')}")
    root = execution_root(workspace)
    try:
        root.mkdir(parents=True, exist_ok=True)
        probe = root / f".capability.{os.getpid()}.tmp"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
    except OSError as exc:
        errors.append(f"execution root is not writable: {exc}")
    return errors
