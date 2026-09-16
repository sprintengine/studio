from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from helpers import REPO_ROOT
from sprintengine_core.role_registry import (
    NO_WORKFLOW_ROLES_INSTALLED,
    MissingRoleError,
    discover_role_registry,
)
from sprintengine_core.tool.prompts import load_roleless_soul_prompt, load_soul_prompt
from sprintengine_mcp import SprintEngineMcpServer
from workflow_roles import WORKFLOW_ROLE_IDS, install_workflow_roles


@pytest.fixture(autouse=True)
def _empty_role_pack(empty_role_pack: None) -> None:
    return None


def _run(args: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    command = (
        [sys.executable, str(REPO_ROOT / "scripts" / "sprintengine_tool.py"), *args]
        if os.name == "nt"
        else [str(REPO_ROOT / "scripts" / "sprintengine"), *args]
    )
    return subprocess.run(
        command,
        cwd=cwd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def test_roles_list_from_an_empty_workspace_is_empty_and_names_the_remedies(tmp_path: Path) -> None:
    workspace = tmp_path / "empty"
    workspace.mkdir()
    completed = _run(["roles", "list"], workspace)
    assert completed.returncode == 0, completed.stderr
    payload = json.loads(completed.stdout)
    assert payload["ok"] is True
    assert payload["roles"] == []
    assert NO_WORKFLOW_ROLES_INSTALLED in completed.stderr
    assert "Add from folder…" in completed.stderr
    assert "Install skill" in completed.stderr


def test_roles_brief_from_an_empty_workspace_is_nonzero_and_names_the_role(tmp_path: Path) -> None:
    workspace = tmp_path / "empty"
    workspace.mkdir()
    completed = _run(["roles", "brief", "architect"], workspace)
    assert completed.returncode != 0
    assert "Unknown role 'architect'" in completed.stderr
    assert "no workflow roles are installed in this workspace" in completed.stderr
    assert "Add from folder…" in completed.stderr
    assert "Install skill" in completed.stderr
    assert "Known roles" not in completed.stderr


def test_mcp_roles_brief_from_an_empty_workspace_is_unknown_role(tmp_path: Path) -> None:
    workspace = tmp_path / "empty"
    workspace.mkdir()
    server = SprintEngineMcpServer(allowed_roots=[tmp_path])
    actor = {"id": "workspace-user", "role": "user", "mcpAuthorized": True}
    listed = server.call_tool(
        "sprintengine.roles.list",
        {"workspaceRoot": str(workspace)},
        actor,
    )
    assert listed["ok"] is True
    assert listed["result"]["roles"] == []
    for tool_name in ("sprintengine.roles.brief", "sprintengine.soul.get"):
        result = server.call_tool(
            tool_name,
            {"workspaceRoot": str(workspace), "roleId": "architect"},
            actor,
        )
        assert result["ok"] is False
        assert result["error"]["code"] == "unknown_role"
        assert "no workflow roles are installed in this workspace" in result["error"]["message"]
        assert "Add from folder…" in result["error"]["message"]
        assert "Install skill" in result["error"]["message"]
        assert "Known roles" not in result["error"]["message"]


def test_soul_get_from_an_empty_workspace_is_nonzero(tmp_path: Path) -> None:
    workspace = tmp_path / "empty"
    workspace.mkdir()
    completed = _run(["soul", "get", "architect"], workspace)
    assert completed.returncode != 0
    assert "no workflow roles are installed in this workspace" in completed.stderr


def test_no_composed_brief_contains_a_role_body_when_zero_roles_are_installed(tmp_path: Path) -> None:
    workspace = tmp_path / "empty"
    workspace.mkdir()
    discovery = discover_role_registry(workspace_root=workspace)
    assert discovery.roles == {}
    with pytest.raises(MissingRoleError):
        load_soul_prompt("architect", workspace_root=workspace)
    with pytest.raises(MissingRoleError):
        load_soul_prompt("developer", workspace_root=workspace)
    roleless = load_roleless_soul_prompt(workspace_root=workspace)
    assert roleless is not None
    assert "principal software engineer" not in roleless
    assert "principal-level specification-conformance reviewer" not in roleless


def test_installing_the_pack_resolves_all_sixteen(tmp_path: Path) -> None:
    workspace = install_workflow_roles(tmp_path / "workspace")
    listed = _run(["roles", "list"], workspace)
    assert listed.returncode == 0, listed.stderr
    payload = json.loads(listed.stdout)
    ids = {entry["id"] for entry in payload["roles"]}
    assert ids == WORKFLOW_ROLE_IDS
    assert all(entry["source"]["layer"] == "workspace" for entry in payload["roles"])
    brief = _run(["roles", "brief", "architect"], workspace)
    assert brief.returncode == 0, brief.stderr
