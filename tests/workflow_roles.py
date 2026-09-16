"""The sixteen workflow roles, and a workspace that has them installed.

The shipped roles live at ``resources/studio-plugin/workflow-roles/skills/``.
The running app copies that tree into a workspace's ``.claude/skills/``; every
Python suite that needs a real role goes through ``install_workflow_roles``
rather than duplicating a shipped skill. Custom fixture roles go through
``write_workspace_role``.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path

from sprintengine_core.role_registry import discover_role_registry

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


def write_workspace_role(
    workspace: Path,
    role_id: str,
    *,
    label: str | None = None,
    description: str | None = None,
    body: str | None = None,
    icon: str | None = None,
    harness: str = ".claude",
) -> Path:
    """Write one role skill into a workspace harness directory. Returns the SKILL.md path."""
    kebab = role_id.replace("_", "-")
    skill_dir = workspace / harness / "skills" / kebab
    skill_dir.mkdir(parents=True, exist_ok=True)
    resolved_label = label or role_id.replace("_", " ").title()
    resolved_description = description or f"Use when the run needs {role_id} work."
    resolved_body = body or f"# {role_id}\n\nTemporary test role."
    resolved_icon = icon or "extension"
    # Quote the description so YAML stays a single scalar even with colons.
    escaped = resolved_description.replace("\\", "\\\\").replace('"', '\\"')
    content = (
        "---\n"
        f"name: {kebab}\n"
        f'description: "{escaped}"\n'
        "metadata:\n"
        f"  sprintengine-role: {role_id}\n"
        f"  role-label: {resolved_label}\n"
        f"  role-icon: {resolved_icon}\n"
        "---\n"
        f"{resolved_body}\n"
    )
    path = skill_dir / "SKILL.md"
    path.write_text(content, encoding="utf-8")
    return path


def workspace_role_discovery(workspace: Path, **_ignored):
    """Engine discovery for a workspace the helper installed.

    Extra kwargs are ignored so callers written against the test-side synthesis
    keep working.
    """
    return discover_role_registry(workspace_root=workspace)
