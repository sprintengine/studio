"""Shared test setup for the Python suites.

Production discovery has no bundled last layer (owner ruling 2026-09-08).
Copying the sixteen into every fixture workspace would dirty git tests, so
pytest sets ``SPRINTENGINE_TEST_BUNDLED_WORKFLOW_ROLES=1`` for the suite.
Empty-pack tests delete that env via ``empty_role_pack``.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from sprintengine_core.role_registry import TEST_BUNDLED_WORKFLOW_ROLES_ENV
from workflow_roles import install_workflow_roles

os.environ[TEST_BUNDLED_WORKFLOW_ROLES_ENV] = "1"


@pytest.fixture
def workflow_roles_workspace(tmp_path: Path) -> Path:
    """A per-test workspace with the sixteen role skills installed."""
    return install_workflow_roles(tmp_path / "workspace")


@pytest.fixture
def empty_role_pack(monkeypatch: pytest.MonkeyPatch) -> None:
    """The same discovery a fresh install sees: no bundled last layer."""
    monkeypatch.delenv(TEST_BUNDLED_WORKFLOW_ROLES_ENV, raising=False)
