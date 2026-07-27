"""Shared test setup for the Python suites.

The specialist roles ship as an installable pack (``resources/specialist-pack``),
not in the bundled registry root, so a raw checkout resolves zero specialists.
The running app makes an installed pack visible to the engine by exporting the
session registry-roots env on agent terminals; the Sprint Engine
suites exercise real specialist roles (developer, architect, tester, …), so we
model that install here by pointing the same env at the in-repo pack.

The registry env is owned per test by the ``specialist_pack_registry_env``
autouse fixture below: it sets both env vars through ``monkeypatch`` at setup and
restores them at teardown, so a test that overrides them (a pack-free or
custom-layer environment) cannot leak into the next test, and the suite no longer
depends on an unmanaged process-wide mutation that also silently escaped into
every subprocess forever.

The engine no longer snapshots role ids at import time (MC-1829 deleted
``VALID_ROLES``), so every consumer resolves roles at call time and the fixture
below is the only seeding this suite needs.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

# Literals rather than imports from sprintengine_core, so the env names this
# module seeds stay independent of import order. Mirror
# sprintengine_core.role_registry.SESSION_REGISTRY_ROOTS_ENV and
# .USER_REGISTRY_ROOT_ENV.
_SESSION_REGISTRY_ROOTS_ENV = "MULTICODE_SPRINTENGINE_REGISTRY_ROOTS"
_USER_REGISTRY_ROOT_ENV = "MULTICODE_SPRINTENGINE_USER_REGISTRY_ROOT"
_SPECIALIST_PACK_ROOT = Path(__file__).resolve().parent.parent / "resources" / "specialist-pack"

# Bare discovery also searches the machine's canonical user-install root
# (~/.multicode/sprintengine-roles) natively. Point it at a directory that does
# not exist so the developer's locally installed roles never leak into suite or
# subprocess behavior.
_NO_USER_REGISTRY_ROOT = Path(__file__).resolve().parent / ".no-user-registry"


def _session_registry_roots_value() -> str | None:
    """The pack env JSON, or ``None`` when the in-repo pack is absent."""
    if not _SPECIALIST_PACK_ROOT.exists():
        return None
    return json.dumps([{"id": "specialist-pack", "root": str(_SPECIALIST_PACK_ROOT)}])


@pytest.fixture(autouse=True)
def specialist_pack_registry_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Scope the registry-roots env to each test.

    ``monkeypatch`` records the pre-test value and restores it at teardown, so the
    env is owned by pytest's fixture lifecycle rather than mutated process-wide for
    the whole session. A test that needs a pack-free or custom-layer environment
    overrides these vars with its own ``monkeypatch`` calls (the same instance this
    fixture uses, applied after it), and its changes are undone before the next
    test runs. ``monkeypatch.setenv`` writes ``os.environ``, so subprocesses the
    test launches still inherit the pack for their own discovery.
    """
    roots = _session_registry_roots_value()
    if roots is not None:
        monkeypatch.setenv(_SESSION_REGISTRY_ROOTS_ENV, roots)
    monkeypatch.setenv(_USER_REGISTRY_ROOT_ENV, str(_NO_USER_REGISTRY_ROOT))
