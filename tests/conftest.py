"""Shared test setup for the Python suites.

Workflow roles are workspace skills. Suites that need a custom workspace go
through ``workflow_roles_workspace`` / ``install_workflow_roles``. Bare
discovery also reads the packaged ``resources/studio-plugin/workflow-roles``
snapshot, so a test that joins as ``developer`` without installing skills still
resolves the shipped sixteen — the same bytes a fresh install finds.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from workflow_roles import install_workflow_roles


@pytest.fixture
def workflow_roles_workspace(tmp_path: Path) -> Path:
    """A per-test workspace with the sixteen role skills installed."""
    return install_workflow_roles(tmp_path / "workspace")
