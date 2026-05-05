"""Canonical Sprint Engine specialist role registry."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .schema import SPECIALIST_ROLES, SpecialistRoleRef

PROMPT_ROOT = "specialist-prompts"
FORBIDDEN_EXECUTION_PROMPT_ROOT = "multiloop-agent-souls"


@dataclass(frozen=True, slots=True)
class SpecialistRole:
    """Execution role metadata used to launch a specialist agent."""

    id: str
    label: str
    prompt_path: str
    expected_artifact_kinds: tuple[str, ...]
    stop_conditions: tuple[str, ...]

    def to_ref(self) -> SpecialistRoleRef:
        return SpecialistRoleRef(
            id=self.id,
            label=self.label,
            prompt_path=self.prompt_path,
            expected_artifact_kinds=list(self.expected_artifact_kinds),
            stop_conditions=list(self.stop_conditions),
        )


_ROLE_DEFINITIONS: tuple[SpecialistRole, ...] = (
    SpecialistRole(
        id="architect",
        label="Architect",
        prompt_path="specialist-prompts/architect-prompt.md",
        expected_artifact_kinds=("architect_plan",),
        stop_conditions=("Write the approved execution plan and task graph, then stop.",),
    ),
    SpecialistRole(
        id="product",
        label="Product Strategist",
        prompt_path="specialist-prompts/product-strategist-prompt.md",
        expected_artifact_kinds=("product_strategy", "requirements"),
        stop_conditions=("Publish product requirements or strategy for approval, then stop.",),
    ),
    SpecialistRole(
        id="developer",
        label="Developer",
        prompt_path="specialist-prompts/developer-prompt.md",
        expected_artifact_kinds=(),
        stop_conditions=("Complete exactly one implementation task with evidence, then stop.",),
    ),
    SpecialistRole(
        id="frontend",
        label="Frontend Designer",
        prompt_path="specialist-prompts/frontend-design-promt.md",
        expected_artifact_kinds=("html_mockup", "design_notes", "branding"),
        stop_conditions=("Produce the requested UI work or artifact with evidence, then stop.",),
    ),
    SpecialistRole(
        id="tester",
        label="QA Tester",
        prompt_path="specialist-prompts/qa-test-prompt.md",
        expected_artifact_kinds=("validation_report",),
        stop_conditions=("Publish validation evidence or a validation report, then stop.",),
    ),
    SpecialistRole(
        id="security",
        label="Security Reviewer",
        prompt_path="specialist-prompts/security-review-prompt.md",
        expected_artifact_kinds=("security_review",),
        stop_conditions=("Publish concrete security findings or approval, then stop.",),
    ),
    SpecialistRole(
        id="code_reviewer",
        label="Code Reviewer",
        prompt_path="specialist-prompts/code-reviewer-pre-prompt.md",
        expected_artifact_kinds=("code_review",),
        stop_conditions=("Publish concrete review findings or approval, then stop.",),
    ),
    SpecialistRole(
        id="performance",
        label="Performance Engineer",
        prompt_path="specialist-prompts/performance-engineer-prompt.md",
        expected_artifact_kinds=("performance_review",),
        stop_conditions=("Publish measured performance findings or approval, then stop.",),
    ),
    SpecialistRole(
        id="devops",
        label="DevOps Engineer",
        prompt_path="specialist-prompts/devops-infra-prompt.md",
        expected_artifact_kinds=("validation_report",),
        stop_conditions=("Complete exactly one infrastructure task with evidence, then stop.",),
    ),
)

_ROLES_BY_ID = {role.id: role for role in _ROLE_DEFINITIONS}

if tuple(_ROLES_BY_ID) != SPECIALIST_ROLES:
    raise RuntimeError("Sprint Engine specialist registry does not match schema roles")


def list_specialist_roles() -> list[SpecialistRole]:
    """Return canonical execution roles in schema order."""

    return list(_ROLE_DEFINITIONS)


def list_specialist_role_refs() -> list[SpecialistRoleRef]:
    """Return JSON-serializable role references for Sprint Engine state output."""

    return [role.to_ref() for role in _ROLE_DEFINITIONS]


def get_specialist_role(role_id: str) -> SpecialistRole:
    """Return metadata for one canonical execution role."""

    try:
        return _ROLES_BY_ID[role_id]
    except KeyError as exc:
        raise KeyError(f"Unknown Sprint Engine specialist role: {role_id}") from exc


def read_specialist_prompt(role_id: str, repo_root: Path | str | None = None) -> str:
    """Read the hardened execution prompt for a role from `specialist-prompts`."""

    role = get_specialist_role(role_id)
    prompt_path = _resolve_prompt_path(role.prompt_path, repo_root)
    return prompt_path.read_text(encoding="utf-8")


def validate_specialist_prompts(repo_root: Path | str | None = None) -> list[str]:
    """Return missing prompt paths for the canonical registry."""

    missing: list[str] = []
    for role in _ROLE_DEFINITIONS:
        prompt_path = _resolve_prompt_path(role.prompt_path, repo_root)
        if not prompt_path.is_file():
            missing.append(role.prompt_path)
    return missing


def _resolve_prompt_path(prompt_path: str, repo_root: Path | str | None) -> Path:
    path = Path(prompt_path)
    parts = path.parts
    if path.is_absolute() or not parts or parts[0] != PROMPT_ROOT:
        raise ValueError(f"Specialist prompt path must be under {PROMPT_ROOT}: {prompt_path}")
    if FORBIDDEN_EXECUTION_PROMPT_ROOT in parts:
        raise ValueError(
            "Sprint Engine execution prompts must not use "
            f"{FORBIDDEN_EXECUTION_PROMPT_ROOT}: {prompt_path}"
        )

    root = Path.cwd() if repo_root is None else Path(repo_root)
    return root / path
