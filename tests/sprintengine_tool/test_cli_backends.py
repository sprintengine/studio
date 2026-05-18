from __future__ import annotations

import json
import os
import subprocess
import sys

from helpers import REPO_ROOT, create_team, get_task, read_state, task

MCP_USER_ID_ENV = "SPRINTENGINE_MCP_USER_ID"
MCP_USER_AUTHORIZED_ENV = "SPRINTENGINE_MCP_USER_AUTHORIZED"


def run_swarm(args: list[str], *, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    merged_env = os.environ.copy()
    merged_env.pop(MCP_USER_ID_ENV, None)
    merged_env.pop(MCP_USER_AUTHORIZED_ENV, None)
    if env:
        merged_env.update(env)
    return subprocess.run(
        _swarm_command_without_state(args),
        cwd=REPO_ROOT,
        env=merged_env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def _swarm_command_without_state(args: list[str]) -> list[str]:
    if os.name == "nt":
        return [sys.executable, str(REPO_ROOT / "scripts" / "sprintengine_tool.py"), *args]
    return [str(REPO_ROOT / "scripts" / "sprintengine"), *args]


def parse_stdout_json(completed: subprocess.CompletedProcess[str]) -> dict:
    assert completed.returncode == 0, completed.stderr
    return json.loads(completed.stdout)


def audit_rows(team_dir):
    path = team_dir / "metrics" / "audit-events.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def test_direct_core_backend_is_default_and_preserves_cli_json_shape(tmp_path) -> None:
    fixture = create_team(tmp_path, "cli-direct-default", [task("T1", "Default route", "developer")])

    completed = run_swarm(["--state", str(fixture.state_path), "task", "next", "--role", "developer", "--id", "developer-a"])

    payload = parse_stdout_json(completed)
    assert payload["ok"] is True
    assert payload["task"]["id"] == "T1"
    assert "tool" not in payload
    assert audit_rows(fixture.team_dir) == []


def test_direct_core_rejects_uninitialized_run_store(tmp_path) -> None:
    state_path = tmp_path / ".multi-code" / "sprintengine" / "uninitialized" / "run.yaml"
    state_path.parent.mkdir(parents=True)
    state_path.write_text("not: a run store\n", encoding="utf-8")

    completed = run_swarm(["--state", str(state_path), "task", "list", "--role", "developer"])

    assert completed.returncode != 0
    assert "folder store is not initialized" in completed.stderr


def test_explicit_mcp_backend_preserves_success_shape_and_emits_audit(tmp_path) -> None:
    fixture = create_team(tmp_path, "cli-mcp-backend", [task("T1", "MCP route", "developer")])

    completed = run_swarm(
        [
            "--backend",
            "mcp-local",
            "--state",
            str(fixture.state_path),
            "task",
            "next",
            "--role",
            "developer",
            "--id",
            "developer-a",
        ],
        env={
            "SPRINTENGINE_MCP_ALLOWED_ROOT": str(tmp_path),
            MCP_USER_ID_ENV: "workspace-user",
            MCP_USER_AUTHORIZED_ENV: "1",
        },
    )

    payload = parse_stdout_json(completed)
    assert payload["ok"] is True
    assert payload["task"]["id"] == "T1"
    assert "tool" not in payload
    state = read_state(fixture.state_path)
    assert get_task(state, "T1")["ownerAgentId"] == "developer-a"
    rows = audit_rows(fixture.team_dir)
    assert [row["operation_name"] for row in rows] == ["sprintengine.task.next"]
    assert rows[0]["backend_mode"] == "mcp-local"


def test_explicit_mcp_backend_rejects_missing_user_id(tmp_path) -> None:
    fixture = create_team(tmp_path, "cli-mcp-missing-user", [task("T1", "MCP missing user", "developer")])

    completed = run_swarm(
        [
            "--backend",
            "mcp-local",
            "--state",
            str(fixture.state_path),
            "task",
            "list",
            "--role",
            "developer",
        ],
        env={"SPRINTENGINE_MCP_ALLOWED_ROOT": str(tmp_path), MCP_USER_AUTHORIZED_ENV: "1"},
    )

    assert completed.returncode != 0
    assert "backend mode mcp-local returned unauthorized" in completed.stderr


def test_explicit_mcp_backend_rejects_missing_authorization_flag(tmp_path) -> None:
    fixture = create_team(tmp_path, "cli-mcp-missing-auth", [task("T1", "MCP missing auth", "developer")])

    completed = run_swarm(
        [
            "--backend",
            "mcp-local",
            "--state",
            str(fixture.state_path),
            "task",
            "list",
            "--role",
            "developer",
        ],
        env={"SPRINTENGINE_MCP_ALLOWED_ROOT": str(tmp_path), MCP_USER_ID_ENV: "workspace-user"},
    )

    assert completed.returncode != 0
    assert "backend mode mcp-local returned unauthorized" in completed.stderr


def test_explicit_mcp_backend_rejects_false_authorization_flag(tmp_path) -> None:
    fixture = create_team(tmp_path, "cli-mcp-false-auth", [task("T1", "MCP false auth", "developer")])

    completed = run_swarm(
        [
            "--backend",
            "mcp-local",
            "--state",
            str(fixture.state_path),
            "task",
            "list",
            "--role",
            "developer",
        ],
        env={
            "SPRINTENGINE_MCP_ALLOWED_ROOT": str(tmp_path),
            MCP_USER_ID_ENV: "workspace-user",
            MCP_USER_AUTHORIZED_ENV: "false",
        },
    )

    assert completed.returncode != 0
    assert "backend mode mcp-local returned unauthorized" in completed.stderr


def test_mcp_backend_can_be_selected_from_environment(tmp_path) -> None:
    fixture = create_team(tmp_path, "cli-mcp-env", [task("T1", "MCP env route", "developer")])

    completed = run_swarm(
        ["--state", str(fixture.state_path), "task", "list", "--role", "developer"],
        env={
            "SPRINTENGINE_BACKEND": "mcp-local",
            "SPRINTENGINE_MCP_ALLOWED_ROOT": str(tmp_path),
            MCP_USER_ID_ENV: "workspace-user",
            MCP_USER_AUTHORIZED_ENV: "true",
        },
    )

    payload = parse_stdout_json(completed)
    assert payload["ok"] is True
    assert [record["id"] for record in payload["readyTasks"]] == ["T1"]


def test_help_discloses_selected_backend_mode(tmp_path) -> None:
    fixture = create_team(tmp_path, "cli-help-backend", [task("T1", "Help", "developer")])

    completed = run_swarm(
        ["--backend", "mcp-local", "--state", str(fixture.state_path), "task", "next", "--help"],
        env={"SPRINTENGINE_MCP_ALLOWED_ROOT": str(tmp_path)},
    )

    assert completed.returncode == 0
    assert "usage:" in completed.stdout
    assert "backend mode: mcp-local" in completed.stderr


def test_mcp_backend_errors_disclose_backend_mode_for_unsupported_command(tmp_path) -> None:
    handover = tmp_path / "handover.md"
    handover.write_text("handover", encoding="utf-8")

    completed = run_swarm(
        [
            "--backend",
            "mcp-local",
            "--state",
            str(tmp_path / ".multi-code" / "sprintengine" / "run.yaml"),
            "handover",
            "--name",
            "unsupported",
            "--handover",
            str(handover),
        ],
        env={"SPRINTENGINE_MCP_ALLOWED_ROOT": str(tmp_path)},
    )

    assert completed.returncode != 0
    assert "backend mode mcp-local" in completed.stderr
    assert "Use --backend direct-core" in completed.stderr


def test_mcp_backend_does_not_silently_remap_unsupported_plan_list(tmp_path) -> None:
    fixture = create_team(tmp_path, "cli-mcp-plan-list", [task("T1", "Plan list", "developer")])

    completed = run_swarm(
        ["--backend", "mcp-local", "--state", str(fixture.state_path), "plan", "list"],
        env={"SPRINTENGINE_MCP_ALLOWED_ROOT": str(tmp_path)},
    )

    assert completed.returncode != 0
    assert "backend mode mcp-local" in completed.stderr
    assert "plan action: list" in completed.stderr
