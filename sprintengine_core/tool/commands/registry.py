"""Read-only role registry inspection commands."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Mapping

from sprintengine_core.role_registry import (
    RegistryEntry,
    RegistryWarning,
    RoleManifest,
    SkillDocument,
    SoulRenderError,
    discover_role_registry,
    normalize_role_id,
)


REGISTRY_EXTRA_DIRS_ENV = "SPRINTENGINE_REGISTRY_EXTRA_DIRS"


def roles_list(args) -> dict[str, Any]:
    registry = _discover(args)
    roles = [_role_payload(entry, include_shadowed=bool(args.include_shadowed)) for _, entry in sorted(registry.roles.items())]
    return {"ok": True, "roles": roles, "aliases": dict(sorted(registry.aliases.items())), "warnings": _warning_payloads(registry.warnings)}


def role_get(args) -> dict[str, Any]:
    registry = _discover(args)
    try:
        entry = registry.role_entry(args.role)
    except KeyError as exc:
        _raise_unknown_role(args.role, registry.roles, cause=exc)
    return {"ok": True, "role": _role_payload(entry, include_shadowed=True), "warnings": _warning_payloads(registry.warnings)}


def soul_get(args) -> dict[str, Any]:
    registry = _discover(args)
    try:
        rendered = registry.render_soul(args.role, workspace_root=Path.cwd(), run_id=args.run_id or "")
    except KeyError as exc:
        _raise_unknown_role(args.role, registry.roles, cause=exc)
    except SoulRenderError as exc:
        raise SystemExit(f"Could not render Soul for role {args.role!r}: {exc}") from exc
    return {
        "ok": True,
        "role": _role_manifest_payload(rendered.role),
        "soul": {"content": rendered.content, "contentLength": len(rendered.content)},
        "warnings": _warning_payloads(rendered.warnings),
    }


def skills_list(args) -> dict[str, Any]:
    registry = _discover(args)
    skills = [_skill_payload(entry, include_body=bool(args.include_body)) for _, entry in sorted(registry.skills.items())]
    return {"ok": True, "skills": skills, "warnings": _warning_payloads(registry.warnings)}


def skill_get(args) -> dict[str, Any]:
    registry = _discover(args)
    skill_id = normalize_role_id(args.skill)
    entry = registry.skills.get(skill_id)
    if entry is None or not isinstance(entry.value, SkillDocument):
        known = ", ".join(sorted(registry.skills))
        detail = f" Known skills: {known}." if known else ""
        raise SystemExit(f"Unknown registry skill: {args.skill}.{detail}")
    return {"ok": True, "skill": _skill_payload(entry, include_body=True), "warnings": _warning_payloads(registry.warnings)}


def _discover(args):
    return discover_role_registry(workspace_root=Path.cwd(), plugin_roots=_plugin_roots_from_args(args))


def _plugin_roots_from_args(args) -> list[Path]:
    roots: list[Path] = []
    for raw in getattr(args, "extra_dir", None) or []:
        roots.append(Path(raw).expanduser())
    env_value = os.environ.get(REGISTRY_EXTRA_DIRS_ENV, "")
    for raw in env_value.split(os.pathsep):
        if raw.strip():
            roots.append(Path(raw.strip()).expanduser())
    return roots


def _raise_unknown_role(role: str, roles: Mapping[str, RegistryEntry], *, cause: Exception | None = None) -> None:
    known = ", ".join(sorted(roles))
    detail = f" Known roles: {known}." if known else ""
    raise SystemExit(f"Unknown registry role: {role}.{detail}") from cause


def _role_payload(entry: RegistryEntry, *, include_shadowed: bool = False) -> dict[str, Any]:
    role = entry.value
    if not isinstance(role, RoleManifest):
        return {}
    payload = _role_manifest_payload(role)
    payload["source"] = _source_payload(entry.source.layer.name)
    if include_shadowed:
        payload["shadowedSources"] = [_source_payload(source.layer.name) for source in entry.shadowed]
    return payload


def _role_manifest_payload(role: RoleManifest) -> dict[str, Any]:
    return {
        "id": role.id,
        "label": role.label,
        "aliases": list(role.aliases),
        "summary": role.summary,
        "icon": role.icon,
        "soul": [{"skill": entry.skill} for entry in role.soul],
        "capabilities": [
            {
                "kind": capability.kind,
                **({"phase": capability.phase} if capability.phase else {}),
                **({"reviews": list(capability.reviews)} if capability.reviews else {}),
                **({"defaultFocus": capability.default_focus} if capability.default_focus else {}),
            }
            for capability in role.capabilities
        ],
    }


def _skill_payload(entry: RegistryEntry, *, include_body: bool) -> dict[str, Any]:
    skill = entry.value
    if not isinstance(skill, SkillDocument):
        return {}
    payload: dict[str, Any] = {
        "id": skill.id,
        "frontmatter": dict(skill.frontmatter),
        "source": _source_payload(entry.source.layer.name),
    }
    if include_body:
        payload["body"] = skill.body
    else:
        payload["bodyLength"] = len(skill.body)
    return payload


def _source_payload(layer_name: str) -> dict[str, Any]:
    return {"layer": layer_name}


def _warning_payloads(warnings: tuple[RegistryWarning, ...]) -> list[dict[str, Any]]:
    payloads: list[dict[str, Any]] = []
    for warning in warnings:
        payload: dict[str, Any] = {
            "code": warning.code,
            "message": warning.message,
        }
        if warning.role_id:
            payload["roleId"] = warning.role_id
        if warning.skill_id:
            payload["skillId"] = warning.skill_id
        if warning.source_layer:
            payload["sourceLayer"] = warning.source_layer
        payloads.append(payload)
    return payloads
