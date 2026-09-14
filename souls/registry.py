from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path

from sprintengine_core.studio_env import read_studio_env
from sprintengine_core.role_registry import (
    RegistryDiscovery,
    SoulRenderError,
    discover_role_registry,
    multicode_user_registry_root,
)

# Env var carrying the dynamic plugin registry roots the app discovered for the
# current session, as JSON: [{"id": "...", "root": "..."}]. Set on agent
# terminals at spawn (see withSprintEngineEnv in src/main/terminal-launch.ts)
# from the same resolver the spawn menu uses, so `souls get` resolves exactly the
# plugin-contributed specialists the menu offered. Plugin roots are dynamic
# (only the running app knows which plugins are installed), so they must be
# passed in rather than discovered statically.
REGISTRY_ROOTS_ENV = "SPRINTENGINE_REGISTRY_ROOTS"


def _session_plugin_roots() -> list[dict[str, str]]:
    raw = (read_studio_env(REGISTRY_ROOTS_ENV) or "").strip()
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return []
    if not isinstance(parsed, list):
        return []
    roots: list[dict[str, str]] = []
    for entry in parsed:
        if not isinstance(entry, dict):
            continue
        root = entry.get("root")
        if not isinstance(root, str) or not root.strip():
            continue
        item: dict[str, str] = {"root": root.strip()}
        plugin_id = entry.get("id")
        if isinstance(plugin_id, str) and plugin_id.strip():
            item["id"] = plugin_id.strip()
        roots.append(item)
    return roots


def _effective_plugin_roots() -> list[object]:
    # Dynamic plugin roots (session env) first, then the canonical user-install
    # root — matching the order the app's menu discovery uses
    # (sprintEngineRegistryRootsForRead in src/main/sprintengine-artifacts.ts),
    # so precedence is identical between the menu and `souls get`.
    return [*_session_plugin_roots(), multicode_user_registry_root()]


@dataclass(frozen=True)
class Soul:
    role: str
    label: str
    aliases: tuple[str, ...] = ()
    path: Path | None = None


def _default_discovery() -> RegistryDiscovery:
    return discover_role_registry(workspace_root=Path.cwd(), plugin_roots=_effective_plugin_roots())


def _soul_from_registry(discovery: RegistryDiscovery, role_or_alias: str) -> Soul:
    role = discovery.get_role(role_or_alias)
    return Soul(
        role=role.id,
        label=role.label,
        aliases=role.aliases,
        path=discovery.role_entry(role.id).source.path,
    )


def _unknown_soul_error(role: str, discovery: RegistryDiscovery) -> KeyError:
    known = ", ".join(sorted(discovery.roles))
    return KeyError(f"Unknown Soul role: {role}. Known roles: {known}.")


def get_soul(role: str) -> Soul:
    discovery = _default_discovery()
    try:
        return _soul_from_registry(discovery, role)
    except KeyError as exc:
        raise _unknown_soul_error(role, discovery) from exc


def list_souls() -> list[Soul]:
    discovery = _default_discovery()
    return [_soul_from_registry(discovery, role_id) for role_id in sorted(discovery.roles)]


def soul_path(role: str) -> Path:
    # Discovery always resolves a manifest path onto the Soul, so this simply
    # exposes it.
    path = get_soul(role).path
    if path is None:  # pragma: no cover - discovery always sets the path
        raise KeyError(f"Soul '{role}' has no resolved registry path.")
    return path


def render_soul(role: str, *, extra_skills: tuple[str, ...] = ()) -> str:
    discovery = _default_discovery()
    try:
        rendered = discovery.render_soul(
            role,
            workspace_root=Path.cwd(),
            run_id=os.environ.get("SPRINTENGINE_RUN_ID", ""),
            extra_skills=extra_skills,
        )
        return rendered.content.strip()
    except KeyError as exc:
        raise _unknown_soul_error(role, discovery) from exc
    except SoulRenderError as exc:
        raise FileNotFoundError(str(exc)) from exc


def validate_souls() -> list[str]:
    # Validate whatever the layered registry resolves in this environment: every
    # discovery warning is an error, and every discovered role must render. The
    # specialist roles ship as an installable pack (resources/specialist-pack),
    # not in the bundled root, so validation never asserts a fixed bundled role
    # set — it passes cleanly with the pack absent (a raw install resolves zero
    # specialists) and with it present as a registry layer.
    errors: list[str] = []
    discovery = _default_discovery()
    for warning in discovery.warnings:
        source = f" at {warning.path}" if warning.path is not None else ""
        errors.append(f"{warning.code}{source}: {warning.message}")
    for role_id in sorted(discovery.roles):
        try:
            discovery.render_soul(role_id, workspace_root=Path.cwd(), run_id=os.environ.get("SPRINTENGINE_RUN_ID", ""))
        except SoulRenderError as exc:
            errors.append(str(exc))
    return errors
