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


def optional_configured_role(
    role: str | None, *, context: str = "role", discovery: RegistryDiscovery | None = None
) -> str | None:
    """The canonical role, or None when no role was given (MC-2057).

    Absent is legal, wrong is not: a roleless run's tasks and agents carry no
    role at all, while a role that IS named must still resolve to the registry.
    This is the one place that distinction is made, so callers never spell it as
    `role or "<some fallback>"` and reintroduce a stand-in role.
    """
    if not str(role or "").strip():
        return None
    return require_configured_role(str(role), context=context, discovery=discovery)
