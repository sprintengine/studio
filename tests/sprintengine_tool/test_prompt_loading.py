from __future__ import annotations

import os
import subprocess
import sys

import pytest

import helpers as swarm_helpers
from fixtures import SwarmCli, assert_prompt_includes, create_team, read_state, task
from helpers import write_state


def gated_review_task() -> dict:
    record = task(
        "T1",
        "Implement reviewed feature",
        "developer",
        "review",
        owner="developer-fixture",
        owned_paths=["sprintengine_core/tool.py"],
    )
    record["description"] = "Wire the reviewed feature into the real CLI path."
    record["acceptanceCriteria"] = ["CLI exposes the feature.", "Tests cover the review path."]
    record["implementationNotes"] = ["Reviewer prompts must treat summaries as claims."]
    record["evidence"] = {
        "summary": "Implemented the CLI feature.",
        "touchedFiles": ["sprintengine_core/tool.py"],
        "commandsRan": [".venv/bin/python -m pytest tests/sprintengine_tool/test_prompt_loading.py -q"],
        "results": ["Passed."],
        "scopeExpansions": [],
    }
    record["comments"] = [
        {
            "id": "C1",
            "type": "implementation_summary",
            "actor": "developer-fixture",
            "authorAgentId": "developer-fixture",
            "authorRole": "developer",
            "source": "agent",
            "body": "The feature is ready for review.",
            "createdAt": "2026-05-17T00:00:00Z",
        },
        {
            "id": "C2",
            "type": "review_feedback",
            "actor": "reviewer-old",
            "authorAgentId": "reviewer-old",
            "authorRole": "code_reviewer",
            "source": "agent",
            "body": "Older feedback should be below newer feedback.",
            "createdAt": "2026-05-17T00:01:00Z",
            "data": {"status": "open", "gateId": "code_reviewer", "verdict": "changes_requested"},
        },
    ]
    record["qualityGates"] = [
        {
            "id": "code_reviewer",
            "phase": "review",
            "role": "code_reviewer",
            "status": "pending",
            "required": True,
            "allowSelfReview": False,
            "focus": "correctness, maintainability, and evidence quality",
            "attempts": [
                {
                    "id": "GA-001",
                    "status": "changes_requested",
                    "role": "code_reviewer",
                    "claimedBy": "reviewer-old",
                    "summary": "Missing one assertion.",
                }
            ],
        }
    ]
    return record


def make_tester_gate_task() -> dict:
    record = task(
        "T1",
        "Validate renderer workflow",
        "frontend",
        "testing",
        owner="frontend-fixture",
        owned_paths=["src/renderer/src/components/workspace/SprintEngineAutoRunSupervisor.tsx"],
    )
    record["description"] = "Validate the completed renderer workflow through real UI or focused local alternatives."
    record["acceptanceCriteria"] = [
        "User-visible workflow renders without layout regressions.",
        "Focused tests cover the changed behavior.",
    ]
    record["evidence"] = {
        "summary": "Implemented the renderer workflow.",
        "touchedFiles": ["src/renderer/src/components/workspace/SprintEngineAutoRunSupervisor.tsx"],
        "commandsRan": ["npm run test:renderer:sprintengine-auto-run"],
        "results": ["Passed."],
        "scopeExpansions": [],
    }
    record["qualityGates"] = [
        {
            "id": "tester",
            "phase": "testing",
            "role": "tester",
            "status": "pending",
            "required": True,
            "allowSelfReview": True,
            "focus": "real-path validation, regression coverage, and reproducible verification",
            "attempts": [],
        }
    ]
    return record


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
    state_path = tmp_path / ".multi-code" / "sprintengine" / "init-prompt" / "run.yaml"
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
    assert "confirmed decisions" in " ".join(payload["planTask"]["acceptanceCriteria"])
    assert "autonomous planning or artifact auto-approval" in " ".join(payload["planTask"]["acceptanceCriteria"])


