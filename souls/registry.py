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


def _normalize_role(value: str) -> str:
    return value.strip().lower().replace("-", "_")


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


def _legacy_soul(role: str) -> Soul:
    normalized = _normalize_role(role)
    for soul in LEGACY_SOULS:
        if soul.role == normalized:
            return soul
        if normalized in {_normalize_role(alias) for alias in soul.aliases}:
            return soul
    known = ", ".join(soul.role for soul in LEGACY_SOULS)
    raise KeyError(f"Unknown Soul role: {role}. Known roles: {known}.")


def get_soul(role: str) -> Soul:
    discovery = _default_discovery()
    try:
        return _soul_from_registry(discovery, role)
    except KeyError:
        return _legacy_soul(role)


def list_souls() -> list[Soul]:
    discovery = _default_discovery()
    configured = [_soul_from_registry(discovery, role_id) for role_id in sorted(discovery.roles)]
    configured_ids = {soul.role for soul in configured}
    legacy = [soul for soul in LEGACY_SOULS if soul.role not in configured_ids]
    return [*configured, *legacy]


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
    except KeyError:
        pass
    except SoulRenderError as exc:
        raise FileNotFoundError(str(exc)) from exc

    path = soul_path(role)
    if not path.exists():
        raise FileNotFoundError(f"Soul prompt file missing for role {get_soul(role).role}: {path}")
    return path.read_text(encoding="utf-8").strip()


def validate_souls() -> list[str]:
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
    for soul in list_souls():
        if soul.role in discovery.roles:
            continue
        path = soul_path(soul.role)
        if not path.exists():
            errors.append(f"{soul.role}: missing {path}")
            continue
        if not path.read_text(encoding="utf-8").strip():
            errors.append(f"{soul.role}: empty {path}")
    return errors
