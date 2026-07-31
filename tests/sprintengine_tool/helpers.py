from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sprintengine_core import store as folder_store


REPO_ROOT = Path(__file__).resolve().parents[2]
SPRINTENGINE_COMMAND = REPO_ROOT / "scripts" / "sprintengine"
SPRINTENGINE_TOOL = REPO_ROOT / "scripts" / "sprintengine_tool.py"
REAL_REPO_SPRINTENGINE_ROOT = (REPO_ROOT / "sprintengine").resolve()


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def assert_disposable_state_path(state_path: Path) -> None:
    resolved = state_path.resolve()
    if resolved.name != "run.yaml":
        raise AssertionError(f"SprintEngine fixture run path must be named run.yaml: {state_path}")
    if _is_relative_to(resolved, REAL_REPO_SPRINTENGINE_ROOT):
        raise AssertionError(f"Refusing to run harness against real repo Sprint Engine state: {state_path}")


def parse_cli_json(stdout: str, command: list[str]) -> dict[str, Any]:
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise AssertionError(
            "SprintEngine command did not return JSON.\n"
            f"command: {' '.join(command)}\n"
            f"stdout:\n{stdout}"
        ) from exc
    if not isinstance(payload, dict):
        raise AssertionError(f"SprintEngine command returned non-object JSON: {payload!r}")
    return payload


def swarm_command(state_path: Path, args: tuple[str, ...]) -> list[str]:
    if os.name == "nt":
        return [sys.executable, str(SPRINTENGINE_TOOL), "--state", str(state_path), *args]
    return [str(SPRINTENGINE_COMMAND), "--state", str(state_path), *args]