def test_init_without_worktrees_does_not_claim_architect_work(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "worktree-init-prompt",
        [task("T0", "Completed product intake", "product", status="done")],
    )
    payload = fixture.cli.run("init", "--goal", "Plan in the current workspace")

    assert payload["ok"] is True
    assert payload["action"] == "initialized"
    assert "role" not in payload
    assert "prompt" not in payload
    assert payload["planTask"]["role"] == "architect"
    assert payload["planTask"]["status"] == "todo"
    assert payload["planTask"]["ownerAgentId"] is None
    # Without the flag, no worktree is created and no vcs block is recorded.
    assert payload.get("vcs") is None


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
            "After completion, run `sprintengine join --role developer --id developer-fixture --watch` again if Auto Mode is on; otherwise stop.",
            "# Project-Relative Paths",
            "Never use absolute or machine-specific file paths",
            "All file and directory references must be relative to the project root",
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
            "Do not edit Sprint Engine run-store files directly",
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
            "Use `debug` principles",
            "Use the `prototype` boundary",
            "Apply the bundled workflow skills as review standards when relevant",
            "produce the requested specification conformance review evidence or artifact",
            "Work read-only: do not edit application or test code.",
            "Do not mutate the task graph; the architect decides whether to add follow-up work.",
        ],
    )


def test_gate_claim_returns_contextual_reviewer_prompt(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "gate-context-prompt",
        [gated_review_task()],
    )
    report_path = fixture.team_dir / "reviews" / "prior.md"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text("# Prior Review\n", encoding="utf-8")
    state = read_state(fixture.state_path)
    state["artifacts"] = [
        {
            "id": "A1",
            "kind": "code_review",
            "title": "Prior Review",
            "path": "reviews/prior.md",
            "status": "recorded",
            "createdBy": "reviewer-old",
            "taskId": "T1",
            "gateId": "code_reviewer",
            "reviewHistory": [],
            "recommendedTasks": [],
            "createdAt": "2026-05-17T00:02:00Z",
            "updatedAt": "2026-05-17T00:02:00Z",
        }
    ]
    write_state(fixture.state_path, state)

    payload = fixture.cli.run("task", "gate", "next", "--role", "code_reviewer", "--id", "reviewer-fixture")

    assert payload["ok"] is True
    assert payload["claimed"] is True
    assert_prompt_includes(
        payload["prompt"],
        [
            "# Sprint Engine Gate Review Context",
            "Plan path: `.multi-code/sprintengine/gate-context-prompt/plan.md`",
            "Reviewed task: `T1` - Implement reviewed feature",
            "Gate: `code_reviewer` phase=`review` role=`code_reviewer` attempt=`GA-002`",
            "Gate focus: correctness, maintainability, and evidence quality",
            "Description: Wire the reviewed feature into the real CLI path.",
            "Acceptance: CLI exposes the feature.",
            "Touched file: `sprintengine_core/tool.py`",
            "Command: `.venv/bin/python -m pytest tests/sprintengine_tool/test_prompt_loading.py -q`",
            "A1 `code_review` status=`recorded`",
            "Latest Implementation Summary Or Response",
            "The feature is ready for review.",
            "Open Feedback From This Gate (newest first)",
            "Older feedback should be below newer feedback.",
            "Prior Gate Attempts",
            "GA-001 status=`changes_requested`",
            "Audit implementation comments as claims, not proof.",
        ],
    )


