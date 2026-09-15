"""Read-only role registry inspection commands."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping

from sprintengine_core.role_registry import (
    MissingRoleError,
    RegistryEntry,
    RegistryWarning,
    RoleManifest,
    SkillDocument,
    SoulRenderError,
    discover_role_registry,
    normalize_role_id,
    role_manifest_payload,
)


def roles_list(args) -> dict[str, Any]:
    registry = _discover(args)
    roles = [_role_payload(entry, include_shadowed=bool(args.include_shadowed)) for _, entry in sorted(registry.roles.items())]
    return {"ok": True, "roles": roles, "aliases": dict(sorted(registry.aliases.items())), "warnings": _warning_payloads(registry.warnings)}


def role_get(args) -> dict[str, Any]:
    registry = _discover(args)
    try:
        entry = registry.role_entry(args.role)
    except MissingRoleError as exc:
        raise SystemExit(str(exc)) from exc
    return {"ok": True, "role": _role_payload(entry, include_shadowed=True), "warnings": _warning_payloads(registry.warnings)}


def soul_get(args) -> dict[str, Any]:
    registry = _discover(args)
    try:
        rendered = registry.render_soul(args.role, workspace_root=_workspace_root(args), run_id=args.run_id or "")
    except MissingRoleError as exc:
        raise SystemExit(str(exc)) from exc
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


def _workspace_root(args) -> Path:
    return Path.cwd()


def _discover(args):
    return discover_role_registry(workspace_root=_workspace_root(args))


def _role_payload(entry: RegistryEntry, *, include_shadowed: bool = False) -> dict[str, Any]:
    role = entry.value
    if not isinstance(role, RoleManifest):
        return {}
    payload = _role_manifest_payload(role)
    payload["source"] = _source_payload(entry)
    if include_shadowed:
        payload["shadowedSources"] = [_source_payload_from_source(source) for source in entry.shadowed]
    return payload


_role_manifest_payload = role_manifest_payload


def _skill_payload(entry: RegistryEntry, *, include_body: bool) -> dict[str, Any]:
    skill = entry.value
    if not isinstance(skill, SkillDocument):
        return {}
    payload: dict[str, Any] = {
        "id": skill.id,
        "frontmatter": dict(skill.frontmatter),
        "source": _source_payload(entry),
    }
    if include_body:
        payload["body"] = skill.body
    else:
        payload["bodyLength"] = len(skill.body)
    return payload


def _source_payload(entry: RegistryEntry) -> dict[str, Any]:
    return _source_payload_from_source(entry.source)


def _source_payload_from_source(source) -> dict[str, Any]:
    return {"layer": source.layer.name, "path": str(source.path)}


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
