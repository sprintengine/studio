from __future__ import annotations

import os
import re
from contextvars import ContextVar
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping

import yaml


# Host-owned prompt layers (norms, phase packs, studio product skills). Not roles.
BUNDLED_REGISTRY_ROOT = Path(__file__).resolve().parents[1] / "resources" / "sprintengine"
BUNDLED_HOST_SKILLS_ROOT = BUNDLED_REGISTRY_ROOT / "skills"

# Offline seed / install source for the workflow-roles pack. Production
# discovery never reads this: a missing pack is the empty-pack error, not a
# quiet substitute (owner ruling 2026-09-08, MC-2507).
#
# Pytest-only (lander 2026-09-16): many CLI tests run with cwd=REPO_ROOT and
# discover from that tree. Installing the sixteen into those git fixtures
# dirties the suite, so pytest — and Node tests that spawn the same engine —
# set SPRINTENGINE_TEST_BUNDLED_WORKFLOW_ROLES=1. This is not a user setting;
# a process that exports it outside the test harness is opting into test
# discovery, not a product fallback. Empty-pack tests delete it.
BUNDLED_WORKFLOW_ROLES_SKILLS = (
    Path(__file__).resolve().parents[1]
    / "resources"
    / "studio-plugin"
    / "workflow-roles"
    / "skills"
)

# Walk order is the studio's plugin-install order. The same role normally exists
# once per harness as the same bytes; first hit wins so a genuine second
# definition is a user override in an earlier harness.
HARNESS_DIRECTORIES: tuple[str, ...] = (
    ".claude",
    ".agents",
    ".codex",
    ".cursor",
    ".gemini",
    ".opencode",
    ".grok",
)

# Pytest-only. Production and a fresh install never set this; empty-pack tests
# delete it so they see the same state a user with nothing installed sees.
TEST_BUNDLED_WORKFLOW_ROLES_ENV = "SPRINTENGINE_TEST_BUNDLED_WORKFLOW_ROLES"

ROLE_METADATA_KEY = "sprintengine-role"
ROLE_LABEL_KEY = "role-label"
ROLE_ICON_KEY = "role-icon"

# Shared MCP hub: one process, many workspaces. A caller that knows the
# workspace declares it for the duration of the call; bare discovery reads this
# instead of Path.cwd().
active_workspace_root: ContextVar[Path | None] = ContextVar(
    "active_workspace_root",
    default=None,
)

SUPPORTED_TEMPLATE_VARIABLES = frozenset({"role", "role_label", "workspace_root", "run_id"})
TEMPLATE_PATTERN = re.compile(r"{{\s*([^{}]+?)\s*}}")

NO_WORKFLOW_ROLES_HEAD = "No workflow roles are installed."
NO_WORKFLOW_ROLES_REMEDIES = (
    "Install the workflow-roles pack from the SprintEngine Studio skill source, "
    "or put your own role skills in your skills folder (~/.multicode/skills) — "
    'add or change it under Extensions → Skills → "Add from folder…".'
)
NO_WORKFLOW_ROLES_INSTALLED = f"{NO_WORKFLOW_ROLES_HEAD} {NO_WORKFLOW_ROLES_REMEDIES}"
MISSING_ROLE_REMEDIES = NO_WORKFLOW_ROLES_REMEDIES

# `sprintengine.soul.get` / `soul get` stay registered until this Studio
# release, then they go. Recorded 2026-09-16 (MC-2508, one-release alias).
SOUL_GET_REMOVAL_RELEASE = "0.5.0"
SOUL_GET_MCP_DEPRECATED = (
    "sprintengine.soul.get is deprecated; use sprintengine.roles.brief. "
    f"Removed in SprintEngine Studio {SOUL_GET_REMOVAL_RELEASE}."
)
SOUL_GET_CLI_DEPRECATED = (
    "sprintengine soul get is deprecated; use sprintengine roles brief. "
    f"Removed in SprintEngine Studio {SOUL_GET_REMOVAL_RELEASE}."
)