def test_tester_gate_claim_prompt_requires_qa_validation_and_browser_checks(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "tester-gate-context-prompt",
        [make_tester_gate_task()],
    )

    payload = fixture.cli.run("task", "gate", "next", "--role", "tester", "--id", "tester-fixture")

    assert payload["ok"] is True
    assert payload["claimed"] is True
    assert_prompt_includes(
        payload["prompt"],
        [
            "Gate: `tester` phase=`testing` role=`tester`",
            "## Tester Gate Expectations",
            "Act as QA for the completed implementation, not as a second code reviewer.",
            "Build a short validation plan from the task acceptance criteria",
            "Run independent, reproducible verification commands where practical",
            "For UI, renderer, browser-visible, or end-to-end behavior, use Playwright/browser MCP or equivalent browser automation when available and proportionate.",
            "If browser MCP is unavailable or not applicable, say why and run the strongest local alternative",
            "lack of browser-level validation is residual risk and should fail or block the gate when visual or interaction correctness is part of acceptance.",
            "Add narrow regression tests, fixtures, or test harness wiring when that is the smallest safe way to validate the task.",
            "write the validation report under the active Sprint Engine team folder",
            ".multi-code/sprintengine/tester-gate-context-prompt/docs/validation/t1-tester-validation.md",
            "Do not write tester reports under repo-root `docs/validation/`.",
            "Submit the verdict with `--artifact-path <team-folder-report-path>`, `--artifact-title`, and `--artifact-kind validation_report`",
            "If no new test is needed, say why",
            "A passing tester verdict should report scope reviewed, commands run, tests evaluated or added, release confidence, and residual risk — as terse bullets, one line each.",
            "Keep the validation report bullet-first and under ~120 lines",
        ],
    )


def test_tester_join_gate_directive_allows_narrow_test_work_and_browser_mcp(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "tester-gate-join-directive",
        [make_tester_gate_task()],
    )

    payload = fixture.cli.run("join", "--role", "tester", "--id", "tester-fixture")

    assert payload["ok"] is True
    assert payload["action"] == "gate_work"
    assert_prompt_includes(
        payload["prompt"],
        [
            "quality-gate QA tester",
            "sprintengine task gate next --role tester --id tester-fixture",
            "Run independent verification",
            "use Playwright/browser MCP or equivalent browser automation when available and proportionate",
            "You may add narrow regression tests, fixtures, or test harness wiring",
            "document any companion test edits in the verdict summary or a validation_report artifact",
            "If broader implementation changes are needed, request changes or block the gate instead of taking over the implementer's work.",
        ],
    )


def test_task_next_rework_prompt_orders_open_feedback_newest_first(tmp_path) -> None:
    record = gated_review_task()
    record["status"] = "changes_requested"
    record["ownerAgentId"] = None
    record["comments"].append({
        "id": "C3",
        "type": "review_feedback",
        "actor": "reviewer-new",
        "authorAgentId": "reviewer-new",
        "authorRole": "code_reviewer",
        "source": "agent",
        "body": "Newest feedback should be handled first.",
        "createdAt": "2026-05-17T00:03:00Z",
        "data": {"status": "open", "gateId": "code_reviewer", "verdict": "changes_requested"},
    })
    fixture = create_team(tmp_path, "rework-prompt-order", [record])

    payload = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-fixture")

    assert payload["ok"] is True
    prompt = payload["prompt"]
    assert "Open Feedback (grouped by gate, newest first)" in prompt
    assert "### Gate `code_reviewer`" in prompt
    assert prompt.index("Newest feedback should be handled first.") < prompt.index("Older feedback should be below newer feedback.")
    assert "publish an `implementation_response`" in prompt


def test_projection_includes_gate_comments_feedback_and_recorded_artifacts(tmp_path) -> None:
    record = gated_review_task()
    fixture = create_team(tmp_path, "projection-gate-context", [record])
    state = read_state(fixture.state_path)
    state["artifacts"] = [
        {
            "id": "A1",
            "kind": "code_review",
            "title": "Recorded Review",
            "path": "reviews/recorded.md",
            "status": "recorded",
            "createdBy": "reviewer-fixture",
            "taskId": "T1",
            "gateId": "code_reviewer",
            "reviewHistory": [],
            "recommendedTasks": [],
            "createdAt": "2026-05-17T00:02:00Z",
            "updatedAt": "2026-05-17T00:02:00Z",
        }
    ]
    write_state(fixture.state_path, state)

    payload = fixture.cli.run("projection")
    projected = next(task for task in payload["tasks"] if task["id"] == "T1")

    assert projected["qualityGates"][0]["id"] == "code_reviewer"
    assert projected["qualityGateSummary"]["openRequired"] == 1
    assert projected["latestComments"][0]["id"] == "C2"
    assert projected["latestOpenFeedback"][0]["body"] == "Older feedback should be below newer feedback."
    assert projected["recordedArtifacts"] == [
        {
            "id": "A1",
            "kind": "code_review",
            "title": "Recorded Review",
            "path": "reviews/recorded.md",
            "gateId": "code_reviewer",
            "createdBy": "reviewer-fixture",
            "createdAt": "2026-05-17T00:02:00Z",
        }
    ]


