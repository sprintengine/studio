"""Role compatibility helpers for the Sprint Engine CLI."""

from __future__ import annotations

from typing import Iterable

from sprintengine_core.role_registry import RegistryDiscovery, discover_role_registry, normalize_role_id


# Compatibility view for older callers that need the historically bundled
# Sprint Engine role set. Active dispatch validation uses the role registry.
BUNDLED_ROLE_IDS = frozenset({
    "architect",
    "product",
    "developer",
    "frontend",
    "tester",
    "security",
    "code_reviewer",
    "spec_reviewer",
    "performance",
})


class RoleRegistry:
    """Read-only compatibility registry for built-in role defaults."""

    def __init__(self, role_ids: Iterable[str] = BUNDLED_ROLE_IDS) -> None:
        self._role_ids = frozenset(str(role_id) for role_id in role_ids)

    def all(self) -> frozenset[str]:
        return self._role_ids

    def choices(self) -> list[str]:
        return sorted(self._role_ids)

    def is_valid(self, role: str) -> bool:
        return normalize_role_id(role) in self._role_ids

    def without(self, *role_ids: str) -> frozenset[str]:
        return self._role_ids - set(role_ids)


def configured_soul_role_ids(discovery: RegistryDiscovery | None = None) -> frozenset[str]:
    """Return configured Soul ids without changing Sprint Engine dispatchability."""

    resolved = discovery if discovery is not None else discover_role_registry()
    return frozenset(resolved.roles)


def configured_role_ids(discovery: RegistryDiscovery | None = None) -> frozenset[str]:
    """Return configured role ids that may be used for Sprint Engine dispatch."""

    return configured_soul_role_ids(discovery)


def dispatchable_role_ids(discovery: RegistryDiscovery | None = None) -> frozenset[str]:
    return configured_role_ids(discovery)


def canonical_role_id(role: str, discovery: RegistryDiscovery | None = None) -> str:
    """Return the configured canonical role id, resolving aliases and hyphen variants."""

    clean_role = str(role or "").strip()
    if not clean_role:
        raise KeyError("Role cannot be empty.")
    resolved = discovery if discovery is not None else discover_role_registry()
    return resolved.get_role(clean_role).normalized_id


def is_configured_role(role: str, discovery: RegistryDiscovery | None = None) -> bool:
    try:
        canonical_role_id(role, discovery)
    except KeyError:
        return False
    return True


def require_configured_role(role: str, *, context: str = "role", discovery: RegistryDiscovery | None = None) -> str:
    try:
        return canonical_role_id(role, discovery)
    except KeyError as exc:
        known = ", ".join(sorted(configured_role_ids(discovery)))
        detail = f" Known roles: {known}." if known else ""
        raise SystemExit(f"{context} has unknown role {role!r}.{detail}") from exc


def plan_review_role_ids(discovery: RegistryDiscovery | None = None) -> frozenset[str]:
    return configured_role_ids(discovery) - {"architect"}


DEFAULT_ROLE_REGISTRY = RoleRegistry()
# Import-compatible snapshot retained for older tests and callers. Active CLI,
# MCP, roster, task, gate, join, and plan paths call require_configured_role()
# so workspace registry roles are resolved at command time.
VALID_ROLES = configured_role_ids()
PLAN_REVIEW_ROLES = plan_review_role_ids()
