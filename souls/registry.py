from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


SOULS_ROOT = Path(__file__).resolve().parent
PROMPTS_DIR = SOULS_ROOT / "prompts"


@dataclass(frozen=True)
class Soul:
    role: str
    label: str
    file_name: str
    aliases: tuple[str, ...] = ()


SOULS: tuple[Soul, ...] = (
    Soul("architect", "Architect", "architect.md"),
    Soul("product", "Product", "product.md", ("product-strategist",)),
    Soul("developer", "Developer", "developer.md"),
    Soul("devops", "DevOps", "devops.md", ("devops-infra",)),
    Soul("frontend", "Frontend", "frontend.md", ("frontend-design-review",)),
    Soul("tester", "Tester", "tester.md", ("qa-test",)),
    Soul("security", "Security", "security.md", ("security-review",)),
    Soul("code_reviewer", "Code Reviewer", "code_reviewer.md", ("code-review", "code-reviewer")),
    Soul("performance", "Performance", "performance.md", ("performance-engineer",)),
)


def _normalize_role(value: str) -> str:
    return value.strip().lower().replace("-", "_")


def get_soul(role: str) -> Soul:
    normalized = _normalize_role(role)
    for soul in SOULS:
        if soul.role == normalized:
            return soul
        if normalized in {_normalize_role(alias) for alias in soul.aliases}:
            return soul
    known = ", ".join(soul.role for soul in SOULS)
    raise KeyError(f"Unknown Soul role: {role}. Known roles: {known}.")


def list_souls() -> list[Soul]:
    return list(SOULS)


def soul_path(role: str) -> Path:
    soul = get_soul(role)
    return PROMPTS_DIR / soul.file_name


def render_soul(role: str) -> str:
    path = soul_path(role)
    if not path.exists():
        raise FileNotFoundError(f"Soul prompt file missing for role {get_soul(role).role}: {path}")
    return path.read_text(encoding="utf-8").strip()


def validate_souls() -> list[str]:
    errors: list[str] = []
    for soul in SOULS:
        path = PROMPTS_DIR / soul.file_name
        if not path.exists():
            errors.append(f"{soul.role}: missing {path}")
            continue
        if not path.read_text(encoding="utf-8").strip():
            errors.append(f"{soul.role}: empty {path}")
    return errors