def test_architect_join_prompt_requires_knowledge_backed_decision_checkpoint(tmp_path) -> None:
    fixture = create_team(
        tmp_path,
        "architect-discovery-prompt",
        [task("T1", "Plan implementation", "architect")],
    )

    payload = fixture.cli.run("join", "--role", "architect", "--id", "architect-fixture")

    assert payload["ok"] is True
    assert payload["action"] == "work"
    assert_prompt_includes(
        payload["prompt"],
        [
            "# Soul Personality And Quality Bar",
            "# Knowledge-Backed Discovery",
            "Ask one decision-shaping question at a time",
            "why it matters, your recommended answer or default assumption",
            "If code or documented behavior contradicts the user's stated intent, surface the contradiction before planning.",
            "## Knowledge-Backed Decision Checkpoint",
            "If the repo can answer a question, inspect the repo instead of asking.",
            "If a handover exists without a product intake conversation, treat it as incoming context, not as confirmation",
            "### Autonomous Planning Override",
            "Record defaults, risks, and skipped questions in `plan.md`",
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
    assert payload["action"] == "idle"
    assert payload["role"] == "architect"
    assert payload["agentId"] == "Riley"
    assert "No tasks or gates are currently ready for the 'architect' role" in payload["message"]
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
    state_path = tmp_path / ".multi-code" / "sprintengine" / "handover-prompt" / "run.yaml"
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
    state_path = tmp_path / ".multi-code" / "sprintengine" / "file-handover" / "run.yaml"
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
    state_path = tmp_path / ".multi-code" / "sprintengine" / "product-plan" / "run.yaml"
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
    assert "Incoming source context for this run:" in payload["productTask"]["description"]
    assert "Incoming source context for this run:" in payload["planTask"]["description"]
    assert "handover.md" in payload["planTask"]["description"]
    assert any("Do not derive the backlog item" in item for item in payload["planTask"]["implementationNotes"])


def test_backlog_handover_initial_architect_task_names_selected_backlog_item(tmp_path) -> None:
    state_path = tmp_path / ".multi-code" / "sprintengine" / "backlog-item" / "run.yaml"
    backlog_path = tmp_path / "backlog" / "checkout-flow.md"
    backlog_path.parent.mkdir(parents=True)
    backlog_path.write_text("# Checkout Flow\n\nFix the provider status link.\n", encoding="utf-8")

    cli = SwarmCli(state_path)
    cli.run(
        "handover",
        "--name",
        "Backlog Item",
        "--goal",
        "Plan from backlog",
        "--handover",
        str(backlog_path),
        "--source-plan-kind",
        "unknown",
        "--agent",
        "architect:architect",
    )
    payload = cli.run("init", "--goal", "Plan from backlog", "--agent", "architect:architect")

    description = payload["planTask"]["description"]
    assert "Incoming source context for this run:" in description
    assert "Root handoff" in description
    assert "backlog/checkout-flow.md" in description
    assert str(tmp_path) not in description
    assert "Use these explicit source paths" in description
    assert "do not infer the backlog item" in description
    assert any("explicit incoming source context" in item for item in payload["planTask"]["implementationNotes"])


def test_source_bundle_handover_seeds_product_and_architect_sources(tmp_path) -> None:
    state_path = tmp_path / ".multi-code" / "sprintengine" / "source-bundle" / "run.yaml"
    product_path = tmp_path / "future-plans" / "product.md"
    architect_path = tmp_path / "future-plans" / "implementation.md"
    mockup_path = tmp_path / "future-plans" / "mockup.html"
    product_path.parent.mkdir(parents=True)
    product_path.write_text("# Product Plan\n\nRequirements.\n", encoding="utf-8")
    architect_path.write_text("# Implementation Plan\n\nArchitecture.\n", encoding="utf-8")
    mockup_path.write_text("<!doctype html><title>Mockup</title>\n", encoding="utf-8")
    cli = SwarmCli(state_path)

    cli.run(
        "handover",
        "--name",
        "Source Bundle",
        "--goal",
        "Build from source bundle",
        "--source",
        f"product_plan:{product_path}",
        "--source",
        f"architect_plan:{architect_path}",
        "--source",
        f"html_mockup:{mockup_path}",
    )
    payload = cli.run("init", "--goal", "Build from source bundle")
    state = read_state(state_path)

    assert [item["kind"] for item in state["sourceBundle"]] == ["product_plan", "architect_plan", "html_mockup"]
    assert (state_path.parent / "product-requirements.md").read_text(encoding="utf-8") == "# Product Plan\n\nRequirements.\n"
    assert (state_path.parent / "plan.md").read_text(encoding="utf-8") == "# Implementation Plan\n\nArchitecture.\n"
    assert payload["productTask"]["title"] == "Review imported product plan"
    assert payload["planTask"]["title"] == "Review imported implementation plan and create task graph"
    assert payload["planTask"]["dependsOn"] == [payload["productTask"]["id"]]
    assert any("current-codebase index" in item for item in payload["planTask"]["acceptanceCriteria"])
    assert any("index the current codebase" in item for item in payload["planTask"]["implementationNotes"])
    assert "Architect plan artifact is marked ready for user approval after review." in payload["planTask"]["acceptanceCriteria"]
    assert "Incoming source context for this run:" in payload["productTask"]["description"]
    assert "Product plan:" in payload["productTask"]["description"]
    assert "Implementation plan:" in payload["planTask"]["description"]
    assert "HTML mockup:" in payload["planTask"]["description"]
    assert "future-plans/mockup.html" in payload["planTask"]["description"]
    assert str(tmp_path) not in payload["planTask"]["description"]
    assert [artifact for artifact in state["artifacts"] if artifact["taskId"] == ""] == []
    assert any("mockup.html" in note and "implementationNotes" in note for note in payload["productTask"]["implementationNotes"])
    assert any("mockup.html" in note and "implementationNotes" in note for note in payload["planTask"]["implementationNotes"])


def test_html_only_source_bundle_routes_mockup_context_to_review_tasks(tmp_path) -> None:
    state_path = tmp_path / ".multi-code" / "sprintengine" / "html-only-source" / "run.yaml"
    mockup_path = tmp_path / "future-plans" / "mockup.html"
    mockup_path.parent.mkdir(parents=True)
    mockup_path.write_text("<!doctype html><title>Mockup</title>\n", encoding="utf-8")
    cli = SwarmCli(state_path)

    cli.run(
        "handover",
        "--name",
        "HTML Only Source",
        "--goal",
        "Plan from a mockup",
        "--source",
        f"html_mockup:{mockup_path}",
    )
    payload = cli.run("init", "--goal", "Plan from a mockup")
    state = read_state(state_path)

    assert [item["kind"] for item in state["sourceBundle"]] == ["html_mockup"]
    assert payload["productTask"]["title"] == "Define product requirements"
    assert payload["planTask"]["dependsOn"] == [payload["productTask"]["id"]]
    assert "HTML mockup:" in payload["productTask"]["description"]
    assert "future-plans/mockup.html" in payload["planTask"]["description"]
    assert str(tmp_path) not in payload["planTask"]["description"]
    assert any("mockup.html" in note and "implementationNotes" in note for note in payload["productTask"]["implementationNotes"])
    assert any("mockup.html" in note and "implementationNotes" in note for note in payload["planTask"]["implementationNotes"])


def test_html_source_can_be_classified_as_architect_plan(tmp_path) -> None:
    state_path = tmp_path / ".multi-code" / "sprintengine" / "html-architect-plan" / "run.yaml"
    html_plan_path = tmp_path / "future-plans" / "implementation.html"
    html_plan_path.parent.mkdir(parents=True)
    html_plan_path.write_text("<!doctype html><title>Implementation Plan</title><main>Tasks</main>\n", encoding="utf-8")
    cli = SwarmCli(state_path)

    cli.run(
        "handover",
        "--name",
        "HTML Architect Plan",
        "--goal",
        "Plan from an HTML implementation document",
        "--source",
        f"architect_plan:{html_plan_path}",
    )
    payload = cli.run("init", "--goal", "Plan from an HTML implementation document")

    assert payload["productTask"] is None
    assert payload["planTask"]["title"] == "Review imported implementation plan and create task graph"
    assert "Incoming source context for this run:" in payload["planTask"]["description"]
    assert "Implementation plan:" in payload["planTask"]["description"]
    assert "future-plans/implementation.html" in payload["planTask"]["description"]
    assert str(tmp_path) not in payload["planTask"]["description"]
    assert any("current-codebase index" in item for item in payload["planTask"]["acceptanceCriteria"])
    assert any("index the current codebase" in item for item in payload["planTask"]["implementationNotes"])
    assert "Architect plan artifact is marked ready for user approval after review." in payload["planTask"]["acceptanceCriteria"]
    assert (state_path.parent / "plan.md").read_text(encoding="utf-8") == "<!doctype html><title>Implementation Plan</title><main>Tasks</main>\n"


def test_unknown_source_bundle_routes_context_to_review_tasks(tmp_path) -> None:
    state_path = tmp_path / ".multi-code" / "sprintengine" / "unknown-source" / "run.yaml"
    context_path = tmp_path / "future-plans" / "source.html"
    context_path.parent.mkdir(parents=True)
    context_path.write_text("<!doctype html><title>Context</title>\n", encoding="utf-8")
    cli = SwarmCli(state_path)

    cli.run(
        "handover",
        "--name",
        "Unknown Source",
        "--goal",
        "Plan from generic context",
        "--source",
        f"unknown:{context_path}",
    )
    payload = cli.run("init", "--goal", "Plan from generic context")

    assert any("source.html" in note for note in payload["productTask"]["implementationNotes"])
    assert any("source.html" in note for note in payload["planTask"]["implementationNotes"])


def test_product_plan_without_product_reviewer_seeds_architect_review_input(tmp_path) -> None:
    state_path = tmp_path / ".multi-code" / "sprintengine" / "product-plan-no-product" / "run.yaml"
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
    state_path = tmp_path / ".multi-code" / "sprintengine" / "architect-plan" / "run.yaml"
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
    assert any("current-codebase index" in item for item in payload["planTask"]["acceptanceCriteria"])
    assert any("index the current codebase" in item for item in payload["planTask"]["implementationNotes"])
    assert "Architect plan artifact is marked ready for user approval after review." in payload["planTask"]["acceptanceCriteria"]
    assert plan_artifact["status"] == "draft"
    assert plan_artifact["path"] == "plan.md"


def test_typed_handover_init_preserves_reviewed_file_edits(tmp_path) -> None:
    state_path = tmp_path / ".multi-code" / "sprintengine" / "idempotent-architect-plan" / "run.yaml"
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
    first_state["tasks"][0]["description"] = "Architect refined this task after reviewing the imported plan."
    write_state(state_path, first_state)

    cli.run("init", "--goal", "Build from implementation plan", "--agent", "architect:architect")
    second_state = read_state(state_path)
    second_artifact = next(artifact for artifact in second_state["artifacts"] if artifact["kind"] == "architect_plan")

    assert plan_path.read_text(encoding="utf-8") == "# Reviewed Plan\n\nCurrent code changed this.\n"
    assert len(second_artifact["reviewHistory"]) == initial_history_count
    assert second_state["tasks"][0]["description"] == "Architect refined this task after reviewing the imported plan."

    cli.run("init", "--goal", "Build from implementation plan", "--agent", "architect:architect")
    third_state = read_state(state_path)
    third_artifact = next(artifact for artifact in third_state["artifacts"] if artifact["kind"] == "architect_plan")
    assert third_artifact["updatedAt"] == second_artifact["updatedAt"]


def test_product_plan_init_preserves_reviewed_requirements_edits(tmp_path) -> None:
    state_path = tmp_path / ".multi-code" / "sprintengine" / "idempotent-product-plan" / "run.yaml"
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
    first_state["tasks"][0]["description"] = "Product refined this task after reviewing the imported requirements."
    write_state(state_path, first_state)

    cli.run("init", "--goal", "Build from product plan")
    second_state = read_state(state_path)
    second_artifact = next(artifact for artifact in second_state["artifacts"] if artifact["kind"] == "requirements" and artifact["path"] == "product-requirements.md")

    assert requirements_path.read_text(encoding="utf-8") == "# Reviewed Requirements\n\nProduct corrected this.\n"
    assert len(second_artifact["reviewHistory"]) == initial_history_count
    assert second_state["tasks"][0]["description"] == "Product refined this task after reviewing the imported requirements."

    cli.run("init", "--goal", "Build from product plan")
    third_state = read_state(state_path)
    third_artifact = next(artifact for artifact in third_state["artifacts"] if artifact["kind"] == "requirements" and artifact["path"] == "product-requirements.md")
    assert third_artifact["updatedAt"] == second_artifact["updatedAt"]


def test_init_does_not_refresh_approved_artifact_fingerprint_after_file_edit(tmp_path) -> None:
    state_path = tmp_path / ".multi-code" / "sprintengine" / "approved-plan-edit" / "run.yaml"
    cli = SwarmCli(state_path)
    cli.run(
        "handover",
        "--name",
        "Approved Plan Edit",
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
    state = read_state(state_path)
    plan_artifact = next(artifact for artifact in state["artifacts"] if artifact["kind"] == "architect_plan")
    plan_artifact["status"] = "approved"
    plan_artifact["approvedBy"] = "user"
    plan_artifact["approvedAt"] = "2026-05-14T10:00:00Z"
    original_fingerprint = plan_artifact["fingerprint"]
    original_updated_at = plan_artifact["updatedAt"]
    write_state(state_path, state)

    (state_path.parent / "plan.md").write_text("# Edited After Approval\n", encoding="utf-8")
    cli.run("init", "--goal", "Build from implementation plan", "--agent", "architect:architect")
    updated_state = read_state(state_path)
    updated_artifact = next(artifact for artifact in updated_state["artifacts"] if artifact["kind"] == "architect_plan")

    assert updated_artifact["status"] == "approved"
    assert updated_artifact["fingerprint"] == original_fingerprint
    assert updated_artifact["updatedAt"] == original_updated_at


def test_init_refreshes_ready_for_review_artifact_fingerprint_after_file_edit(tmp_path) -> None:
    state_path = tmp_path / ".multi-code" / "sprintengine" / "ready-plan-edit" / "run.yaml"
    cli = SwarmCli(state_path)
    cli.run(
        "handover",
        "--name",
        "Ready Plan Edit",
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
    state = read_state(state_path)
    plan_artifact = next(artifact for artifact in state["artifacts"] if artifact["kind"] == "architect_plan")
    plan_artifact["status"] = "ready_for_review"
    original_fingerprint = plan_artifact["fingerprint"]
    write_state(state_path, state)

    (state_path.parent / "plan.md").write_text("# Edited During Review\n", encoding="utf-8")
    cli.run("init", "--goal", "Build from implementation plan", "--agent", "architect:architect")
    updated_state = read_state(state_path)
    updated_artifact = next(artifact for artifact in updated_state["artifacts"] if artifact["kind"] == "architect_plan")

    assert updated_artifact["status"] == "ready_for_review"
    assert updated_artifact["fingerprint"] != original_fingerprint


def test_product_intake_task_includes_handover_note_without_duplicates(tmp_path) -> None:
    state_path = tmp_path / ".multi-code" / "sprintengine" / "handover-product-note" / "run.yaml"
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
