from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path

from sprintengine_core.role_registry import RegistryDiscovery, SoulRenderError, discover_role_registry


SOULS_ROOT = Path(__file__).resolve().parent
PROMPTS_DIR = SOULS_ROOT / "prompts"


@dataclass(frozen=True)
class Soul:
    role: str
    label: str
    aliases: tuple[str, ...] = ()
    path: Path | None = None

    @property
    def file_name(self) -> str:
        return self.path.name if self.path is not None else f"{self.role}.md"


LEGACY_SOULS: tuple[Soul, ...] = (
    Soul("coordinator", "Coordinator", ("multiloop-coordinator",), PROMPTS_DIR / "coordinator.md"),
    Soul("architect", "Architect", path=PROMPTS_DIR / "architect.md"),
    Soul("product", "Product", ("product-strategist",), PROMPTS_DIR / "product.md"),
    Soul("developer", "Developer", path=PROMPTS_DIR / "developer.md"),
    Soul("devops", "DevOps", ("devops-infra",), PROMPTS_DIR / "devops.md"),
    Soul("frontend", "Frontend", ("frontend-design-review",), PROMPTS_DIR / "frontend.md"),
    Soul("blog_writer", "Blog Writer", ("blog-writer", "content-writer", "blogger"), PROMPTS_DIR / "blog_writer.md"),
    Soul("tester", "Tester", ("qa-test",), PROMPTS_DIR / "tester.md"),
    Soul("security", "Security", ("security-review",), PROMPTS_DIR / "security.md"),
    Soul("code_reviewer", "Code Reviewer", ("code-review", "code-reviewer"), PROMPTS_DIR / "code_reviewer.md"),
    Soul("spec_reviewer", "Spec Reviewer", ("spec-review", "spec-reviewer"), PROMPTS_DIR / "spec_reviewer.md"),
    Soul("performance", "Performance", ("performance-engineer",), PROMPTS_DIR / "performance.md"),
    Soul("presentation", "Presentation", ("presenter", "deck-writer", "slide-author", "slides"), PROMPTS_DIR / "presentation.md"),
)
SOULS = LEGACY_SOULS
MIGRATED_BUNDLED_SOULS = LEGACY_SOULS


def _default_discovery() -> RegistryDiscovery:
    return discover_role_registry(workspace_root=Path.cwd())


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
    soul = get_soul(role)
    if soul.path is None:
        return PROMPTS_DIR / soul.file_name
    return soul.path


def render_soul(role: str) -> str:
    discovery = _default_discovery()
    try:
        rendered = discovery.render_soul(role, workspace_root=Path.cwd(), run_id=os.environ.get("SPRINTENGINE_RUN_ID", ""))
        return rendered.content.strip()
    except KeyError as exc:
        raise _unknown_soul_error(role, discovery) from exc
    except SoulRenderError as exc:
        raise FileNotFoundError(str(exc)) from exc


def validate_souls() -> list[str]:
    errors: list[str] = []
    discovery = _default_discovery()
    for warning in discovery.warnings:
        source = f" at {warning.path}" if warning.path is not None else ""
        errors.append(f"{warning.code}{source}: {warning.message}")
    for soul in MIGRATED_BUNDLED_SOULS:
        if soul.role not in discovery.roles:
            errors.append(f"{soul.role}: missing migrated bundled Soul registry role")
    for role_id in sorted(discovery.roles):
        try:
            discovery.render_soul(role_id, workspace_root=Path.cwd(), run_id=os.environ.get("SPRINTENGINE_RUN_ID", ""))
        except SoulRenderError as exc:
            errors.append(str(exc))
    return errors