def normalize_role_id(value: str) -> str:
    return value.strip().lower().replace("-", "_")


def resolve_workspace_root(workspace_root: Path | str | None = None) -> Path:
    if workspace_root is not None:
        return Path(workspace_root)
    active = active_workspace_root.get()
    if active is not None:
        return Path(active)
    return Path.cwd()


@dataclass(frozen=True)
class RegistryWarning:
    code: str
    message: str
    path: Path | None = None
    role_id: str | None = None
    skill_id: str | None = None
    source_layer: str | None = None


@dataclass(frozen=True)
class SourceLayer:
    name: str
    root: Path
    precedence: int


@dataclass(frozen=True)
class SourceEntry:
    layer: SourceLayer
    path: Path


@dataclass(frozen=True)
class RoleManifest:
    id: str
    label: str
    description: str | None
    icon: str | None
    # Empty after the alias table was dropped. Kept so `souls` JSON and the
    # roles.list wire shape stay stable for one release.
    aliases: tuple[str, ...] = ()

    @property
    def normalized_id(self) -> str:
        return normalize_role_id(self.id)

    def directives_for_phase(self, phase: str) -> tuple[Any, ...]:
        """Role-scoped phase packs died with the manifest. The shared base pack is the whole directive."""
        return ()


@dataclass(frozen=True)
class SkillDocument:
    id: str
    path: Path
    frontmatter: Mapping[str, Any]
    body: str


@dataclass(frozen=True)
class RenderedSoul:
    role: RoleManifest
    content: str
    warnings: tuple[RegistryWarning, ...]


@dataclass(frozen=True)
class RegistryEntry:
    value: RoleManifest | SkillDocument
    source: SourceEntry
    shadowed: tuple[SourceEntry, ...] = ()


class SoulRenderError(RuntimeError):
    def __init__(self, message: str, warnings: Iterable[RegistryWarning] = ()) -> None:
        super().__init__(message)
        self.warnings = tuple(warnings)


class MissingRoleError(KeyError):
    """A requested role id has no installed skill declaring it.

    Subclasses KeyError so existing `except KeyError` paths still fire; the
    message names the spelling that failed and the two remedies, never a
    substitute role.
    """

    def __init__(self, role_id: str, *, known_roles: Iterable[str] = ()) -> None:
        self.role_id = role_id
        self.known_roles = tuple(sorted(known_roles))
        if self.known_roles:
            message = (
                f"Unknown role {role_id!r}: no skill declaring it is installed in this workspace. "
                f"{MISSING_ROLE_REMEDIES} Known roles: {', '.join(self.known_roles)}."
            )
        else:
            message = (
                f"Unknown role {role_id!r}: no workflow roles are installed in this workspace. "
                f"{MISSING_ROLE_REMEDIES}"
            )
        super().__init__(message)
        self.message = message

    def __str__(self) -> str:
        return self.message


