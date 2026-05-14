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
            "# Production Reality Gate",
            "Do not treat `MVP`",
            "Mocks, fakes, fixtures, and generated sample data are allowed in tests",
            "Before marking implementation or review work done, identify the real source of truth",
            "Before any `done` status, verify that acceptance is met through real product paths",
            "# SprintEngine Local Python Environment",
            "you may install task-required Python packages into the repository-local virtual environment",
            ".venv\\Scripts\\python.exe -m pip install <package>",
            "## Execution Workspace Discipline",
            "Do not create Sprint Engine worktrees.",
            "Treat task-owned paths as the primary edit surface and collision boundary.",
            "scope expansion with the path, reason, and risk.",
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
            "produce the requested code quality review evidence or artifact",
            "Work read-only: do not edit application or test code.",
            "Move the task to `needs_input` only when the review output requires approval or the task is blocked from meeting acceptance",
            "Do not mutate the task graph; the architect decides whether to add follow-up work.",
            "Treat task-owned paths as the primary edit surface and collision boundary.",
            "scope expansion with the path, reason, and risk.",
        ],
    )


def test_spec_reviewer_join_prompt_uses_spec_soul_and_skill_standards(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "spec-reviewer-prompt",
        [task("T1", "Review spec conformance", "spec_reviewer")],
    )

    payload = fixture.cli.run("join", "--role", "spec_reviewer", "--id", "spec-reviewer-fixture")

    assert payload["ok"] is True
    assert payload["action"] == "work"
    assert_prompt_includes(
        payload["prompt"],
        [
            "You are a principal-level specification reviewer.",
            "sprintengine task next --role spec_reviewer --id spec-reviewer-fixture",
            "Build a requirement checklist from the task, plan, requirements artifact, comments, and acceptance criteria",
            "Use `workspace-knowledge` or `knowledge-grill`",
            "Use `behavior-first-testing` criteria",
            "Use `diagnose` principles",
            "Use the `prototype` boundary",
            "Apply the bundled workflow skills as review standards when relevant",
            "produce the requested specification conformance review evidence or artifact",
            "Work read-only: do not edit application or test code.",
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


def test_recover_returns_integrity_prompt_and_backup_path(tmp_path) -> None:
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
            "This is an integrity recovery pass, not implementation work.",
            "Do NOT run `sprintengine init`.",
            "repair task/acceptance defects that would let fake product behavior count as done",
            "You MAY use `Sprint Engine plan update-task`, `Sprint Engine plan add-task`, `Sprint Engine plan add-dependency`, or `Sprint Engine plan remove-dependency`",
            "A task is not done if it only works with mocks, samples, stubs, fake responses, placeholder persistence, disconnected UI state, or unverified hardware/external integrations.",
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
    assert state["artifacts"][0]["id"] == "A1"
    assert state["artifacts"][0]["kind"] == "requirements"
    assert state["artifacts"][0]["title"] == "Source Handoff"
    assert state["artifacts"][0]["path"] == state["source"]["path"]
    assert state["artifacts"][0]["status"] == "approved"
    assert state["artifacts"][0]["taskId"] == ""


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
    assert state["artifacts"][0]["title"] == "Source Handoff"
    assert state["artifacts"][0]["path"] == state["source"]["path"]
    assert state["artifacts"][0]["status"] == "approved"


def test_product_plan_handover_seeds_reviewable_product_requirements(tmp_path) -> None:
    state_path = tmp_path / ".multi-code" / "sprintengine" / "product-plan" / "state.yaml"
    cli = SwarmCli(state_path)
    cli.run(
        "handover",
        "--name",
        "Product Plan",
        "--goal",
        "Build from product plan",
        "--handover-text",
        "# Product Plan\n\nRequirements already exist.",
        "--source-plan-kind",
        "product_plan",
    )

    payload = cli.run("init", "--goal", "Build from product plan")
    state = read_state(state_path)

    assert state["source"]["planKind"] == "product_plan"
    assert (state_path.parent / "product-requirements.md").read_text(encoding="utf-8") == "# Product Plan\n\nRequirements already exist.\n"
    assert payload["productTask"]["title"] == "Review imported product plan"
    assert payload["productTask"]["status"] == "todo"
    assert payload["productArtifact"]["status"] == "draft"
    assert payload["planTask"]["dependsOn"] == [payload["productTask"]["id"]]
    assert payload["planTask"]["status"] == "todo"


def test_product_plan_without_product_reviewer_seeds_architect_review_input(tmp_path) -> None:
    state_path = tmp_path / ".multi-code" / "sprintengine" / "product-plan-no-product" / "state.yaml"
    cli = SwarmCli(state_path)
    cli.run(
        "handover",
        "--name",
        "Product Plan No Product",
        "--goal",
        "Build from product plan",
        "--handover-text",
        "# Product Plan\n\nRequirements already exist.",
        "--source-plan-kind",
        "product_plan",
        "--agent",
        "architect:architect",
    )

    payload = cli.run("init", "--goal", "Build from product plan", "--agent", "architect:architect")

    assert (state_path.parent / "product-requirements.md").read_text(encoding="utf-8") == "# Product Plan\n\nRequirements already exist.\n"
    assert payload["productTask"] is None
    assert payload["productArtifact"] is None
    assert payload["planTask"]["dependsOn"] == []
    assert "product-requirements.md" in payload["planTask"]["ownedPaths"]


def test_architect_plan_handover_skips_product_gate_even_when_product_rostered(tmp_path) -> None:
    state_path = tmp_path / ".multi-code" / "sprintengine" / "architect-plan" / "state.yaml"
    cli = SwarmCli(state_path)
    cli.run(
        "handover",
        "--name",
        "Architect Plan",
        "--goal",
        "Build from implementation plan",
        "--handover-text",
        "# Implementation Plan\n\nUse this plan.",
        "--source-plan-kind",
        "architect_plan",
        "--agent",
        "architect:architect",
        "--agent",
        "product:product",
        "--agent",
        "developer:developer-1",
    )

    payload = cli.run(
        "init",
        "--goal",
        "Build from implementation plan",
        "--agent",
        "architect:architect",
        "--agent",
        "product:product",
        "--agent",
        "developer:developer-1",
    )
    state = read_state(state_path)
    plan_artifact = next(artifact for artifact in state["artifacts"] if artifact["kind"] == "architect_plan")

    assert state["source"]["planKind"] == "architect_plan"
    assert (state_path.parent / "plan.md").read_text(encoding="utf-8") == "# Implementation Plan\n\nUse this plan.\n"
    assert payload["productTask"] is None
    assert payload["planTask"]["title"] == "Review imported implementation plan and create task graph"
    assert payload["planTask"]["status"] == "todo"
    assert payload["planTask"]["dependsOn"] == []
    assert plan_artifact["status"] == "draft"
    assert plan_artifact["path"] == "plan.md"


def test_typed_handover_init_preserves_reviewed_file_edits(tmp_path) -> None:
    state_path = tmp_path / ".multi-code" / "sprintengine" / "idempotent-architect-plan" / "state.yaml"
    cli = SwarmCli(state_path)
    cli.run(
        "handover",
        "--name",
        "Idempotent Architect Plan",
        "--goal",
        "Build from implementation plan",
        "--handover-text",
        "# Original Plan\n",
        "--source-plan-kind",
        "architect_plan",
        "--agent",
        "architect:architect",
    )

    cli.run("init", "--goal", "Build from implementation plan", "--agent", "architect:architect")
    plan_path = state_path.parent / "plan.md"
    plan_path.write_text("# Reviewed Plan\n\nCurrent code changed this.\n", encoding="utf-8")
    first_state = read_state(state_path)
    plan_artifact = next(artifact for artifact in first_state["artifacts"] if artifact["kind"] == "architect_plan")
    initial_history_count = len(plan_artifact["reviewHistory"])
    initial_updated_at = plan_artifact["updatedAt"]

    cli.run("init", "--goal", "Build from implementation plan", "--agent", "architect:architect")
    second_state = read_state(state_path)
    second_artifact = next(artifact for artifact in second_state["artifacts"] if artifact["kind"] == "architect_plan")

    assert plan_path.read_text(encoding="utf-8") == "# Reviewed Plan\n\nCurrent code changed this.\n"
    assert len(second_artifact["reviewHistory"]) == initial_history_count
    assert second_artifact["updatedAt"] == initial_updated_at


def test_product_plan_init_preserves_reviewed_requirements_edits(tmp_path) -> None:
    state_path = tmp_path / ".multi-code" / "sprintengine" / "idempotent-product-plan" / "state.yaml"
    cli = SwarmCli(state_path)
    cli.run(
        "handover",
        "--name",
        "Idempotent Product Plan",
        "--goal",
        "Build from product plan",
        "--handover-text",
        "# Original Requirements\n",
        "--source-plan-kind",
        "product_plan",
    )

    cli.run("init", "--goal", "Build from product plan")
    requirements_path = state_path.parent / "product-requirements.md"
    requirements_path.write_text("# Reviewed Requirements\n\nProduct corrected this.\n", encoding="utf-8")
    first_state = read_state(state_path)
    product_artifact = next(artifact for artifact in first_state["artifacts"] if artifact["kind"] == "requirements" and artifact["path"] == "product-requirements.md")
    initial_history_count = len(product_artifact["reviewHistory"])
    initial_updated_at = product_artifact["updatedAt"]

    cli.run("init", "--goal", "Build from product plan")
    second_state = read_state(state_path)
    second_artifact = next(artifact for artifact in second_state["artifacts"] if artifact["kind"] == "requirements" and artifact["path"] == "product-requirements.md")

    assert requirements_path.read_text(encoding="utf-8") == "# Reviewed Requirements\n\nProduct corrected this.\n"
    assert len(second_artifact["reviewHistory"]) == initial_history_count
    assert second_artifact["updatedAt"] == initial_updated_at


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
            "Read the exact plan file",
            "Do not use any other `plan.md` found elsewhere in the repo.",
            "Do not push unless explicitly instructed by the user.",
        ],
    )
