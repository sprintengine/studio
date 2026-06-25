from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path

from sprintengine_core.role_registry import RegistryDiscovery, SoulRenderError, discover_role_registry


SOULS_ROOT = Path(__file__).resolve().parent
PROMPTS_DIR = SOULS_ROOT / "prompts"

# Canonical Multicode user-level registry root. MUST stay in sync with
# defaultUserRoleRegistryRoot() in src/main/sprintengine-role-registry.ts
# (~/.multicode/sprintengine-roles). Discovering it natively here means a
# user-installed specialist resolves through `souls get` without the app having
# to inject anything — the spawn menu and the spawn itself look in the same place.
MULTICODE_USER_REGISTRY_ROOT = Path.home() / ".multicode" / "sprintengine-roles"

# Env var carrying the dynamic plugin registry roots the app discovered for the
# current session, as JSON: [{"id": "...", "root": "..."}]. Set on agent
# terminals at spawn (see withSprintEngineEnv in src/main/terminal-launch.ts)
# from the same resolver the spawn menu uses, so `souls get` resolves exactly the
# plugin-contributed specialists the menu offered. Plugin roots are dynamic
# (only the running app knows which plugins are installed), so they must be
# passed in rather than discovered statically.
REGISTRY_ROOTS_ENV = "MULTICODE_SPRINTENGINE_REGISTRY_ROOTS"


def _session_plugin_roots() -> list[dict[str, str]]:
    raw = os.environ.get(REGISTRY_ROOTS_ENV, "").strip()
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
    return [*_session_plugin_roots(), MULTICODE_USER_REGISTRY_ROOT]


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
    Soul("ui_ux_reviewer", "UI/UX Reviewer", ("ui-ux-review", "frontend-ui-review", "frontend-ux-review", "brand-ui-review"), PROMPTS_DIR / "ui_ux_reviewer.md"),
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
    soul = get_soul(role)
    if soul.path is None:
        return PROMPTS_DIR / soul.file_name
    return soul.path


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