@dataclass(frozen=True)
class RegistryDiscovery:
    roles: Mapping[str, RegistryEntry]
    skills: Mapping[str, RegistryEntry]
    aliases: Mapping[str, str]
    warnings: tuple[RegistryWarning, ...]
    # Package-owned host layers (norms, product skills, phase packs). extra_skills
    # reads from here so an installable workspace skill of the same id cannot
    # substitute for them. The skills map stays first-hit-wins so a workspace
    # can still shadow a phase pack for listing and phase composition.
    host_skills: Mapping[str, RegistryEntry] = field(default_factory=dict)

    def get_role(self, role_or_alias: str) -> RoleManifest:
        normalized = normalize_role_id(role_or_alias)
        entry = self.roles.get(normalized)
        if entry is None or not isinstance(entry.value, RoleManifest):
            raise MissingRoleError(role_or_alias, known_roles=self.roles)
        return entry.value

    def role_entry(self, role_or_alias: str) -> RegistryEntry:
        role = self.get_role(role_or_alias)
        return self.roles[role.normalized_id]

    def layer_skill(self, skill_id: str) -> RegistryEntry | None:
        """The packaged host-layer copy of a skill, else the first-hit skills map."""
        entry = self.host_skills.get(skill_id) or self.skills.get(skill_id)
        if entry is None or not isinstance(entry.value, SkillDocument):
            return None
        return entry

    def referenced_skills(self, role_or_alias: str) -> tuple[SkillDocument, ...]:
        role = self.get_role(role_or_alias)
        entry = self.skills.get(role.normalized_id)
        if entry is None or not isinstance(entry.value, SkillDocument):
            return ()
        return (entry.value,)

    def render_soul(
        self,
        role_or_alias: str,
        *,
        workspace_root: Path | str,
        run_id: str = "",
        extra_skills: Iterable[str] = (),
    ) -> RenderedSoul:
        """Render a role's startup brief.

        The skill body (frontmatter stripped) is the role's working identity,
        wrapped in the ``<skill name="…">`` envelope. ``extra_skills`` are
        host-supplied layer skills (studio product skills, Sprint Engine quality
        norms) appended after it so a pack author never has to reference them.
        A missing role skill is a hard render error; a missing ``extra_skills``
        entry is a warning and is skipped, since host layers must degrade rather
        than block a spawn.
        """
        role = self.get_role(role_or_alias)
        warnings: list[RegistryWarning] = []
        content_parts: list[str] = []
        variables = {
            "role": role.id,
            "role_label": role.label,
            "workspace_root": str(workspace_root),
            "run_id": run_id,
        }

        skill_id = role.normalized_id
        entry = self.skills.get(skill_id)
        if entry is None or not isinstance(entry.value, SkillDocument):
            warning = RegistryWarning(
                code="missing_render_skill",
                message=f"Role {role.id!r} cannot render because skill {skill_id!r} is missing or invalid.",
                role_id=role.id,
                skill_id=skill_id,
            )
            raise SoulRenderError(warning.message, (*self.warnings, warning))
        body = entry.value.body.strip()
        if body:
            content_parts.append(_wrap_skill_envelope(skill_id, body))

        seen_skill_ids = {skill_id}
        for raw_skill in extra_skills:
            extra_id = normalize_role_id(raw_skill)
            if extra_id in seen_skill_ids:
                continue
            seen_skill_ids.add(extra_id)
            extra_entry = self.layer_skill(extra_id)
            if extra_entry is None:
                warnings.append(
                    RegistryWarning(
                        code="missing_layer_skill",
                        message=f"Host layer skill {raw_skill!r} is missing or invalid; skipping.",
                        role_id=role.id,
                        skill_id=raw_skill,
                    )
                )
                continue
            extra_body = extra_entry.value.body.strip()
            if extra_body:
                content_parts.append(_wrap_skill_envelope(extra_id, extra_body))

        content = "\n\n".join((SOUL_LEGEND, *content_parts))
        rendered = _substitute_supported_variables(content, variables, role, warnings)
        return RenderedSoul(role=role, content=rendered, warnings=(*self.warnings, *warnings))


SOUL_LEGEND = (
    "<soul-legend>\n"
    "Sections tagged <what-to-do> are the mandatory core of each skill; sections tagged "
    "<supporting-info> are reference detail to consult when the work touches them. When "
    "they conflict, <what-to-do> wins. Each <skill> block names the source skill for the "
    "content it wraps.\n"
    "</soul-legend>"
)


def _wrap_skill_envelope(skill_id: str, body: str) -> str:
    return f'<skill name="{skill_id}">\n{body}\n</skill>'


