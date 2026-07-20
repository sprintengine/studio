"""Shared test setup for the Python suites.

The specialist roles ship as an installable pack (``resources/specialist-pack``),
not in the bundled registry root, so a raw checkout resolves zero specialists.
The running app makes an installed pack visible to the engine by exporting the
session registry-roots env on agent terminals; the Sprint Engine and Multiloop
suites exercise real specialist roles (developer, architect, tester, …), so we
model that install here by pointing the same env at the in-repo pack.

The env is set at import time — before any ``sprintengine_core`` import, so
import-time snapshots such as ``sprintengine_core.tool.roles.VALID_ROLES`` see
it — and is inherited by every subprocess the suites launch. Tests that need a
pack-free or custom-layer environment override this env via ``monkeypatch``.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

# Literal to avoid importing sprintengine_core before the env is set (the package
# import eagerly computes VALID_ROLES). Mirrors
# sprintengine_core.role_registry.SESSION_REGISTRY_ROOTS_ENV.
_SESSION_REGISTRY_ROOTS_ENV = "MULTICODE_SPRINTENGINE_REGISTRY_ROOTS"
_SPECIALIST_PACK_ROOT = Path(__file__).resolve().parent.parent / "resources" / "specialist-pack"

if _SPECIALIST_PACK_ROOT.exists() and not os.environ.get(_SESSION_REGISTRY_ROOTS_ENV):
    os.environ[_SESSION_REGISTRY_ROOTS_ENV] = json.dumps(
        [{"id": "specialist-pack", "root": str(_SPECIALIST_PACK_ROOT)}]
    )