@dataclass(frozen=True)
class SwarmCli:
    state_path: Path
    cwd: Path = REPO_ROOT

    def run(self, *args: str) -> dict[str, Any]:
        assert_disposable_state_path(self.state_path)
        command = swarm_command(self.state_path, args)
        completed = subprocess.run(
            command,
            cwd=self.cwd,
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
        return parse_cli_json(completed.stdout, command)

    def run_failure(self, *args: str) -> subprocess.CompletedProcess[str]:
        assert_disposable_state_path(self.state_path)
        command = swarm_command(self.state_path, args)
        completed = subprocess.run(
            command,
            cwd=self.cwd,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if completed.returncode == 0:
            raise AssertionError(f"SprintEngine command unexpectedly passed: {' '.join(command)}")
        return completed


@dataclass(frozen=True)
class SwarmTeamFixture:
    team_dir: Path
    state_path: Path
    cli: SwarmCli


def task(
    task_id: str,
    title: str,
    role: str | None = None,
    status: str = "todo",
    depends_on: list[str] | None = None,
    owner: str | None = None,
    owned_paths: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "id": task_id,
        "title": title,
        "description": title,
        # Absent role is an OMITTED key (MC-2057), never '' or null, so fixtures
        # exercise the same wire shape a roleless run actually persists.
        **({"role": role} if role else {}),
        "status": status,
        "ownerAgentId": owner,
        "dependsOn": depends_on or [],
        "ownedPaths": owned_paths or [],
        "acceptanceCriteria": [],
        "implementationNotes": [],
        "evidence": {"summary": "", "touchedFiles": [], "commandsRan": [], "results": [], "scopeExpansions": []},
        "notes": [],
        "startedAt": None,
        "completedAt": None,
    }


def base_state(name: str, tasks: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "sprintengine": {"name": name, "goal": f"Fixture sprintengine {name}", "status": "executing"},
        "tasks": tasks,
        "agents": {},
        "events": [],
        "artifacts": [],
        "roles": {},
    }


def write_state(state_path: Path, state: dict[str, Any]) -> None:
    assert_disposable_state_path(state_path)
    folder_store.sync_state_to_store(state_path.parent, state, state_path=state_path)


def read_state(state_path: Path) -> dict[str, Any]:
    assert_disposable_state_path(state_path)
    return folder_store.state_from_folder_store(state_path.parent)


def create_team(tmp_path: Path, name: str, tasks: list[dict[str, Any]]) -> SwarmTeamFixture:
    team_dir = tmp_path / ".multi-code" / "sprintengine" / name
    state_path = team_dir / "run.yaml"
    write_state(state_path, base_state(name, tasks))
    return SwarmTeamFixture(team_dir=team_dir, state_path=state_path, cli=SwarmCli(state_path))


def create_workspace_team(tmp_path: Path, workspace_name: str, name: str, tasks: list[dict[str, Any]]) -> SwarmTeamFixture:
    workspace = tmp_path / workspace_name
    team_dir = workspace / ".multi-code" / "sprintengine" / name
    state_path = team_dir / "run.yaml"
    write_state(state_path, base_state(name, tasks))
    return SwarmTeamFixture(team_dir=team_dir, state_path=state_path, cli=SwarmCli(state_path, cwd=workspace))


def write_workspace_role(
    workspace: Path,
    role_id: str,
    *,
    aliases: list[str] | None = None,
    label: str | None = None,
    description: str | None = None,
    review_skill: str | None = None,
) -> None:
    """Write a v2 workspace-layer role manifest plus its implement skill.

    `review_skill` adds a role-scoped `directives.review` pack (the caller writes
    that skill itself).
    """
    root = workspace / ".sprintengine"
    roles_dir = root / "roles"
    skill_dir = root / "skills" / role_id
    roles_dir.mkdir(parents=True, exist_ok=True)
    skill_dir.mkdir(parents=True, exist_ok=True)
    directives: dict[str, Any] = {"implement": [{"skill": role_id}]}
    if review_skill is not None:
        directives["review"] = [{"skill": review_skill}]
    payload: dict[str, Any] = {
        "id": role_id,
        "label": label or role_id.replace("_", " ").title(),
        "aliases": aliases or [],
        "directives": directives,
    }
    if description is not None:
        payload["description"] = description
    (roles_dir / f"{role_id}.json").write_text(json.dumps(payload), encoding="utf-8")
    (skill_dir / "SKILL.md").write_text(f"# {role_id}\n\nTemporary test role.", encoding="utf-8")


def get_task(state: dict[str, Any], task_id: str) -> dict[str, Any]:
    for candidate in state["tasks"]:
        if candidate["id"] == task_id:
            return candidate
    raise AssertionError(f"Missing task {task_id}")


def get_artifact(state: dict[str, Any], artifact_id: str) -> dict[str, Any]:
    for candidate in state["artifacts"]:
        if candidate["id"] == artifact_id:
            return candidate
    raise AssertionError(f"Missing artifact {artifact_id}")


def dependencies_done(task_record: dict[str, Any], tasks: list[dict[str, Any]]) -> bool:
    return all(
        any(candidate["id"] == dependency_id and candidate["status"] == "done" for candidate in tasks)
        for dependency_id in task_record["dependsOn"]
    )


def derived_board_column(task_record: dict[str, Any], tasks: list[dict[str, Any]]) -> str:
    if task_record["status"] in {"in_progress", "review", "testing", "needs_input", "done"}:
        return task_record["status"]
    dispatch = task_record.get("dispatch")
    if isinstance(dispatch, dict) and dispatch.get("mode") == "manual" and dispatch.get("status") != "ready":
        return "todo"
    return "ready" if dependencies_done(task_record, tasks) else "todo"


def assert_task_status(state: dict[str, Any], task_id: str, expected: str) -> None:
    actual = get_task(state, task_id)["status"]
    assert actual == expected


def assert_board_column(state: dict[str, Any], task_id: str, expected: str) -> None:
    actual = derived_board_column(get_task(state, task_id), state["tasks"])
    assert actual == expected


def assert_artifact_status(state: dict[str, Any], artifact_id: str, expected: str) -> None:
    actual = get_artifact(state, artifact_id)["status"]
    assert actual == expected


def assert_event_type(state: dict[str, Any], event_type: str) -> None:
    assert any(event.get("type") == event_type for event in state["events"])


def assert_ready_tasks(cli: SwarmCli, role: str, expected_ids: list[str]) -> None:
    payload = cli.run("task", "list", "--role", role)
    assert payload["ok"] is True
    assert [entry["id"] for entry in payload["readyTasks"]] == expected_ids


def read_feedback_records(team_dir: Path) -> list[dict[str, Any]]:
    metrics_path = team_dir / "metrics" / "agent-feedback.jsonl"
    if not metrics_path.exists():
        return []
    return [
        json.loads(line)
        for line in metrics_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def assert_feedback_record(team_dir: Path, task_id: str, agent_id: str) -> dict[str, Any]:
    for record in read_feedback_records(team_dir):
        if record.get("task_id") == task_id and record.get("agent_id") == agent_id:
            return record
    raise AssertionError(f"Missing feedback record for task {task_id} by {agent_id}")
