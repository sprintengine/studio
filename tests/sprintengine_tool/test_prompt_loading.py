from __future__ import annotations

import os
import subprocess
import sys

import pytest

import helpers as swarm_helpers
from fixtures import SwarmCli, assert_prompt_includes, create_team, read_state, task
from helpers import write_state


def reviewing_task() -> dict:
    """A published task in its review phase, still owned by its implementer."""
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
    record["implementationNotes"] = ["Review prompts must treat summaries as claims."]
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
            "actor": "user",
            "authorAgentId": "user",
            "authorRole": "user",
            "source": "user",
            "body": "Older feedback should be below newer feedback.",
            "createdAt": "2026-05-17T00:01:00Z",
            "data": {"status": "open"},
        },
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
    state_path = tmp_path / ".sprintengine" / "sprintengine" / "init-prompt" / "run.yaml"
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
            "Only claim and work tasks whose Sprint Engine `task.role` exactly matches `developer`, plus tasks that carry no role at all.",
            "Do not run `sprintengine task claim`, `sprintengine task status`, `sprintengine artifact ready`, `sprintengine plan`, or similar mutating commands for another role's task",
            "When the task is done, stop.",
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


# code_reviewer / spec_reviewer join-prompt tests removed in MC-1542: those
# standalone reviewer roles/souls are retired (task owners self-review via a
# `review` phase), so there is no reviewer soul or role prompt to assert on.


def test_publish_returns_the_contextual_phase_directive_inline(tmp_path) -> None:
    """MC-1542: the review context the gate-claim prompt used to carry is now composed
    into `nextDirective` and handed to the owner inside the publish call. It omits the
    task card and diff on purpose — the live owner already has them in context."""
    record = reviewing_task()
    record["status"] = "in_progress"
    fixture = create_team(tmp_path, "phase-directive-prompt", [record])

    payload = fixture.cli.run(
        "task", "publish", "--task-id", "T1", "--id", "developer-fixture", "--summary", "Ready for review."
    )

    assert payload["ok"] is True
    assert payload["nextStatus"] == "review"
    assert_prompt_includes(
        payload["nextDirective"],
        [
            "Your task has entered review — you are now reviewing your own work.",
            "No other agent will review it.",
            "Task: `T1` - Implement reviewed feature",
            "Phase: `review`",
            # Item 1566: the directive references the card and the response's
            # openFeedback delta instead of re-serializing their bodies.
            "Review against your task card's acceptance criteria and the plan.",
            "open feedback comment(s) on this response",
            'Close this phase with `sprintengine.task.advance` `{ taskId: "T1", phase: "review", outcome, summary }`.',
        ],
    )
    directive = payload["nextDirective"]
    # Bodies the owner already holds are not re-listed in the directive...
    assert "CLI exposes the feature." not in directive
    assert "Older feedback should be below newer feedback." not in directive
    # ...but the full task (with its comments) still rides the publish payload,
    # so no channel loses the feedback bodies.
    bodies = [comment.get("body") for comment in payload["task"]["comments"]]
    assert "Older feedback should be below newer feedback." in bodies
    # No gate vocabulary survives into the directive the owner reads.
    assert "Gate:" not in directive
    assert "Prior Gate Attempts" not in directive
    assert "sprintengine.gate." not in directive


