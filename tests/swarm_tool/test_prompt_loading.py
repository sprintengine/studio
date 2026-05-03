from __future__ import annotations

import os
import subprocess
import sys

import pytest

import helpers as swarm_helpers
from fixtures import SwarmCli, assert_prompt_includes, create_team, task


@pytest.fixture(autouse=True)
def use_python_swarm_tool_on_windows(monkeypatch: pytest.MonkeyPatch) -> None:
    if os.name != "nt":
        return

    def command_for(cli: SwarmCli, *args: str) -> list[str]:
        swarm_helpers.assert_disposable_state_path(cli.state_path)
        return [
            sys.executable,
            str(swarm_helpers.REPO_ROOT / "scripts" / "swarm_tool.py"),
            "--state",
            str(cli.state_path),
            *args,
        ]

    def run(cli: SwarmCli, *args: str) -> dict:
        command = command_for(cli, *args)
        completed = subprocess.run(
            command,
            cwd=swarm_helpers.REPO_ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if completed.returncode != 0:
            raise AssertionError(
                "Swarm command failed.\n"
                f"command: {' '.join(command)}\n"
                f"stdout:\n{completed.stdout}\n"
                f"stderr:\n{completed.stderr}"
            )
        return swarm_helpers.parse_cli_json(completed.stdout, command)

    def run_failure(cli: SwarmCli, *args: str) -> subprocess.CompletedProcess[str]:
        command = command_for(cli, *args)
        completed = subprocess.run(
            command,
            cwd=swarm_helpers.REPO_ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if completed.returncode == 0:
            raise AssertionError(f"Swarm command unexpectedly passed: {' '.join(command)}")
        return completed

    monkeypatch.setattr(swarm_helpers.SwarmCli, "run", run)
    monkeypatch.setattr(swarm_helpers.SwarmCli, "run_failure", run_failure)


def test_init_returns_product_intake_prompt_from_python_tool(tmp_path) -> None:
    state_path = tmp_path / "swarm" / "init-prompt" / "state.yaml"
    payload = SwarmCli(state_path).run("init", "--goal", "Capture current prompt behavior")

    assert payload["ok"] is True
    assert payload["role"] == "product"
    assert payload["action"] == "product_intake"
    assert_prompt_includes(
        payload["prompt"],
        [
            "# Specialist Personality And Quality Bar",
            "## Product-First Intake",
            "swarm artifact ready",
            "Do not create implementation tasks.",
            "Do not edit swarm/state.yaml directly",
        ],
    )


def test_init_accepts_worktree_preference_and_injects_architect_guidance(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "worktree-init-prompt",
        [task("T0", "Completed product intake", "product", status="done")],
    )
    payload = fixture.cli.run("init", "--goal", "Plan in a shared worktree", "--use-worktrees", "true")

    assert payload["ok"] is True
    assert payload["role"] == "architect"
    assert_prompt_includes(
        payload["prompt"],
        [
            "## Worktree Preference",
            "The user enabled architect-managed swarm worktrees for this run.",
            "Worktree: enabled",
            "Worktree path:",
            "Merge target:",
        ],
    )


def test_init_rejects_invalid_worktree_preference(tmp_path) -> None:
    state_path = tmp_path / "swarm" / "invalid-worktree-flag" / "state.yaml"
    completed = SwarmCli(state_path).run_failure("init", "--use-worktrees", "maybe")

    assert completed.returncode == 2
    assert "expected true or false" in completed.stderr


def test_join_returns_worker_prompt_and_resume_directive(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "join-prompt",
        [task("T1", "Implement prompt regression", "developer")],
    )

    work_payload = fixture.cli.run("join", "--role", "developer", "--id", "developer-fixture")
    assert work_payload["ok"] is True
    assert work_payload["action"] == "work"
    assert work_payload["readyTaskCount"] == 1
    assert_prompt_includes(
        work_payload["prompt"],
        [
            "# Specialist Personality And Quality Bar",
            "You are agent `developer-fixture` with role `developer`.",
            "swarm task next --role developer --id developer-fixture",
            "Complete exactly one task and log evidence.",
            "# Project-Relative Paths",
            "Never use absolute or machine-specific paths",
            "pass only project-root-relative paths",
            "# Swarm Local Python Environment",
            "you may install task-required Python packages into the repository-local virtual environment",
            ".venv\\Scripts\\python.exe -m pip install <package>",
            "## Execution Workspace Discipline",
            "If `plan.md` declares `Worktree: enabled`",
            "Commit: abc1234",
            "Do not edit swarm/state.yaml directly",
        ],
    )

    fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-fixture")
    resume_payload = fixture.cli.run("join", "--role", "developer", "--id", "developer-fixture")
    assert resume_payload["ok"] is True
    assert resume_payload["action"] == "resume"
    assert resume_payload["task"]["id"] == "T1"
    assert_prompt_includes(
        resume_payload["prompt"],
        [
            "You already have active task `T1`: Implement prompt regression.",
            "This reconnects you to your existing active task instead of claiming a new one.",
            "## Execution Workspace Discipline",
        ],
    )


def test_recover_returns_audit_only_prompt_and_backup_path(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "recover-prompt",
        [task("T1", "Existing task to audit", "developer")],
    )

    payload = fixture.cli.run("recover")

    assert payload["ok"] is True
    assert payload["role"] == "architect"
    assert payload["action"] == "recover"
    assert payload["taskCount"] == 1
    assert payload["backupPath"].endswith(".yaml")
    assert payload["backupPath"] != str(fixture.state_path)
    assert_prompt_includes(
        payload["prompt"],
        [
            "You are the recovery architect for this swarm.",
            "This is an audit-only recovery pass, not a planning pass.",
            "Do NOT run `swarm init`.",
            "Only change status, notes, and evidence for tasks that already exist in state.yaml.",
        ],
    )


def test_handover_returns_architect_startup_prompt_for_canonical_tool_fetch(tmp_path) -> None:
    state_path = tmp_path / "swarm" / "handover-prompt" / "state.yaml"
    payload = SwarmCli(state_path).run(
        "handover",
        "--name",
        "Handover Prompt",
        "--goal",
        "Create a canonical startup prompt",
        "--handover-text",
        "Incoming handoff context.",
    )

    assert payload["ok"] is True
    assert payload["action"] == "handover"
    assert payload["team"] == "handover-prompt"
    assert payload["statePath"] == str(state_path)
    assert payload["handoverPath"].endswith("handover.md")
    assert_prompt_includes(
        payload["architectStartupPrompt"],
        [
            "Fetch the canonical swarm startup instructions from the Python tool.",
            "swarm --state",
            "init",
            "--use-worktrees false",
            "Then follow the returned prompt.",
        ],
    )


def test_merge_start_returns_instruction_only_prompt(tmp_path) -> None:
    fixture = create_team(tmp_path, "merge-start", [task("T1", "Done task", "developer", status="done")])
    payload = fixture.cli.run("merge", "start", "--id", "architect", "--target", "main")

    assert payload["ok"] is True
    assert payload["action"] == "merge_start"
    assert payload["target"] == "main"
    assert_prompt_includes(
        payload["prompt"],
        [
            "This command only returns instructions. It has not changed task cards and has not run Git.",
            "Read `plan.md` and `swarm summary`",
            "Do not push unless explicitly instructed by the user.",
        ],
    )
