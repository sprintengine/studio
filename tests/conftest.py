"""Shared test setup for the Python suites.

Workflow roles are workspace skills. Suites that need the shipped sixteen
install them into a temp workspace via ``workflow_roles_workspace`` — the same
``.claude/skills/`` layout the app writes — and never through a registry-root
env. Bare discovery still searches the machine's canonical user-install root
(``~/.multicode/sprintengine-roles``); the autouse fixture below points that
channel at a directory that does not exist so a developer's locally installed
roles cannot leak into suite or subprocess behavior.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from workflow_roles import install_workflow_roles

# Literal rather than an import from sprintengine_core, so the env name this
# module seeds stays independent of import order. Mirror the *legacy* spelling of
# sprintengine_core.role_registry.USER_REGISTRY_ROOT_ENV. Tests that override
# the user-install root still monkeypatch this name; setting the new spelling
# here would mask those overrides because read_studio_env prefers it.
_USER_REGISTRY_ROOT_ENV = "MULTICODE_SPRINTENGINE_USER_REGISTRY_ROOT"
_NEW_USER_REGISTRY_ROOT_ENV = "SPRINTENGINE_USER_REGISTRY_ROOT"
_NO_USER_REGISTRY_ROOT = Path(__file__).resolve().parent / ".no-user-registry"


@pytest.fixture
def workflow_roles_workspace(tmp_path: Path) -> Path:
    """A per-test workspace with the sixteen role skills installed."""
    return install_workflow_roles(tmp_path / "workspace")


@pytest.fixture(autouse=True)
def hermetic_user_registry_root(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep the user-install root off the developer's machine for every test."""
    monkeypatch.delenv(_NEW_USER_REGISTRY_ROOT_ENV, raising=False)
    monkeypatch.setenv(_USER_REGISTRY_ROOT_ENV, str(_NO_USER_REGISTRY_ROOT))