class RoleSkillRegistry:
    def __init__(self, *, workspace_root: Path | str | None = None) -> None:
        self.workspace_root = resolve_workspace_root(workspace_root)

    def discover(self) -> RegistryDiscovery:
        warnings: list[RegistryWarning] = []
        roles: dict[str, RegistryEntry] = {}
        skills: dict[str, RegistryEntry] = {}

        for precedence, harness in enumerate(HARNESS_DIRECTORIES):
            layer = SourceLayer("workspace", self.workspace_root / harness, precedence)
            self._ingest_skill_dir(
                self.workspace_root / harness / "skills",
                layer,
                roles,
                skills,
                warnings,
            )

        host_precedence = len(HARNESS_DIRECTORIES)
        if os.environ.get(TEST_BUNDLED_WORKFLOW_ROLES_ENV) == "1":
            bundled_roles_layer = SourceLayer(
                "bundled",
                BUNDLED_WORKFLOW_ROLES_SKILLS,
                host_precedence,
            )
            self._ingest_skill_dir(
                BUNDLED_WORKFLOW_ROLES_SKILLS,
                bundled_roles_layer,
                roles,
                skills,
                warnings,
            )
            host_precedence += 1

        host_skills: dict[str, RegistryEntry] = {}
        host_layer = SourceLayer(
            "bundled",
            BUNDLED_HOST_SKILLS_ROOT,
            host_precedence,
        )
        self._ingest_skill_dir(
            BUNDLED_HOST_SKILLS_ROOT,
            host_layer,
            roles,
            skills,
            warnings,
            as_roles=False,
            host_skills=host_skills,
        )

        return RegistryDiscovery(
            roles=roles,
            skills=skills,
            aliases={role_id: role_id for role_id in roles},
            warnings=tuple(warnings),
            host_skills=host_skills,
        )

    def _ingest_skill_dir(
        self,
        skills_dir: Path,
        layer: SourceLayer,
        roles: dict[str, RegistryEntry],
        skills: dict[str, RegistryEntry],
        warnings: list[RegistryWarning],
        *,
        as_roles: bool = True,
        host_skills: dict[str, RegistryEntry] | None = None,
    ) -> None:
        if not skills_dir.is_dir():
            return
        for path in _iter_skill_files(skills_dir):
            skill_id = normalize_role_id(path.parent.name)
            document = _load_skill_document(skill_id, path, layer, warnings)
            if document is None:
                continue
            source = SourceEntry(layer, path)
            entry = RegistryEntry(value=document, source=source)
            # First hit wins on the skills map (workspace harnesses, then the
            # bundled pack). Host ingest also records a package-owned copy so
            # extra_skills cannot be substituted by an installable skill of the
            # same id; a workspace can still shadow a phase pack via skills.
            if skill_id not in skills:
                skills[skill_id] = entry
            if host_skills is not None:
                host_skills[skill_id] = entry
            if not as_roles:
                continue
            manifest = _role_from_skill(document)
            if manifest is None:
                continue
            if manifest.normalized_id not in roles:
                roles[manifest.normalized_id] = RegistryEntry(value=manifest, source=source)


def role_manifest_payload(role: RoleManifest) -> dict[str, Any]:
    """The wire shape of a role, shared by the CLI and MCP surfaces."""
    return {
        "id": role.id,
        "label": role.label,
        "aliases": list(role.aliases),
        "description": role.description,
        "icon": role.icon,
    }


def discover_role_registry(*, workspace_root: Path | str | None = None) -> RegistryDiscovery:
    """Scan the workspace's harness skill directories. First hit wins.

    ``workspace_root`` is the only input. When omitted, the active workspace
    declared on the current call is used, then ``Path.cwd()``.
    """
    return RoleSkillRegistry(workspace_root=workspace_root).discover()


def _iter_skill_files(skills_dir: Path) -> tuple[Path, ...]:
    paths: list[Path] = []
    try:
        children = sorted(skills_dir.iterdir(), key=lambda item: item.name)
    except OSError:
        return ()
    for child in children:
        if not child.is_dir() or child.name.startswith("."):
            continue
        path = child / "SKILL.md"
        if path.is_file():
            paths.append(path)
    return tuple(paths)


