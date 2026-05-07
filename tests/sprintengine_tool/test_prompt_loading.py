from __future__ import annotations

import os
import subprocess
import sys

import pytest

import helpers as swarm_helpers
from fixtures import SwarmCli, assert_prompt_includes, create_team, read_state, task


@pytest.fixture(autouse=True)
def use_python_sprintengine_tool_on_windows(monkeypatch: pytest.MonkeyPatch) -> None:
    if os.name != "nt":
        return

    def command_for(cli: SwarmCli, *args: str) -> list[str]:
        swarm_helpers.assert_disposable_state_path(cli.state_path)
        return [
            sys.executable,
            str(swarm_helpers.REPO_ROOT / "scripts" / "sprintengine_tool.py"),
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
                "SprintEngine command failed.\n"
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
            raise AssertionError(f"SprintEngine command unexpectedly passed: {' '.join(command)}")
        return completed

    monkeypatch.setattr(swarm_helpers.SwarmCli, "run", run)
    monkeypatch.setattr(swarm_helpers.SwarmCli, "run_failure", run_failure)


def test_init_bootstraps_board_without_returning_role_prompt(tmp_path) -> None:
    state_path = tmp_path / ".multi-code" / "sprintengine" / "init-prompt" / "state.yaml"
    payload = SwarmCli(state_path).run("init", "--goal", "Capture current prompt behavior")

    assert payload["ok"] is True
    assert payload["action"] == "initialized"
    assert "role" not in payload
    assert "prompt" not in payload
    assert payload["productTask"]["role"] == "product"
    assert payload["productTask"]["status"] == "todo"
    assert payload["productTask"]["ownerAgentId"] is None
    assert payload["planTask"]["role"] == "architect"
    assert payload["planTask"]["status"] == "todo"


def test_init_ignores_legacy_worktree_preference_without_claiming_architect_work(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "worktree-init-prompt",
        [task("T0", "Completed product intake", "product", status="done")],
    )
    payload = fixture.cli.run("init", "--goal", "Plan in the current workspace", "--use-worktrees", "true")

    assert payload["ok"] is True
    assert payload["action"] == "initialized"
    assert "role" not in payload
    assert "prompt" not in payload
    assert payload["planTask"]["role"] == "architect"
    assert payload["planTask"]["status"] == "todo"
    assert payload["planTask"]["ownerAgentId"] is None


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
            "# Soul Personality And Quality Bar",
            "You are agent `developer-fixture` with role `developer`.",
            "sprintengine task next --role developer --id developer-fixture",
            "Complete the claimed task and log evidence.",
            "Only claim and work tasks whose Sprint Engine `task.role` exactly matches `developer`.",
            "interpret that as ready `developer` tasks only.",
            "Do not run `sprintengine task claim`, `sprintengine task status`, `sprintengine artifact ready`, `sprintengine plan`, or similar mutating commands for another role's task",
            "After completion, stop unless your current launch instructions explicitly tell you to keep claiming ready developer tasks.",
            "# Project-Relative Paths",
            "Never use absolute or machine-specific paths",
            "pass only project-root-relative paths",
            "# SprintEngine Local Python Environment",
            "you may install task-required Python packages into the repository-local virtual environment",
            ".venv\\Scripts\\python.exe -m pip install <package>",
            "## Execution Workspace Discipline",
            "Do not create Sprint Engine worktrees.",
            "Do not edit .multi-code/sprintengine/state.yaml directly",
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


def test_code_reviewer_join_prompt_allows_review_and_fix_tasks(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "code-reviewer-fix-prompt",
        [task("T1", "Review and fix implementation quality", "code_reviewer")],
    )

    payload = fixture.cli.run("join", "--role", "code_reviewer", "--id", "reviewer-fixture")

    assert payload["ok"] is True
    assert payload["action"] == "work"
    assert_prompt_includes(
        payload["prompt"],
        [
            "For review-and-fix tasks, make targeted code or test changes",
            "You may edit application or test code only within the task's owned paths",
            "When complete: follow the claimed task's review mode.",
            "For review-and-fix tasks, make targeted source or test changes inside the owned paths",
            "For review-only tasks, produce the requested review evidence or artifact.",
            "move the task to `needs_input` only when the review output requires approval or the task is blocked from meeting acceptance",
            "Do not mutate the task graph; the architect decides whether to add follow-up work.",
        ],
    )


def test_join_stops_when_only_other_role_tasks_are_ready(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "join-role-boundary",
        [task("T1", "Write product brief", "product")],
    )

    payload = fixture.cli.run("join", "--role", "architect", "--id", "Riley")

    assert payload["ok"] is True
    assert payload["action"] == "stop"
    assert payload["role"] == "architect"
    assert payload["agentId"] == "Riley"
    assert "No tasks are currently ready for the 'architect' role" in payload["message"]
    assert "prompt" not in payload

    state = read_state(fixture.state_path)
    product_task = state["tasks"][0]
    assert product_task["id"] == "T1"
    assert product_task["role"] == "product"
    assert product_task["status"] == "todo"
    assert product_task["ownerAgentId"] is None


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
            "You are the recovery architect for this sprintengine.",
            "This is an audit-only recovery pass, not a planning pass.",
            "Do NOT run `sprintengine init`.",
            "Only change status, notes, and evidence for tasks that already exist in state.yaml.",
        ],
    )


