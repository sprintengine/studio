from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from sprintengine_core.role_registry import (
    RegistryDiscovery,
    SoulRenderError,
    discover_role_registry,
    resolve_workspace_root,
)


@dataclass(frozen=True)
class Soul:
    role: str
    label: str
    aliases: tuple[str, ...] = ()
    path: Path | None = None


def _default_discovery() -> RegistryDiscovery:
    return discover_role_registry(workspace_root=resolve_workspace_root())


def _soul_from_registry(discovery: RegistryDiscovery, role_or_alias: str) -> Soul:
    role = discovery.get_role(role_or_alias)
    return Soul(
        role=role.id,
        label=role.label,
        aliases=role.aliases,
        path=discovery.role_entry(role.id).source.path,
    )


def get_soul(role: str) -> Soul:
    discovery = _default_discovery()
    return _soul_from_registry(discovery, role)


def list_souls() -> list[Soul]:
    discovery = _default_discovery()
    return [_soul_from_registry(discovery, role_id) for role_id in sorted(discovery.roles)]


def soul_path(role: str) -> Path:
    path = get_soul(role).path
    if path is None:  # pragma: no cover - discovery always sets the path
        raise KeyError(f"Soul '{role}' has no resolved registry path.")
    return path


def render_soul(role: str, *, extra_skills: tuple[str, ...] = ()) -> str:
    discovery = _default_discovery()
    try:
        rendered = discovery.render_soul(
            role,
            workspace_root=resolve_workspace_root(),
            extra_skills=extra_skills,
        )
        return rendered.content.strip()
    except SoulRenderError as exc:
        raise FileNotFoundError(str(exc)) from exc


def validate_souls() -> list[str]:
    # Validate whatever the workspace's role skills resolve to: every discovery
    # warning is an error, and every discovered role must render. A workspace
    # with no role skills validates cleanly (an empty list is a true answer).
    errors: list[str] = []
    discovery = _default_discovery()
    for warning in discovery.warnings:
        source = f" at {warning.path}" if warning.path is not None else ""
        errors.append(f"{warning.code}{source}: {warning.message}")
    for role_id in sorted(discovery.roles):
        try:
            discovery.render_soul(role_id, workspace_root=resolve_workspace_root())
        except SoulRenderError as exc:
            errors.append(str(exc))
    return errors