def test_phase_respawn_brief_rebuilds_the_context_a_cold_owner_lost(tmp_path) -> None:
    """Flow 6: a revived owner has nothing in context, so the brief prepends the task
    card and the published evidence before the same directive body."""
    from sprintengine_core.tool.phase_prompts import build_phase_respawn_brief

    fixture = create_team(tmp_path, "phase-respawn-brief", [reviewing_task()])
    state = read_state(fixture.state_path)
    record = next(item for item in state["tasks"] if item["id"] == "T1")

    brief = build_phase_respawn_brief(state, fixture.state_path, record, "review")

    assert_prompt_includes(
        brief,
        [
            "# Sprint Engine Phase Handover",
            "You previously owned `T1` and are resuming it mid-phase.",
            "Plan path: `.sprintengine/sprintengine/phase-respawn-brief/plan.md`",
            "Task role: `developer`",
            "Description: Wire the reviewed feature into the real CLI path.",
            "Owned Paths",
            "`sprintengine_core/tool.py`",
            "Summary: Implemented the CLI feature.",
            "Touched file: `sprintengine_core/tool.py`",
            "Command: `.venv/bin/python -m pytest tests/sprintengine_tool/test_prompt_loading.py -q`",
            # ...and then the very same directive the live owner receives inline.
            "Your task has entered review — you are now reviewing your own work.",
            'Close this phase with `sprintengine.task.advance`',
        ],
    )


def test_phase_respawn_brief_caps_evidence_and_diff_lists(tmp_path) -> None:
    """Item 1566: the cold-start brief is bounded — long evidence logs and huge
    diffs elide with explicit markers instead of dumping unbounded text."""
    from sprintengine_core.tool.phase_prompts import build_phase_respawn_brief

    record = reviewing_task()
    record["description"] = "D" * 2_000
    record["evidence"]["results"] = [f"result {index}" for index in range(25)]
    record["evidence"]["diffs"] = [
        {"path": f"src/file_{index}.py", "status": "modified", "additions": 1, "deletions": 0}
        for index in range(120)
    ]
    fixture = create_team(tmp_path, "phase-respawn-caps", [record])
    state = read_state(fixture.state_path)
    task_record = next(item for item in state["tasks"] if item["id"] == "T1")

    brief = build_phase_respawn_brief(state, fixture.state_path, task_record, "review")

    assert "15 earlier result entries elided" in brief
    assert "result 24" in brief and "result 5" not in brief
    assert "20 more changed files elided" in brief
    assert "src/file_99.py" in brief and "src/file_100.py" not in brief
    # Long prose truncates at the respawn text limit rather than riding whole —
    # and a capped description says so, pointing at the full on-disk card
    # instead of passing as complete.
    assert "D" * 2_000 not in brief
    assert (
        'description truncated — `sprintengine.task.get` with `{taskId: "T1"}` '
        "returns the complete card; read it before working)"
    ) in brief
    # Acceptance criteria now ride the brief (the inline directive references
    # the card instead of re-listing them, and a cold owner has no card yet).
    assert "Acceptance: CLI exposes the feature." in brief


def test_respawn_description_returns_short_briefs_verbatim() -> None:
    # A description that fits the cap is the worker's full operating brief and must
    # pass through untouched — no elision marker, so a revived owner does not read
    # a truncation warning on a complete card.
    from sprintengine_core.tool.phase_prompts import RESPAWN_TEXT_LIMIT, _respawn_description

    short = "Wire the reviewed feature into the real CLI path."
    assert _respawn_description({"id": "T1", "description": short}) == short

    # Exactly at the limit is still "fits" (<=), so it also rides verbatim.
    at_limit = "D" * RESPAWN_TEXT_LIMIT
    result = _respawn_description({"id": "T1", "description": at_limit})
    assert result == at_limit
    assert "description truncated" not in result


def test_respawn_description_marks_truncation_and_names_the_card() -> None:
    # Over the cap, the brief must carry an honest elision marker naming the task
    # id so the owner fetches the complete card instead of working a silently
    # truncated scope. The full body must NOT survive inline.
    from sprintengine_core.tool.phase_prompts import RESPAWN_TEXT_LIMIT, _respawn_description

    body = "D" * (RESPAWN_TEXT_LIMIT + 500)
    result = _respawn_description({"id": "T-cold", "description": body})

    assert body not in result
    assert result.startswith("D" * (RESPAWN_TEXT_LIMIT - 3))
    assert result.count("...") == 1
    assert (
        'description truncated — `sprintengine.task.get` with `{taskId: "T-cold"}` '
        "returns the complete card; read it before working)"
    ) in result


