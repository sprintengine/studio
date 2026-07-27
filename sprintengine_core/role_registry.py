from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping

import yaml


REGISTRY_DIRNAME = ".sprintengine"
BUNDLED_REGISTRY_ROOT = Path(__file__).resolve().parents[1] / "resources" / "sprintengine"

# Session channel carrying the dynamic plugin/pack registry roots the running app
# discovered for this process, as JSON: [{"id": "...", "root": "..."}]. Set on
# agent terminals at spawn (withSprintEngineEnv in src/main/terminal-launch.ts).
# Plugin roots are dynamic — only the running app knows which plugins are
# installed — so they must be passed in rather than discovered statically.
SESSION_REGISTRY_ROOTS_ENV = "MULTICODE_SPRINTENGINE_REGISTRY_ROOTS"

# Canonical Multicode user-level registry root, where the app installs the
# specialist pack and user-added roles. MUST stay in sync with
# defaultUserRoleRegistryRoot() in src/main/sprintengine-role-registry.ts.
# Discovered NATIVELY by every bare `discover_role_registry()` (role
# validation, prompt composition), matching souls.registry: an installed role
# must resolve identically whether the engine CLI was spawned by the app, an
# agent terminal, or a bare shell — otherwise the engine rejects roles the spawn
# menu just offered.
# The env override exists for hermeticity: tests (and any embedder that must
# not read the machine's home) point it at a directory they control.
USER_REGISTRY_ROOT_ENV = "MULTICODE_SPRINTENGINE_USER_REGISTRY_ROOT"


def multicode_user_registry_root() -> Path:
    raw = os.environ.get(USER_REGISTRY_ROOT_ENV, "").strip()
    return Path(raw).expanduser() if raw else Path.home() / ".multicode" / "sprintengine-roles"
SUPPORTED_TEMPLATE_VARIABLES = frozenset({"role", "role_label", "workspace_root", "run_id"})
TEMPLATE_PATTERN = re.compile(r"{{\s*([^{}]+?)\s*}}")

# v2 manifest vocabulary (MC-1542). A role is routing + directive packs:
# `directives.implement` composes the owner's startup brief, and one entry per
# post-implementation phase composes that phase's directive. The shipped phase
# vocabulary is `review` only; the map is keyed by phase name so a future phase
# needs no schema change.
IMPLEMENT_DIRECTIVE = "implement"
DIRECTIVE_PHASES: tuple[str, ...] = ("review",)
DIRECTIVE_KEYS: tuple[str, ...] = (IMPLEMENT_DIRECTIVE, *DIRECTIVE_PHASES)

# Keys removed by earlier manifest revisions. Parsing rejects them by name so a
# stale pack fails loudly with its replacement rather than silently losing its
# identity.
REMOVED_MANIFEST_KEYS: dict[str, str] = {
    "soul": (
        "'soul' was removed in the v2 role manifest. Use "
        "\"directives\": {\"implement\": [{\"skill\": \"<id>\"}]}."
    ),
    "capabilities": (
        "'capabilities' was removed in the v2 role manifest. Review-only roles no longer exist: "
        "a reviewer is an ordinary implementer, and role-scoped review content goes in "
        "\"directives\": {\"review\": [{\"skill\": \"<id>\"}]}."
    ),
}

# Keys renamed rather than deleted. An installed pack predating the rename must
# keep loading — its roles are how a user's runs are staffed — so the old key is
# a warning, not a rejection, and its value is NOT read as the new field: the
# author renames it and writes the fuller text the new field asks for.
RENAMED_MANIFEST_KEYS: dict[str, str] = {
    "summary": (
        "'summary' was renamed to 'description' (MC-1831) and is ignored. A role's capabilities are "
        "prose the architect reads: say what the role does and when a sprint should staff it."
    ),
}


