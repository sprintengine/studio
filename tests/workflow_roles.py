"""The sixteen workflow roles, and a workspace that has them installed.

The shipped roles live at ``resources/studio-plugin/workflow-roles/skills/``.
The running app copies that tree into a workspace's ``.claude/skills/``; every
Python suite that needs a real role goes through ``install_workflow_roles``
rather than duplicating a shipped skill or pointing at a registry-root env.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

REPO_ROOT = Path(__file__).resolve().parents[1]
WORKFLOW_ROLES_SKILLS_ROOT = (
    REPO_ROOT / "resources" / "studio-plugin" / "workflow-roles" / "skills"
)


@dataclass(frozen=True)
class WorkflowRole:
    id: str
    kebab: str
    label: str


# Directory order matches the shipped plugin. Labels are the shipped
# ``metadata.role-label`` values, kept here so a suite can name a role without
# parsing a SKILL.md.
WORKFLOW_ROLES: tuple[WorkflowRole, ...] = (
    WorkflowRole("architect", "architect", "Architect"),
    WorkflowRole("blog_writer", "blog-writer", "Blog Writer"),
    WorkflowRole("creative", "creative", "Creative Engineer"),
    WorkflowRole("cross_platform", "cross-platform", "Cross-platform"),
    WorkflowRole("developer", "developer", "Developer"),
    WorkflowRole("devops", "devops", "DevOps"),
    WorkflowRole("frontend", "frontend", "Frontend"),
    WorkflowRole("nuclear_reviewer", "nuclear-reviewer", "Nuclear reviewer"),
    WorkflowRole("performance", "performance", "Performance specialist"),
    WorkflowRole("presentation", "presentation", "Presentation"),
    WorkflowRole("product", "product", "Product specialist"),
    WorkflowRole(
        "production_readiness_reviewer",
        "production-readiness-reviewer",
        "Production readiness",
    ),
    WorkflowRole("security", "security", "Security specialist"),
    WorkflowRole("spec_reviewer", "spec-reviewer", "Spec reviewer"),
    WorkflowRole("tester", "tester", "QA"),
    WorkflowRole("ui_ux_reviewer", "ui-ux-reviewer", "UI/UX specialist"),
)

WORKFLOW_ROLE_IDS: frozenset[str] = frozenset(role.id for role in WORKFLOW_ROLES)


def install_workflow_roles(workspace: Path) -> Path:
    """Copy the shipped role skills into ``<workspace>/.claude/skills/``.

    This is the install shape the app uses. Returns ``workspace`` so callers can
    pass the result straight into a registry or a tmp fixture.
    """
    dest = workspace / ".claude" / "skills"
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(WORKFLOW_ROLES_SKILLS_ROOT, dest, dirs_exist_ok=True)
    shipped = sorted(
        path.name for path in dest.iterdir() if path.is_dir() and not path.name.startswith(".")
    )
    expected = [role.kebab for role in WORKFLOW_ROLES]
    if shipped != expected:
        raise AssertionError(
            "Shipped workflow-roles skills do not match tests/workflow_roles.py: "
            f"shipped={shipped!r} catalog={expected!r}"
        )
    return workspace


def workspace_role_discovery(
    workspace: Path,
    *,
    user_root: Path,
    bundled_root: Path | None = None,
):
    """Build a ``RegistryDiscovery`` from a workspace the helper installed.

    MC-2503 rewrites engine discovery to scan harness skill directories. Until
    that lands, this is the test-side equivalent: host skills still come from
    the bundled registry root, and each installed ``SKILL.md`` that carries
    ``metadata.sprintengine-role`` becomes the role that composes itself.
    """
    from sprintengine_core.role_registry import (
        BUNDLED_REGISTRY_ROOT,
        DirectiveSkillEntry,
        IMPLEMENT_DIRECTIVE,
        RegistryDiscovery,
        RegistryEntry,
        RoleManifest,
        RoleSkillRegistry,
        SourceEntry,
        SourceLayer,
        _load_skill_document,
        normalize_role_id,
    )

    bundled = RoleSkillRegistry(
        workspace_root=workspace,
        plugin_roots=[],
        user_root=user_root,
        bundled_root=bundled_root or BUNDLED_REGISTRY_ROOT,
    ).discover()

    skills_root = workspace / ".claude" / "skills"
    layer = SourceLayer("workspace", workspace / ".claude", 0)
    roles: dict[str, RegistryEntry] = dict(bundled.roles)
    skills: dict[str, RegistryEntry] = dict(bundled.skills)
    warnings = list(bundled.warnings)

    if skills_root.is_dir():
        for skill_dir in sorted(path for path in skills_root.iterdir() if path.is_dir()):
            path = skill_dir / "SKILL.md"
            if not path.is_file():
                continue
            skill_id = normalize_role_id(skill_dir.name)
            document = _load_skill_document(skill_id, path, layer, warnings)
            if document is None:
                continue
            metadata = document.frontmatter.get("metadata")
            if not isinstance(metadata, Mapping):
                continue
            role_id_raw = metadata.get("sprintengine-role")
            if not isinstance(role_id_raw, str) or not role_id_raw.strip():
                continue
            role_id = normalize_role_id(role_id_raw)
            label_raw = metadata.get("role-label")
            label = (
                label_raw.strip()
                if isinstance(label_raw, str) and label_raw.strip()
                else role_id.replace("_", " ").title()
            )
            icon_raw = metadata.get("role-icon")
            icon = icon_raw.strip() if isinstance(icon_raw, str) and icon_raw.strip() else None
            description_raw = document.frontmatter.get("description")
            description = (
                description_raw.strip()
                if isinstance(description_raw, str) and description_raw.strip()
                else None
            )
            source = SourceEntry(layer, path)
            roles[role_id] = RegistryEntry(
                value=RoleManifest(
                    id=role_id,
                    label=label,
                    aliases=(),
                    description=description,
                    icon=icon,
                    directives={IMPLEMENT_DIRECTIVE: (DirectiveSkillEntry(skill=skill_id),)},
                ),
                source=source,
                shadowed=(),
            )
            skills[skill_id] = RegistryEntry(value=document, source=source, shadowed=())

    return RegistryDiscovery(
        roles=roles,
        skills=skills,
        aliases={role_id: role_id for role_id in roles},
        warnings=tuple(warnings),
    )
