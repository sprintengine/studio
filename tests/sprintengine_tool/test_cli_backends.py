from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from helpers import REPO_ROOT, create_team, create_workspace_team, get_task, read_state, task, write_state, write_workspace_role
from sprintengine_core.role_registry import SOUL_GET_CLI_DEPRECATED, SOUL_GET_REMOVAL_RELEASE

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


def run_swarm_in_cwd(args: list[str], cwd: Path, *, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    merged_env = os.environ.copy()
    merged_env.pop(MCP_USER_ID_ENV, None)
    merged_env.pop(MCP_USER_AUTHORIZED_ENV, None)
    if env:
        merged_env.update(env)
    return subprocess.run(
        _swarm_command_without_state(args),
        cwd=cwd,
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
    state_path = tmp_path / ".sprintengine" / "sprintengine" / "uninitialized" / "run.yaml"
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


def test_mcp_backend_join_preserves_cli_directive_shape(tmp_path) -> None:
    fixture = create_team(tmp_path, "cli-mcp-join", [task("T1", "Join route", "developer")])

    completed = run_swarm(
        [
            "--backend",
            "mcp-local",
            "--state",
            str(fixture.state_path),
            "join",
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
    assert payload["action"] == "work"
    assert payload["readyTaskCount"] == 1
    assert "sprintengine task next --role developer --id developer-a" in payload["prompt"]
    rows = audit_rows(fixture.team_dir)
    assert [row["operation_name"] for row in rows] == ["sprintengine.join"]


def test_plan_add_task_records_no_gate_configuration(tmp_path) -> None:
    """MC-1542: roster-driven gates, `qualityPolicy`, and `--require-gate` are gone.
    A task's only review lever is its `phases` list."""
    fixture = create_team(tmp_path, "cli-plan-no-gates", [])
    state = read_state(fixture.state_path)
    state["sprintengine"]["rosterConfigured"] = True
    state["agents"] = {
        "developer-1": {"id": "developer-1", "role": "developer", "status": "idle"},
        "nuclear-reviewer-1": {"id": "nuclear-reviewer-1", "role": "security", "status": "idle"},
    }
    write_state(fixture.state_path, state)

    payload = fixture.cli.run(
        "plan",
        "add-task",
        "--title",
        "Implement routed work",
        "--role",
        "developer",
        "--path",
        "sprintengine_core/tool/prompts.py",
        "--acceptance",
        "Implementation publishes through real Sprint Engine paths.",
    )

    # A rostered reviewer no longer attaches a gate to somebody else's task.
    assert "qualityGates" not in payload["task"]
    assert "phases" not in payload["task"]  # inherits the run default


def test_plan_add_task_rejects_the_retired_gate_flags(tmp_path) -> None:
    fixture = create_team(tmp_path, "cli-plan-retired-flags", [])
    state = read_state(fixture.state_path)
    state["sprintengine"]["rosterConfigured"] = True
    state["agents"] = {"developer-1": {"id": "developer-1", "role": "developer", "status": "idle"}}
    write_state(fixture.state_path, state)

    for flag, value in (
        ("--no-quality-gates", None),
        ("--require-gate", "security"),
        ("--skip-gate", "security"),
        ("--no-review", None),
        ("--no-testing", None),
        ("--no-product-acceptance", None),
    ):
        args = ["plan", "add-task", "--title", "Work", "--role", "developer", flag]
        if value is not None:
            args.append(value)
        rejected = fixture.cli.run_failure(*args)
        assert "unrecognized arguments" in rejected.stderr, flag


def test_custom_workspace_role_resolves_through_the_cli(tmp_path) -> None:
    """A workspace-layer role manifest resolves for CLI role validation."""
    from sprintengine_core.role_registry import discover_role_registry

    workspace = tmp_path / "workspace"
    write_workspace_role(workspace, "creative_director")
    fixture = create_workspace_team(tmp_path, "workspace", "cli-custom-role", [])
    state = read_state(fixture.state_path)
    state["sprintengine"]["rosterConfigured"] = True
    state["agents"] = {
        "developer-1": {"id": "developer-1", "role": "developer", "status": "idle"},
        "creative-director-1": {"id": "creative-director-1", "role": "creative_director", "status": "idle"},
    }
    write_state(fixture.state_path, state)

    manifest = discover_role_registry(workspace_root=workspace).get_role("creative_director")
    assert manifest.id == "creative_director"

    payload = fixture.cli.run(
        "plan",
        "add-task",
        "--title",
        "Implement campaign page",
        "--role",
        "developer",
        "--path",
        "src/renderer/src/campaign.tsx",
    )
    assert "qualityGates" not in payload["task"]


def test_registry_inspection_commands_work_from_repo_root() -> None:
    roles = parse_stdout_json(run_swarm(["roles", "list", "--include-shadowed"]))
    role = parse_stdout_json(run_swarm(["role", "get", "tester"]))
    soul = parse_stdout_json(run_swarm(["soul", "get", "tester", "--run-id", "registry-cli-test"]))
    skills = parse_stdout_json(run_swarm(["skill", "list"]))
    skill = parse_stdout_json(run_swarm(["skill", "get", "tester"]))

    assert roles["ok"] is True
    assert any(entry["id"] == "tester" and entry["source"]["layer"] == "bundled" for entry in roles["roles"])
    assert role["role"]["id"] == "tester"
    assert role["role"]["source"]["layer"] == "bundled"
    assert "shadowedSources" in role["role"]
    assert soul["role"]["id"] == "tester"
    assert "principal QA engineer" in soul["soul"]["content"]
    assert {entry["id"] for entry in skills["skills"]} >= {"developer", "tester"}
    assert all("body" not in entry for entry in skills["skills"])
    assert skill["skill"]["id"] == "tester"
    assert "body" in skill["skill"]


def test_registry_inspection_commands_work_from_custom_workspace(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    write_workspace_role(workspace, "marketer")

    roles = parse_stdout_json(run_swarm_in_cwd(["roles", "list"], workspace))
    role = parse_stdout_json(run_swarm_in_cwd(["role", "get", "marketer"], workspace))
    soul = parse_stdout_json(run_swarm_in_cwd(["soul", "get", "marketer", "--run-id", "custom-run"], workspace))
    skills = parse_stdout_json(run_swarm_in_cwd(["skill", "list"], workspace))
    skill = parse_stdout_json(run_swarm_in_cwd(["skill", "get", "marketer"], workspace))

    assert any(entry["id"] == "marketer" and entry["source"]["layer"] == "workspace" for entry in roles["roles"])
    assert role["role"]["id"] == "marketer"
    assert role["role"]["source"]["layer"] == "workspace"
    assert soul["role"]["id"] == "marketer"
    assert "Temporary test role." in soul["soul"]["content"]
    assert any(entry["id"] == "marketer" and entry["source"]["layer"] == "workspace" for entry in skills["skills"])
    assert skill["skill"]["source"]["layer"] == "workspace"


def test_registry_inspection_extra_dir_is_accepted_and_ignored(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    write_workspace_role(workspace, "marketer")
    write_workspace_role(workspace, "plugin_writer", label="Plugin Writer", body="# Plugin writer\n")

    roles = parse_stdout_json(run_swarm_in_cwd(["roles", "list", "--include-shadowed", "--extra-dir", str(tmp_path / "ignored")], workspace))
    role = parse_stdout_json(run_swarm_in_cwd(["role", "get", "plugin-writer", "--extra-dir", str(tmp_path / "ignored")], workspace))
    skills = parse_stdout_json(run_swarm_in_cwd(["skill", "list", "--extra-dir", str(tmp_path / "ignored")], workspace))

    assert any(entry["id"] == "plugin_writer" and entry["source"]["layer"] == "workspace" for entry in roles["roles"])
    assert role["role"]["id"] == "plugin_writer"
    assert any(entry["id"] == "plugin_writer" and entry["source"]["layer"] == "workspace" for entry in skills["skills"])


def test_registry_inspection_unknown_role_and_skill_errors_include_known_ids() -> None:
    role = run_swarm(["role", "get", "not-a-role"])
    skill = run_swarm(["skill", "get", "not-a-skill"])

    assert role.returncode != 0
    assert "Unknown role 'not-a-role'" in role.stderr
    assert "Known roles:" in role.stderr
    assert "developer" in role.stderr
    assert skill.returncode != 0
    assert "Unknown registry skill: not-a-skill." in skill.stderr
    assert "Known skills:" in skill.stderr
    assert "developer" in skill.stderr


def test_mcp_backend_registry_inspection_commands_work_from_custom_workspace(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    write_workspace_role(workspace, "marketer")
    env = {
        "SPRINTENGINE_MCP_ALLOWED_ROOT": str(tmp_path),
        MCP_USER_ID_ENV: "workspace-user",
        MCP_USER_AUTHORIZED_ENV: "1",
    }

    roles = parse_stdout_json(run_swarm_in_cwd(["--backend", "mcp-local", "roles", "list"], workspace, env=env))
    role = parse_stdout_json(run_swarm_in_cwd(["--backend", "mcp-local", "role", "get", "marketer"], workspace, env=env))
    brief = parse_stdout_json(run_swarm_in_cwd(["--backend", "mcp-local", "roles", "brief", "marketer"], workspace, env=env))
    soul = parse_stdout_json(run_swarm_in_cwd(["--backend", "mcp-local", "soul", "get", "marketer"], workspace, env=env))
    skills = parse_stdout_json(run_swarm_in_cwd(["--backend", "mcp-local", "skill", "list"], workspace, env=env))
    skill = parse_stdout_json(run_swarm_in_cwd(["--backend", "mcp-local", "skill", "get", "marketer"], workspace, env=env))

    assert any(entry["id"] == "marketer" and entry["source"]["layer"] == "workspace" for entry in roles["roles"])
    assert role["role"]["id"] == "marketer"
    assert brief["role"]["id"] == "marketer"
    assert brief["soul"]["content"] == soul["soul"]["content"]
    assert soul["role"]["id"] == "marketer"
    assert "deprecated" in soul
    assert any(entry["id"] == "marketer" for entry in skills["skills"])
    assert skill["skill"]["id"] == "marketer"


def test_mcp_backend_soul_get_unknown_role_error_includes_known_ids() -> None:
    env = {
        MCP_USER_ID_ENV: "workspace-user",
        MCP_USER_AUTHORIZED_ENV: "1",
    }

    soul = run_swarm(["--backend", "mcp-local", "soul", "get", "not-a-role"], env=env)

    assert soul.returncode != 0
    assert "unknown_role" in soul.stderr
    assert "Unknown role 'not-a-role'" in soul.stderr
    assert "Known roles:" in soul.stderr
    assert "developer" in soul.stderr


def test_sprintengine_roles_brief_matches_soul_get_and_warns_deprecated() -> None:
    brief = run_swarm(["roles", "brief", "architect"])
    soul = run_swarm(["soul", "get", "architect"])

    assert brief.returncode == 0, brief.stderr
    assert soul.returncode == 0, soul.stderr
    assert brief.stdout == soul.stdout
    assert SOUL_GET_CLI_DEPRECATED in soul.stderr
    assert SOUL_GET_REMOVAL_RELEASE in soul.stderr
    assert SOUL_GET_CLI_DEPRECATED not in brief.stderr
    payload = json.loads(brief.stdout)
    assert payload["ok"] is True
    assert payload["role"]["id"] == "architect"
    assert payload["soul"]["content"]


def test_sprintengine_roles_brief_resolves_either_spelling_and_rejects_dropped_alias() -> None:
    hyphen = parse_stdout_json(run_swarm(["roles", "brief", "spec-reviewer"]))
    underscore = parse_stdout_json(run_swarm(["soul", "get", "spec_reviewer"]))
    assert hyphen["soul"]["content"] == underscore["soul"]["content"]
    assert hyphen["role"]["id"] == "spec_reviewer"

    missing_brief = run_swarm(["roles", "brief", "qa-test"])
    missing_soul = run_swarm(["soul", "get", "qa-test"])
    assert missing_brief.returncode != 0
    assert missing_soul.returncode != 0
    assert "Unknown role 'qa-test'" in missing_brief.stderr
    assert "Unknown role 'qa-test'" in missing_soul.stderr
    assert "no skill declaring it is installed" in missing_brief.stderr
    assert SOUL_GET_CLI_DEPRECATED in missing_soul.stderr


def test_mcp_backend_task_advance_uses_the_advance_lifecycle_tool(tmp_path) -> None:
    task_record = task("T1", "Reviewable", "developer", "review", owner="developer-a")
    task_record["startedAt"] = "2026-07-08T00:00:00Z"
    fixture = create_team(tmp_path, "cli-mcp-advance", [task_record])

    completed = run_swarm(
        [
            "--backend",
            "mcp-local",
            "--state",
            str(fixture.state_path),
            "task",
            "advance",
            "--task-id",
            "T1",
            "--id",
            "developer-a",
            "--phase",
            "review",
            "--outcome",
            "pass",
            "--summary",
            "Self-reviewed.",
        ],
        env={
            "SPRINTENGINE_MCP_ALLOWED_ROOT": str(tmp_path),
            MCP_USER_ID_ENV: "workspace-user",
            MCP_USER_AUTHORIZED_ENV: "1",
        },
    )

    payload = parse_stdout_json(completed)
    assert payload["ok"] is True
    assert payload["phase"] == "review"
    assert payload["nextStatus"] == "done"
    rows = audit_rows(fixture.team_dir)
    assert [row["operation_name"] for row in rows] == ["sprintengine.task.advance"]


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


def test_top_level_help_documents_mcp_lifecycle_and_cross_platform_wrappers() -> None:
    completed = run_swarm(["--help"])

    assert completed.returncode == 0
    assert "MCP lifecycle compatibility:" in completed.stdout
    assert "sprintengine --backend mcp-local join --role developer --id developer-1" in completed.stdout
    assert "scripts/sprintengine --help" in completed.stdout
    assert "scripts\\sprintengine.cmd --help" in completed.stdout
    assert '.\\.venv\\Scripts\\python.exe" ".\\scripts\\sprintengine_tool.py" --help' in completed.stdout


def test_wrapper_scripts_preserve_python_fallbacks() -> None:
    posix_wrapper = (REPO_ROOT / "scripts" / "sprintengine").read_text(encoding="utf-8")
    windows_wrapper = (REPO_ROOT / "scripts" / "sprintengine.cmd").read_text(encoding="utf-8")

    assert '.venv/bin/python" "$SCRIPT_DIR/sprintengine_tool.py"' in posix_wrapper
    assert '.venv/Scripts/python.exe" "$SCRIPT_DIR/sprintengine_tool.py"' in posix_wrapper
    assert 'python3 "$SCRIPT_DIR/sprintengine_tool.py"' in posix_wrapper
    assert r".venv\Scripts\python.exe" in windows_wrapper
    assert 'py -3 "%TOOL_PATH%" %*' in windows_wrapper
    assert 'python "%TOOL_PATH%" %*' in windows_wrapper


def test_mcp_backend_errors_disclose_backend_mode_for_unsupported_command(tmp_path) -> None:
    handover = tmp_path / "handover.md"
    handover.write_text("handover", encoding="utf-8")

    completed = run_swarm(
        [
            "--backend",
            "mcp-local",
            "--state",
            str(tmp_path / ".sprintengine" / "sprintengine" / "run.yaml"),
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
