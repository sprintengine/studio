from __future__ import annotations

from fixtures import SwarmCli, assert_prompt_includes, create_team, task


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
            "Then follow the returned prompt.",
        ],
    )