def test_phase_directive_is_composed_from_the_shared_review_base_pack(tmp_path) -> None:
    """The base pack is resolved through the role registry, so a workspace can
    shadow `sprintengine_phase_review` and change the review lens run-wide."""
    from sprintengine_core.tool.phase_prompts import phase_base_pack_skill_id

    assert phase_base_pack_skill_id("review") == "sprintengine_phase_review"

    record = reviewing_task()
    record["status"] = "in_progress"
    fixture = create_team(tmp_path, "phase-base-pack", [record])
    payload = fixture.cli.run(
        "task", "publish", "--task-id", "T1", "--id", "developer-fixture", "--summary", "Ready."
    )

    base_pack = (
        swarm_helpers.REPO_ROOT / "resources" / "sprintengine" / "skills" / "sprintengine_phase_review" / "SKILL.md"
    ).read_text(encoding="utf-8")
    # A distinctive body line from the bundled pack must reach the owner verbatim.
    body_line = next(
        line.strip()
        for line in base_pack.splitlines()
        if line.strip().startswith("- ") and len(line.strip()) > 40
    )
    assert body_line in payload["nextDirective"]


def test_task_next_rework_prompt_references_feedback_without_relisting(tmp_path) -> None:
    """Item 1566: the claim response serializes feedback bodies ONCE — on the task
    card — and the rework prompt names the queue instead of re-listing it. The
    card/raw-task channel keeps the newest-first bodies."""
    record = reviewing_task()
    record["status"] = "todo"
    record["ownerAgentId"] = None
    record["comments"].append({
        "id": "C3",
        "type": "review_feedback",
        "actor": "user",
        "authorAgentId": "user",
        "authorRole": "user",
        "source": "user",
        "body": "Newest feedback should be handled first.",
        "createdAt": "2026-05-17T00:03:00Z",
        "data": {"status": "open"},
    })
    fixture = create_team(tmp_path, "rework-prompt-order", [record])

    payload = fixture.cli.run("task", "next", "--role", "developer", "--id", "developer-fixture")

    assert payload["ok"] is True
    prompt = payload["prompt"]
    assert "openFeedback" in prompt and "newest first" in prompt
    assert "grouped by gate" not in prompt
    assert "### Gate `" not in prompt
    # Bodies are not duplicated into the prompt...
    assert "Newest feedback should be handled first." not in prompt
    assert "Older feedback should be below newer feedback." not in prompt
    # ...they stay on the task payload the same response carries.
    bodies = [comment.get("body") for comment in payload["task"]["comments"]]
    assert "Newest feedback should be handled first." in bodies
    assert "publish with `sprintengine.task.publish`" in prompt