def test_handover_returns_architect_startup_prompt_for_canonical_tool_fetch(tmp_path) -> None:
    state_path = tmp_path / ".multi-code" / "sprintengine" / "handover-prompt" / "state.yaml"
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
            "Fetch the canonical Sprint Engine startup instructions from the Python tool.",
            "sprintengine --state",
            "init",
            "Then follow the returned prompt.",
        ],
    )

    state = read_state(state_path)
    assert isinstance(state["source"]["capturedAt"], str)
    assert state["source"]["kind"] == "markdown"
    assert state["source"]["origin"] == "inline"
    assert state["source"]["path"].endswith(".multi-code/sprintengine/handover-prompt/handover.md")


def test_handover_records_markdown_file_source_metadata(tmp_path) -> None:
    state_path = tmp_path / ".multi-code" / "sprintengine" / "file-handover" / "state.yaml"
    source_path = tmp_path / "future-plans" / "source-plan.md"
    source_path.parent.mkdir(parents=True)
    source_path.write_text("# Source Plan\n\nBuild the feature.\n", encoding="utf-8")

    payload = SwarmCli(state_path).run(
        "handover",
        "--name",
        "File Handover",
        "--goal",
        "Create a sourced sprintengine",
        "--handover",
        str(source_path),
    )

    assert payload["ok"] is True
    handover_path = state_path.parent / "handover.md"
    assert handover_path.read_text(encoding="utf-8") == "# Source Plan\n\nBuild the feature.\n"

    state = read_state(state_path)
    assert isinstance(state["source"]["capturedAt"], str)
    assert state["source"]["kind"] == "markdown"
    assert state["source"]["origin"] == "file"
    assert state["source"]["path"].endswith(".multi-code/sprintengine/file-handover/handover.md")
    assert state["source"]["originalPath"].endswith("future-plans/source-plan.md")


def test_product_intake_task_includes_handover_note_without_duplicates(tmp_path) -> None:
    state_path = tmp_path / ".multi-code" / "sprintengine" / "handover-product-note" / "state.yaml"
    cli = SwarmCli(state_path)
    cli.run(
        "handover",
        "--name",
        "Handover Product Note",
        "--goal",
        "Create a sourced sprintengine",
        "--handover-text",
        "# Source Plan\n\nProduct must read this.",
    )

    first = cli.run("init", "--goal", "Create a sourced sprintengine")
    second = cli.run("init", "--goal", "Create a sourced sprintengine")

    source_path = read_state(state_path)["source"]["path"]
    expected_note = f"Read `{source_path}` as incoming context before writing product-requirements.md."
    assert expected_note in first["productTask"]["implementationNotes"]
    assert second["productTask"]["implementationNotes"].count(expected_note) == 1


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
            "Read `plan.md` and `sprintengine summary`",
            "Do not push unless explicitly instructed by the user.",
        ],
    )