def normalize_role_id(value: str) -> str:
    return value.strip().lower().replace("-", "_")


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

    @property
    def roles_dir(self) -> Path:
        return self.root / "roles"

    @property
    def skills_dir(self) -> Path:
        return self.root / "skills"


@dataclass(frozen=True)
class SourceEntry:
    layer: SourceLayer
    path: Path


@dataclass(frozen=True)
class PluginRegistryRoot:
    root: Path
    plugin_id: str | None = None


@dataclass(frozen=True)
class DirectiveSkillEntry:
    skill: str


@dataclass(frozen=True)
class RoleManifest:
    id: str
    label: str
    aliases: tuple[str, ...]
    # The role's whole capability statement, in prose: what it does and when to
    # staff it. The architect plans from it; nothing in the engine derives
    # behaviour from its text. Absent only for a manifest written before the
    # field existed, which still loads (see RENAMED_MANIFEST_KEYS).
    description: str | None
    icon: str | None
    # phase key -> ordered skills. Always carries a non-empty `implement` entry.
    directives: Mapping[str, tuple[DirectiveSkillEntry, ...]]

    @property
    def normalized_id(self) -> str:
        return normalize_role_id(self.id)

    def all_lookup_names(self) -> tuple[str, ...]:
        return (self.id, *self.aliases)

    @property
    def implement_directives(self) -> tuple[DirectiveSkillEntry, ...]:
        return self.directives.get(IMPLEMENT_DIRECTIVE, ())

    def directives_for_phase(self, phase: str) -> tuple[DirectiveSkillEntry, ...]:
        """Role-specific additions appended to a phase's shared base pack."""
        return self.directives.get(normalize_role_id(phase), ())

    def all_directive_skills(self) -> tuple[DirectiveSkillEntry, ...]:
        return tuple(entry for key in DIRECTIVE_KEYS for entry in self.directives.get(key, ()))


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
    shadowed: tuple[SourceEntry, ...]


class SoulRenderError(RuntimeError):
    def __init__(self, message: str, warnings: Iterable[RegistryWarning] = ()) -> None:
        super().__init__(message)
        self.warnings = tuple(warnings)