def test_projection_includes_comments_feedback_and_recorded_artifacts(tmp_path) -> None:
    record = reviewing_task()
    fixture = create_team(tmp_path, "projection-review-context", [record])
    state = read_state(fixture.state_path)
    state["artifacts"] = [
        {
            "id": "A1",
            "kind": "code_review",
            "title": "Recorded Review",
            "path": "reviews/recorded.md",
            "status": "recorded",
            "createdBy": "developer-fixture",
            "taskId": "T1",
            "reviewHistory": [],
            "recommendedTasks": [],
            "createdAt": "2026-05-17T00:02:00Z",
            "updatedAt": "2026-05-17T00:02:00Z",
        }
    ]
    write_state(fixture.state_path, state)

    payload = fixture.cli.run("projection")
    projected = next(task for task in payload["tasks"] if task["id"] == "T1")

    assert projected["status"] == "review"
    assert "qualityGates" not in projected
    assert "qualityGateSummary" not in projected
    assert projected["latestComments"][0]["id"] == "C2"
    assert projected["latestOpenFeedback"][0]["body"] == "Older feedback should be below newer feedback."
    assert projected["recordedArtifacts"] == [
        {
            "id": "A1",
            "kind": "code_review",
            "title": "Recorded Review",
            "path": "reviews/recorded.md",
            "createdBy": "developer-fixture",
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
            # Repo-first inspection lives in the Soul layer; the architect
            # coordination prompt adds only the sprint-specific checkpoint.
            "inspect those sources instead of asking the user",
            "## Decision Checkpoint",
            "run your Soul's knowledge-backed discovery loop",
            "A handover without a product intake conversation is incoming context",
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
    assert "No tasks are currently ready for the 'architect' role" in payload["message"]
    assert "prompt" not in payload

    state = read_state(fixture.state_path)
    product_task = state["tasks"][0]
    assert product_task["id"] == "T1"
    assert product_task["role"] == "product"
    assert product_task["status"] == "todo"
    assert product_task["ownerAgentId"] is None


def test_recover_returns_integrity_prompt(tmp_path) -> None:
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
    state_path = tmp_path / ".sprintengine" / "sprintengine" / "handover-prompt" / "run.yaml"
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
    assert state["source"]["path"].endswith(".sprintengine/sprintengine/handover-prompt/handover.md")
    assert state["artifacts"][0]["id"] == "A1"
    assert state["artifacts"][0]["kind"] == "requirements"
    assert state["artifacts"][0]["title"] == "Source Handoff"
    assert state["artifacts"][0]["path"] == state["source"]["path"]
    assert state["artifacts"][0]["status"] == "approved"
    assert state["artifacts"][0]["taskId"] == ""


def test_handover_records_markdown_file_source_metadata(tmp_path) -> None:
    state_path = tmp_path / ".sprintengine" / "sprintengine" / "file-handover" / "run.yaml"
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
    assert state["source"]["path"].endswith(".sprintengine/sprintengine/file-handover/handover.md")
    assert state["source"]["originalPath"].endswith("future-plans/source-plan.md")
    assert state["artifacts"][0]["title"] == "Source Handoff"
    assert state["artifacts"][0]["path"] == state["source"]["path"]
    assert state["artifacts"][0]["status"] == "approved"


def test_product_plan_handover_seeds_reviewable_product_requirements(tmp_path) -> None:
    state_path = tmp_path / ".sprintengine" / "sprintengine" / "product-plan" / "run.yaml"
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
    state_path = tmp_path / ".sprintengine" / "sprintengine" / "backlog-item" / "run.yaml"
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
    state_path = tmp_path / ".sprintengine" / "sprintengine" / "source-bundle" / "run.yaml"
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
    state_path = tmp_path / ".sprintengine" / "sprintengine" / "html-only-source" / "run.yaml"
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
    state_path = tmp_path / ".sprintengine" / "sprintengine" / "html-architect-plan" / "run.yaml"
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
    state_path = tmp_path / ".sprintengine" / "sprintengine" / "unknown-source" / "run.yaml"
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
    state_path = tmp_path / ".sprintengine" / "sprintengine" / "product-plan-no-product" / "run.yaml"
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
    state_path = tmp_path / ".sprintengine" / "sprintengine" / "architect-plan" / "run.yaml"
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
    state_path = tmp_path / ".sprintengine" / "sprintengine" / "idempotent-architect-plan" / "run.yaml"
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
    state_path = tmp_path / ".sprintengine" / "sprintengine" / "idempotent-product-plan" / "run.yaml"
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
    state_path = tmp_path / ".sprintengine" / "sprintengine" / "approved-plan-edit" / "run.yaml"
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
    state_path = tmp_path / ".sprintengine" / "sprintengine" / "ready-plan-edit" / "run.yaml"
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
    state_path = tmp_path / ".sprintengine" / "sprintengine" / "handover-product-note" / "run.yaml"
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


def test_managed_agent_join_composes_the_role_prompt_file(tmp_path) -> None:
    """MC-1827 protection: retiring the CLI join path must not touch the MANAGED
    composition path. `PROMPTS_DIR` + `load_sprintengine_coordination_prompt` are
    what put a role's own prose into every dispatched agent's brief, and a role
    with no file falls back to `generic_role_swarm_prompt` rather than nothing."""
    from sprintengine_mcp import SprintEngineMcpServer
    from sprintengine_core.tool.paths import PROMPTS_DIR
    from sprintengine_core.tool.prompts import (
        generic_role_swarm_prompt,
        load_sprintengine_coordination_prompt,
    )

    role_prose = (PROMPTS_DIR / "developer.md").read_text(encoding="utf-8").strip()
    assert role_prose
    assert role_prose in load_sprintengine_coordination_prompt("developer")

    # A staffed role the registry has no prompt file for still gets a brief.
    assert not (PROMPTS_DIR / "ui_ux_reviewer.md").exists()
    assert "Ui Ux Reviewer" in generic_role_swarm_prompt("ui_ux_reviewer")
    assert generic_role_swarm_prompt("ui_ux_reviewer") in load_sprintengine_coordination_prompt("ui_ux_reviewer")

    fixture = create_team(tmp_path, "managed-join-prose", [task("T1", "Implement", "developer")])
    server = SprintEngineMcpServer(allowed_roots=[tmp_path, swarm_helpers.REPO_ROOT])
    response = server.call_tool(
        "sprintengine.agent.join",
        {
            "statePath": str(fixture.state_path),
            "workspaceRoot": str(swarm_helpers.REPO_ROOT),
            "role": "developer",
            "agentId": "developer-a",
        },
        {"id": "workspace-user", "role": "user", "mcpAuthorized": True},
    )

    assert response["ok"] is True
    assert role_prose in response["result"]["prompt"]


def test_sprint_run_cli_composition_resolves_role_from_workspace_skills(tmp_path) -> None:
    from helpers import write_workspace_role
    from sprintengine_core.tool.prompts import load_prompt

    workspace = tmp_path / "workspace"
    write_workspace_role(
        workspace,
        "developer",
        label="Developer",
        body="Workspace-installed developer identity for {{role}}.",
    )
    prompt = load_prompt(
        "developer",
        workspace_root=workspace,
        knowledge_root_configured=False,
        backlog_sourced=False,
    )
    assert "Workspace-installed developer identity for developer." in prompt
    assert "# Soul Personality And Quality Bar" in prompt


def test_dropped_alias_is_a_named_missing_role_state(tmp_path) -> None:
    from sprintengine_core.role_registry import MissingRoleError
    from sprintengine_core.tool.prompts import load_prompt, load_soul_prompt

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    with pytest.raises(MissingRoleError) as soul_info:
        load_soul_prompt("qa-test", workspace_root=workspace, knowledge_root_configured=False)
    message = str(soul_info.value)
    assert "qa-test" in message
    assert "no skill declaring it is installed in this workspace" in message
    assert "Install the workflow-roles pack from the SprintEngine Studio skill source" in message
    assert "add a role skill to your skills folder" in message
    # The brief is not a substitute identity: composition raises rather than
    # returning None and continuing with norms only.
    with pytest.raises(MissingRoleError) as prompt_info:
        load_prompt("qa-test", workspace_root=workspace, knowledge_root_configured=False)
    assert "qa-test" in str(prompt_info.value)


def test_join_names_the_spelling_that_failed_for_a_dropped_alias(tmp_path) -> None:
    fixture = create_team(tmp_path, "dropped-alias-join", [task("T1", "Work", "developer")])
    rejected = fixture.cli.run_failure("join", "--role", "qa-test", "--id", "qa-1")
    assert "qa-test" in rejected.stderr
    assert "no skill declaring it is installed" in rejected.stderr
    assert "workflow-roles" in rejected.stderr
