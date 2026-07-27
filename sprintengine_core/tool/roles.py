"""Role compatibility helpers for the Sprint Engine CLI."""

from __future__ import annotations

from sprintengine_core.role_registry import RegistryDiscovery, discover_role_registry, normalize_role_id


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
    if normalize_role_id(clean_role) == "general":
        # `general` is a built-in soulless identity recognised by id without a
        # registry manifest (see capabilities classification and join
        # composition). It is a valid dispatch/task role even though no Soul
        # manifest defines it, so role validation must accept it everywhere.
        return "general"
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