@dataclass(frozen=True)
class RegistryDiscovery:
    roles: Mapping[str, RegistryEntry]
    skills: Mapping[str, RegistryEntry]
    aliases: Mapping[str, str]
    warnings: tuple[RegistryWarning, ...]

    def get_role(self, role_or_alias: str) -> RoleManifest:
        normalized = normalize_role_id(role_or_alias)
        canonical = self.aliases.get(normalized, normalized)
        entry = self.roles.get(canonical)
        if entry is None or not isinstance(entry.value, RoleManifest):
            known = ", ".join(sorted(self.roles))
            raise KeyError(f"Unknown registry role: {role_or_alias}. Known roles: {known}.")
        return entry.value

    def role_entry(self, role_or_alias: str) -> RegistryEntry:
        role = self.get_role(role_or_alias)
        return self.roles[role.normalized_id]

    def referenced_skills(self, role_or_alias: str) -> tuple[SkillDocument, ...]:
        role = self.get_role(role_or_alias)
        documents: list[SkillDocument] = []
        for directive_entry in role.implement_directives:
            entry = self.skills.get(normalize_role_id(directive_entry.skill))
            if entry is not None and isinstance(entry.value, SkillDocument):
                documents.append(entry.value)
        return tuple(documents)

    def render_soul(
        self,
        role_or_alias: str,
        *,
        workspace_root: Path | str,
        run_id: str = "",
        extra_skills: Iterable[str] = (),
    ) -> RenderedSoul:
        """Render a role's startup brief.

        The manifest's ``directives.implement`` skills are the role's working
        identity, composed first. ``extra_skills`` are host-supplied layer skills
        (Multicode product skills, Sprint Engine quality norms) appended after
        them so a pack author never has to reference them. A missing manifest
        skill is a hard render error (the brief is broken); a missing
        ``extra_skills`` entry is a warning and is skipped, since host layers must
        degrade rather than block a spawn.

        Phase directives (``directives.review``) are NOT composed here — they are
        delivered later, inside the owner's ``publish``/``advance`` tool responses
        (see ``sprintengine_core.tool.phase_prompts``).
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

        for directive_entry in role.implement_directives:
            skill_id = normalize_role_id(directive_entry.skill)
            entry = self.skills.get(skill_id)
            if entry is None or not isinstance(entry.value, SkillDocument):
                warning = RegistryWarning(
                    code="missing_render_skill",
                    message=f"Role {role.id!r} cannot render because skill {directive_entry.skill!r} is missing or invalid.",
                    role_id=role.id,
                    skill_id=directive_entry.skill,
                )
                raise SoulRenderError(warning.message, (*self.warnings, warning))
            body = entry.value.body.strip()
            if body:
                content_parts.append(_wrap_skill_envelope(skill_id, body))

        seen_skill_ids = {normalize_role_id(entry.skill) for entry in role.implement_directives}
        for raw_skill in extra_skills:
            skill_id = normalize_role_id(raw_skill)
            if skill_id in seen_skill_ids:
                continue
            seen_skill_ids.add(skill_id)
            entry = self.skills.get(skill_id)
            if entry is None or not isinstance(entry.value, SkillDocument):
                warnings.append(
                    RegistryWarning(
                        code="missing_layer_skill",
                        message=f"Host layer skill {raw_skill!r} is missing or invalid; skipping.",
                        role_id=role.id,
                        skill_id=raw_skill,
                    )
                )
                continue
            body = entry.value.body.strip()
            if body:
                content_parts.append(_wrap_skill_envelope(skill_id, body))

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
    def __init__(
        self,
        *,
        workspace_root: Path | None = None,
        plugin_roots: Iterable[Path | str | PluginRegistryRoot | Mapping[str, Any]] = (),
        user_root: Path | None = None,
        bundled_root: Path | None = None,
    ) -> None:
        self.workspace_root = Path(workspace_root) if workspace_root is not None else Path.cwd()
        self.plugin_roots = tuple(_normalize_plugin_root(root) for root in plugin_roots)
        self.user_root = Path(user_root).expanduser() if user_root is not None else Path.home()
        self.bundled_root = Path(bundled_root) if bundled_root is not None else BUNDLED_REGISTRY_ROOT

    def source_layers(self) -> tuple[SourceLayer, ...]:
        layers = [SourceLayer("workspace", self.workspace_root / REGISTRY_DIRNAME, 0)]
        layers.extend(
            SourceLayer(_plugin_layer_name(plugin_root, index), plugin_root.root, index + 1)
            for index, plugin_root in enumerate(self.plugin_roots)
        )
        layers.append(SourceLayer("user", self.user_root / REGISTRY_DIRNAME, len(layers)))
        layers.append(SourceLayer("bundled", self.bundled_root, len(layers)))
        return tuple(layers)

    def discover(self) -> RegistryDiscovery:
        warnings: list[RegistryWarning] = []
        roles = self._discover_roles(warnings)
        skills = self._discover_skills(warnings)
        alias_map = self._build_aliases(roles, warnings)
        self._warn_for_missing_referenced_skills(roles, skills, warnings)
        return RegistryDiscovery(
            roles=roles,
            skills=skills,
            aliases=alias_map,
            warnings=tuple(warnings),
        )

    def _discover_roles(self, warnings: list[RegistryWarning]) -> dict[str, RegistryEntry]:
        candidates: dict[str, list[tuple[RoleManifest, SourceEntry]]] = {}
        for layer in self.source_layers():
            if not layer.roles_dir.exists():
                continue
            for path in sorted(layer.roles_dir.glob("*.json")):
                manifest = _load_role_manifest(path, layer, warnings)
                if manifest is None:
                    continue
                candidates.setdefault(manifest.normalized_id, []).append((manifest, SourceEntry(layer, path)))
        return _select_winning_entries(candidates)

    def _discover_skills(self, warnings: list[RegistryWarning]) -> dict[str, RegistryEntry]:
        candidates: dict[str, list[tuple[SkillDocument, SourceEntry]]] = {}
        for layer in self.source_layers():
            if not layer.skills_dir.exists():
                continue
            for path in sorted(layer.skills_dir.glob("*/SKILL.md")):
                skill_id = normalize_role_id(path.parent.name)
                document = _load_skill_document(skill_id, path, layer, warnings)
                if document is None:
                    continue
                candidates.setdefault(skill_id, []).append((document, SourceEntry(layer, path)))
        return _select_winning_entries(candidates)

    def _build_aliases(
        self,
        roles: Mapping[str, RegistryEntry],
        warnings: list[RegistryWarning],
    ) -> dict[str, str]:
        aliases: dict[str, str] = {}
        for role_id in sorted(roles):
            entry = roles[role_id]
            role = entry.value
            if not isinstance(role, RoleManifest):
                continue
            for raw_name in role.all_lookup_names():
                normalized = normalize_role_id(raw_name)
                existing = aliases.get(normalized)
                if existing is None:
                    aliases[normalized] = role.normalized_id
                    continue
                if existing != role.normalized_id:
                    warnings.append(
                        RegistryWarning(
                            code="alias_conflict",
                            message=(
                                f"Alias {raw_name!r} for role {role.id!r} conflicts with role "
                                f"{existing!r}; keeping {existing!r}."
                            ),
                            path=entry.source.path,
                            role_id=role.id,
                            source_layer=entry.source.layer.name,
                        )
                    )
        return aliases

    def _warn_for_missing_referenced_skills(
        self,
        roles: Mapping[str, RegistryEntry],
        skills: Mapping[str, RegistryEntry],
        warnings: list[RegistryWarning],
    ) -> None:
        for role_id in sorted(roles):
            entry = roles[role_id]
            role = entry.value
            if not isinstance(role, RoleManifest):
                continue
            for directive_entry in role.all_directive_skills():
                skill_id = normalize_role_id(directive_entry.skill)
                if skill_id not in skills:
                    warnings.append(
                        RegistryWarning(
                            code="missing_referenced_skill",
                            message=f"Role {role.id!r} references missing skill {directive_entry.skill!r}.",
                            path=entry.source.path,
                            role_id=role.id,
                            skill_id=directive_entry.skill,
                            source_layer=entry.source.layer.name,
                        )
                    )


def role_manifest_payload(role: RoleManifest) -> dict[str, Any]:
    """The wire shape of a v2 role manifest, shared by the CLI and MCP surfaces."""
    return {
        "id": role.id,
        "label": role.label,
        "aliases": list(role.aliases),
        "description": role.description,
        "icon": role.icon,
        "directives": {
            key: [{"skill": entry.skill} for entry in role.directives[key]]
            for key in DIRECTIVE_KEYS
            if key in role.directives
        },
    }


def session_registry_roots_from_env(
    env: Mapping[str, str] | None = None,
) -> list[dict[str, str]]:
    """Plugin registry roots the app injected via ``SESSION_REGISTRY_ROOTS_ENV``.

    Parses the env's JSON ``[{"id": "...", "root": "..."}]`` into plugin-root
    mappings (``_normalize_plugin_root`` consumes them), skipping malformed
    entries rather than failing discovery. The mapping form is intentional: it is
    JSON-serialisable, so callers that cache-key their discovery on the roots (the
    MCP role classifier) round-trip it losslessly. Returns an empty list when the
    env is unset or unparseable, so a raw install resolves no extra roots.
    """
    source = os.environ if env is None else env
    raw = source.get(SESSION_REGISTRY_ROOTS_ENV, "").strip()
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
        if not isinstance(entry, Mapping):
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


def discover_role_registry(
    *,
    workspace_root: Path | None = None,
    plugin_roots: Iterable[Path | str | PluginRegistryRoot | Mapping[str, Any]] | None = None,
    user_root: Path | None = None,
    bundled_root: Path | None = None,
) -> RegistryDiscovery:
    # Omitting plugin_roots reads the app-injected session roots from the
    # environment AND the canonical user-install root, so every bare direct-core
    # discovery (CLI role validation, prompt composition) resolves an installed
    # specialist pack — same order as souls.registry and the app's spawn-menu
    # discovery: session roots first, install root last.
    # Callers that pass plugin_roots explicitly (the MCP server from its payload,
    # the registry-inspection CLI from --extra-dir) opt out of both and stay
    # hermetic.
    if plugin_roots is None:
        # Existence-check the env-derived roots. The app injects session roots for
        # whatever it believes is installed, and the canonical user-install root
        # is always searched — but either may name a directory that is not on disk
        # (a pack the app recorded but never unpacked, or the user root before the
        # first install). A missing root contributes nothing, and dropping it here
        # keeps discovery honest instead of leaning on the per-subdirectory
        # `.exists()` skips deep inside the walk; it also means a hermetic caller
        # can neutralize a root by pointing the env at a path that does not exist.
        plugin_roots = [
            root
            for root in (*session_registry_roots_from_env(), multicode_user_registry_root())
            if _normalize_plugin_root(root).root.exists()
        ]
    return RoleSkillRegistry(
        workspace_root=workspace_root,
        plugin_roots=plugin_roots,
        user_root=user_root,
        bundled_root=bundled_root,
    ).discover()


def _normalize_plugin_root(value: Path | str | PluginRegistryRoot | Mapping[str, Any]) -> PluginRegistryRoot:
    if isinstance(value, PluginRegistryRoot):
        return PluginRegistryRoot(root=Path(value.root), plugin_id=value.plugin_id)
    if isinstance(value, Mapping):
        raw_root = value.get("root") or value.get("path")
        if not isinstance(raw_root, (str, Path)):
            raise TypeError("Plugin registry root mappings require a string root or path.")
        raw_plugin_id = value.get("id") or value.get("pluginId") or value.get("plugin_id")
        plugin_id = str(raw_plugin_id).strip() if raw_plugin_id is not None and str(raw_plugin_id).strip() else None
        return PluginRegistryRoot(root=Path(raw_root), plugin_id=plugin_id)
    return PluginRegistryRoot(root=Path(value))


def _plugin_layer_name(plugin_root: PluginRegistryRoot, index: int) -> str:
    if plugin_root.plugin_id:
        safe_id = re.sub(r"[^A-Za-z0-9_.-]+", "_", plugin_root.plugin_id.strip())
        if safe_id:
            return f"plugin:{safe_id}"
    return f"plugin:{index}"


def _select_winning_entries(
    candidates: Mapping[str, list[tuple[RoleManifest, SourceEntry]]]
    | Mapping[str, list[tuple[SkillDocument, SourceEntry]]],
) -> dict[str, RegistryEntry]:
    entries: dict[str, RegistryEntry] = {}
    for item_id, discovered in candidates.items():
        ordered = sorted(discovered, key=lambda item: (item[1].layer.precedence, str(item[1].path)))
        winner, source = ordered[0]
        shadowed = tuple(candidate_source for _, candidate_source in ordered[1:])
        entries[item_id] = RegistryEntry(value=winner, source=source, shadowed=shadowed)
    return entries


def _load_role_manifest(path: Path, layer: SourceLayer, warnings: list[RegistryWarning]) -> RoleManifest | None:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        warnings.append(
            RegistryWarning(
                code="malformed_role_manifest",
                message=f"Could not load role manifest: {exc}",
                path=path,
                source_layer=layer.name,
            )
        )
        return None

    if not isinstance(raw, dict):
        warnings.append(_role_warning("malformed_role_manifest", "Role manifest must be a JSON object.", path, layer))
        return None

    role_id = _required_string(raw, "id")
    label = _required_string(raw, "label")
    description = _required_string(raw, "description")
    if role_id is None or label is None:
        warnings.append(_role_warning("invalid_role_manifest", "Role manifest requires string id and label.", path, layer))
        return None
    aliases = raw.get("aliases", [])
    if aliases is None:
        aliases = []
    if not isinstance(aliases, list) or any(not isinstance(alias, str) or not alias.strip() for alias in aliases):
        warnings.append(_role_warning("invalid_role_manifest", "Role aliases must be a list of non-empty strings.", path, layer, role_id))
        return None

    for removed_key, guidance in REMOVED_MANIFEST_KEYS.items():
        if removed_key in raw:
            warnings.append(_role_warning("v1_role_manifest", guidance, path, layer, role_id))
            return None

    for renamed_key, guidance in RENAMED_MANIFEST_KEYS.items():
        if renamed_key in raw:
            warnings.append(_role_warning("renamed_manifest_key", guidance, path, layer, role_id))

    directives = _parse_role_directives(raw.get("directives"))
    if directives is None:
        warnings.append(
            _role_warning(
                "invalid_role_manifest",
                "Role directives must be an object with a non-empty 'implement' list of {\"skill\": id} entries; "
                f"optional phase keys are limited to: {', '.join(DIRECTIVE_PHASES)}.",
                path,
                layer,
                role_id,
            )
        )
        return None

    icon = raw.get("icon")
    if icon is not None and not isinstance(icon, str):
        warnings.append(_role_warning("invalid_role_manifest", "Role icon must be a string when present.", path, layer, role_id))
        return None

    return RoleManifest(
        id=normalize_role_id(role_id),
        label=label.strip(),
        aliases=tuple(alias.strip() for alias in aliases),
        description=description,
        icon=icon.strip() if isinstance(icon, str) and icon.strip() else None,
        directives=directives,
    )


def _parse_directive_entries(raw: Any) -> tuple[DirectiveSkillEntry, ...] | None:
    if not isinstance(raw, list) or not raw:
        return None
    entries: list[DirectiveSkillEntry] = []
    for entry in raw:
        if not isinstance(entry, dict) or set(entry) != {"skill"}:
            return None
        skill = entry.get("skill")
        if not isinstance(skill, str) or not skill.strip():
            return None
        entries.append(DirectiveSkillEntry(skill=normalize_role_id(skill)))
    return tuple(entries)


def _parse_role_directives(raw: Any) -> dict[str, tuple[DirectiveSkillEntry, ...]] | None:
    """Parse `directives`, or None when malformed.

    `implement` is required and non-empty. Any other key must name a shipped
    phase; an unknown key is a hard reject so a typo never silently drops a
    directive pack.
    """
    if not isinstance(raw, dict) or not raw:
        return None
    if any(key not in DIRECTIVE_KEYS for key in raw):
        return None
    parsed: dict[str, tuple[DirectiveSkillEntry, ...]] = {}
    for key in DIRECTIVE_KEYS:
        if key not in raw:
            continue
        entries = _parse_directive_entries(raw[key])
        if entries is None:
            return None
        parsed[key] = entries
    if IMPLEMENT_DIRECTIVE not in parsed:
        return None
    return parsed


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


def _required_string(raw: Mapping[str, Any], key: str) -> str | None:
    value = raw.get(key)
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip()


def _role_warning(
    code: str,
    message: str,
    path: Path,
    layer: SourceLayer,
    role_id: str | None = None,
) -> RegistryWarning:
    return RegistryWarning(code=code, message=message, path=path, role_id=role_id, source_layer=layer.name)


def _skill_warning(
    code: str,
    message: str,
    path: Path,
    layer: SourceLayer,
    skill_id: str,
) -> RegistryWarning:
    return RegistryWarning(code=code, message=message, path=path, skill_id=skill_id, source_layer=layer.name)