def _role_from_skill(document: SkillDocument) -> RoleManifest | None:
    metadata = _metadata_map(document.frontmatter)
    if metadata is None:
        return None
    raw_role_id = metadata.get(ROLE_METADATA_KEY)
    if not isinstance(raw_role_id, str) or not raw_role_id.strip():
        return None
    role_id = normalize_role_id(raw_role_id)
    raw_label = metadata.get(ROLE_LABEL_KEY)
    label = (
        raw_label.strip()
        if isinstance(raw_label, str) and raw_label.strip()
        else role_id.replace("_", " ").title()
    )
    raw_icon = metadata.get(ROLE_ICON_KEY)
    icon = raw_icon.strip() if isinstance(raw_icon, str) and raw_icon.strip() else None
    raw_description = document.frontmatter.get("description")
    description = (
        raw_description.strip()
        if isinstance(raw_description, str) and raw_description.strip()
        else None
    )
    return RoleManifest(id=role_id, label=label, description=description, icon=icon)


def _metadata_map(frontmatter: Mapping[str, Any]) -> Mapping[str, Any] | None:
    metadata = frontmatter.get("metadata")
    if not isinstance(metadata, Mapping):
        return None
    return metadata


def _load_skill_document(
    skill_id: str,
    path: Path,
    layer: SourceLayer,
    warnings: list[RegistryWarning],
) -> SkillDocument | None:
    try:
        content = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        warnings.append(
            RegistryWarning(
                code="broken_skill_document",
                message=f"Could not load skill document: {exc}",
                path=path,
                skill_id=skill_id,
                source_layer=layer.name,
            )
        )
        return None

    if not content.strip():
        warnings.append(_skill_warning("broken_skill_document", "Skill document is empty.", path, layer, skill_id))
        return None

    frontmatter: Mapping[str, Any] = {}
    body = content
    if content.startswith("---\n") or content.startswith("---\r\n"):
        match = re.search(r"\A---\r?\n(.*?)\r?\n---\r?\n?(.*)\Z", content, flags=re.DOTALL)
        if match is None:
            warnings.append(_skill_warning("broken_skill_document", "Skill frontmatter is not closed.", path, layer, skill_id))
            return None
        try:
            parsed = yaml.safe_load(match.group(1)) if match.group(1).strip() else {}
        except yaml.YAMLError as exc:
            warnings.append(_skill_warning("broken_skill_document", f"Skill frontmatter is invalid: {exc}", path, layer, skill_id))
            return None
        if parsed is None:
            parsed = {}
        if not isinstance(parsed, dict):
            warnings.append(_skill_warning("broken_skill_document", "Skill frontmatter must be a mapping.", path, layer, skill_id))
            return None
        frontmatter = parsed
        body = match.group(2)

    if not body.strip():
        warnings.append(_skill_warning("broken_skill_document", "Skill body is empty.", path, layer, skill_id))
        return None

    return SkillDocument(id=skill_id, path=path, frontmatter=frontmatter, body=body)


def _substitute_supported_variables(
    content: str,
    variables: Mapping[str, str],
    role: RoleManifest,
    warnings: list[RegistryWarning],
) -> str:
    def replace(match: re.Match[str]) -> str:
        expression = match.group(1).strip()
        if expression in SUPPORTED_TEMPLATE_VARIABLES:
            return variables[expression]
        warnings.append(
            RegistryWarning(
                code="unsupported_template_variable",
                message=f"Unsupported template variable {expression!r} in role {role.id!r}; leaving placeholder unchanged.",
                role_id=role.id,
            )
        )
        return match.group(0)

    return TEMPLATE_PATTERN.sub(replace, content)


def _skill_warning(
    code: str,
    message: str,
    path: Path,
    layer: SourceLayer,
    skill_id: str,
) -> RegistryWarning:
    return RegistryWarning(code=code, message=message, path=path, skill_id=skill_id, source_layer=layer.name)
