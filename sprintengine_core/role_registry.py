from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping

import yaml


REGISTRY_DIRNAME = ".sprintengine"
BUNDLED_REGISTRY_ROOT = Path(__file__).resolve().parents[1] / "resources" / "sprintengine"
SUPPORTED_TEMPLATE_VARIABLES = frozenset({"role", "role_label", "workspace_root", "run_id"})
TEMPLATE_PATTERN = re.compile(r"{{\s*([^{}]+?)\s*}}")
CAPABILITY_TAG_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,62}$")


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
class SoulSkillEntry:
    skill: str


@dataclass(frozen=True)
class RoleCapability:
    kind: str
    phase: str | None = None
    reviews: tuple[str, ...] = ()
    default_focus: str | None = None


@dataclass(frozen=True)
class RoleManifest:
    id: str
    label: str
    aliases: tuple[str, ...]
    summary: str | None
    icon: str | None
    soul: tuple[SoulSkillEntry, ...]
    capabilities: tuple[RoleCapability, ...] = ()

    @property
    def normalized_id(self) -> str:
        return normalize_role_id(self.id)

    def all_lookup_names(self) -> tuple[str, ...]:
        return (self.id, *self.aliases)


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
        for soul_entry in role.soul:
            entry = self.skills.get(normalize_role_id(soul_entry.skill))
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
        """Render a role's soul prompt.

        The manifest ``soul`` list is the portable agent identity, composed
        first. ``extra_skills`` are host-supplied layer skills (Multicode
        product skills, Sprint Engine quality norms) appended after the soul so
        a pack author never has to reference them. A missing manifest skill is a
        hard render error (the soul is broken); a missing ``extra_skills`` entry
        is a warning and is skipped, since host layers must degrade rather than
        block a spawn.
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

        for soul_entry in role.soul:
            skill_id = normalize_role_id(soul_entry.skill)
            entry = self.skills.get(skill_id)
            if entry is None or not isinstance(entry.value, SkillDocument):
                warning = RegistryWarning(
                    code="missing_render_skill",
                    message=f"Role {role.id!r} cannot render because skill {soul_entry.skill!r} is missing or invalid.",
                    role_id=role.id,
                    skill_id=soul_entry.skill,
                )
                raise SoulRenderError(warning.message, (*self.warnings, warning))
            body = entry.value.body.strip()
            if body:
                content_parts.append(_wrap_skill_envelope(skill_id, body))

        seen_skill_ids = {normalize_role_id(soul_entry.skill) for soul_entry in role.soul}
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
            for soul_entry in role.soul:
                skill_id = normalize_role_id(soul_entry.skill)
                if skill_id not in skills:
                    warnings.append(
                        RegistryWarning(
                            code="missing_referenced_skill",
                            message=f"Role {role.id!r} references missing skill {soul_entry.skill!r}.",
                            path=entry.source.path,
                            role_id=role.id,
                            skill_id=soul_entry.skill,
                            source_layer=entry.source.layer.name,
                        )
                    )


def discover_role_registry(
    *,
    workspace_root: Path | None = None,
    plugin_roots: Iterable[Path | str | PluginRegistryRoot | Mapping[str, Any]] = (),
    user_root: Path | None = None,
    bundled_root: Path | None = None,
) -> RegistryDiscovery:
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
    if role_id is None or label is None:
        warnings.append(_role_warning("invalid_role_manifest", "Role manifest requires string id and label.", path, layer))
        return None

    aliases = raw.get("aliases", [])
    if aliases is None:
        aliases = []
    if not isinstance(aliases, list) or any(not isinstance(alias, str) or not alias.strip() for alias in aliases):
        warnings.append(_role_warning("invalid_role_manifest", "Role aliases must be a list of non-empty strings.", path, layer, role_id))
        return None

    soul = raw.get("soul")
    if not isinstance(soul, list) or not soul:
        warnings.append(_role_warning("invalid_role_manifest", "Role soul must be a non-empty list.", path, layer, role_id))
        return None

    soul_entries: list[SoulSkillEntry] = []
    for index, entry in enumerate(soul):
        if not isinstance(entry, dict):
            warnings.append(_role_warning("invalid_soul_entry", f"Soul entry {index} must be an object.", path, layer, role_id))
            return None
        skill = entry.get("skill")
        if not isinstance(skill, str) or not skill.strip() or set(entry) != {"skill"}:
            warnings.append(
                _role_warning(
                    "invalid_soul_entry",
                    f"Soul entry {index} must contain only a non-empty skill string.",
                    path,
                    layer,
                    role_id,
                )
            )
            return None
        soul_entries.append(SoulSkillEntry(skill=normalize_role_id(skill)))

    summary = raw.get("summary")
    icon = raw.get("icon")
    if summary is not None and not isinstance(summary, str):
        warnings.append(_role_warning("invalid_role_manifest", "Role summary must be a string when present.", path, layer, role_id))
        return None
    if icon is not None and not isinstance(icon, str):
        warnings.append(_role_warning("invalid_role_manifest", "Role icon must be a string when present.", path, layer, role_id))
        return None
    capabilities = raw.get("capabilities", [])
    if capabilities is None:
        capabilities = []
    parsed_capabilities = _parse_role_capabilities(capabilities)
    if parsed_capabilities is None:
        warnings.append(
            _role_warning(
                "invalid_role_manifest",
                "Role capabilities must be a list of capability objects.",
                path,
                layer,
                role_id,
            )
        )
        return None

    return RoleManifest(
        id=normalize_role_id(role_id),
        label=label.strip(),
        aliases=tuple(alias.strip() for alias in aliases),
        summary=summary.strip() if isinstance(summary, str) and summary.strip() else None,
        icon=icon.strip() if isinstance(icon, str) and icon.strip() else None,
        soul=tuple(soul_entries),
        capabilities=tuple(parsed_capabilities),
    )


def _parse_role_capabilities(raw: Any) -> list[RoleCapability] | None:
    if not isinstance(raw, list):
        return None
    parsed: list[RoleCapability] = []
    for entry in raw:
        if not isinstance(entry, dict):
            return None
        kind = entry.get("kind")
        if kind != "review":
            return None
        allowed_keys = {"kind", "phase", "reviews", "defaultFocus"}
        if any(key not in allowed_keys for key in entry):
            return None
        phase = entry.get("phase", "review")
        if not isinstance(phase, str) or phase.strip() not in {"review", "testing", "product"}:
            return None
        reviews = entry.get("reviews", [])
        if reviews is None:
            reviews = []
        if not isinstance(reviews, list):
            return None
        normalized_reviews: list[str] = []
        for review in reviews:
            if not isinstance(review, str) or CAPABILITY_TAG_PATTERN.fullmatch(review) is None:
                return None
            normalized_reviews.append(review)
        default_focus = entry.get("defaultFocus")
        if default_focus is not None and not isinstance(default_focus, str):
            return None
        parsed.append(
            RoleCapability(
                kind="review",
                phase=phase.strip(),
                reviews=tuple(normalized_reviews),
                default_focus=default_focus.strip() if isinstance(default_focus, str) and default_focus.strip() else None,
            )
        )
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
