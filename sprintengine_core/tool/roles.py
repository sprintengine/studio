"""Role compatibility registry for the Sprint Engine CLI.

This is intentionally small: the current runtime still uses the bundled role
set, but command and parser code should validate roles through this seam rather
than copying hardcoded role sets into each command module.
"""

from __future__ import annotations

from typing import Iterable


BUNDLED_ROLE_IDS = frozenset({
    "architect",
    "product",
    "developer",
    "frontend",
    "tester",
    "security",
    "code_reviewer",
    "spec_reviewer",
    "performance",
})


class RoleRegistry:
    """Read-only compatibility registry for the currently bundled roles."""

    def __init__(self, role_ids: Iterable[str] = BUNDLED_ROLE_IDS) -> None:
        self._role_ids = frozenset(str(role_id) for role_id in role_ids)

    def all(self) -> frozenset[str]:
        return self._role_ids

    def choices(self) -> list[str]:
        return sorted(self._role_ids)

    def is_valid(self, role: str) -> bool:
        return role in self._role_ids

    def without(self, *role_ids: str) -> frozenset[str]:
        return self._role_ids - set(role_ids)


DEFAULT_ROLE_REGISTRY = RoleRegistry()
VALID_ROLES = DEFAULT_ROLE_REGISTRY.all()
PLAN_REVIEW_ROLES = DEFAULT_ROLE_REGISTRY.without("architect")
