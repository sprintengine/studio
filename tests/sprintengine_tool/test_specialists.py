from __future__ import annotations

from pathlib import Path

import pytest

from sprintengine_core.schema import SPECIALIST_ROLES
from sprintengine_core.specialists import (
    FORBIDDEN_EXECUTION_PROMPT_ROOT,
    PROMPT_ROOT,
    get_specialist_role,
    list_specialist_role_refs,
    list_specialist_roles,
    read_specialist_prompt,
    validate_specialist_prompts,
)


REPO_ROOT = Path(__file__).resolve().parents[2]


def test_registry_covers_every_canonical_execution_role() -> None:
    roles = list_specialist_roles()

    assert [role.id for role in roles] == list(SPECIALIST_ROLES)
    assert {role.id for role in roles} == {
        "architect",
        "product",
        "developer",
        "frontend",
        "tester",
        "security",
        "code_reviewer",
        "performance",
        "devops",
    }
    assert all(role.label for role in roles)
    assert all(role.stop_conditions for role in roles)


def test_every_registry_prompt_path_points_to_existing_specialist_prompt() -> None:
    roles = list_specialist_roles()

    assert validate_specialist_prompts(REPO_ROOT) == []
    for role in roles:
        prompt_path = Path(role.prompt_path)
        assert not prompt_path.is_absolute()
        assert prompt_path.parts[0] == PROMPT_ROOT
        assert FORBIDDEN_EXECUTION_PROMPT_ROOT not in prompt_path.parts
        assert (REPO_ROOT / prompt_path).is_file()


def test_registry_records_expected_artifact_kinds_and_serializable_refs() -> None:
    refs = list_specialist_role_refs()
    refs_by_id = {role_ref.id: role_ref.to_dict() for role_ref in refs}

    assert refs_by_id["architect"]["expectedArtifactKinds"] == ["architect_plan"]
    assert refs_by_id["product"]["expectedArtifactKinds"] == [
        "product_strategy",
        "requirements",
    ]
    assert refs_by_id["frontend"]["promptPath"] == (
        "specialist-prompts/frontend-design-promt.md"
    )
    assert refs_by_id["security"]["expectedArtifactKinds"] == ["security_review"]
    assert refs_by_id["code_reviewer"]["expectedArtifactKinds"] == ["code_review"]
    assert refs_by_id["performance"]["expectedArtifactKinds"] == [
        "performance_review"
    ]
    assert refs_by_id["devops"]["expectedArtifactKinds"] == ["validation_report"]
    assert "expectedArtifactKinds" not in refs_by_id["developer"]


def test_prompt_reader_uses_specialist_prompts_not_multiloop_agent_souls(
    tmp_path: Path,
) -> None:
    specialist_prompt = tmp_path / "specialist-prompts" / "developer-prompt.md"
    specialist_prompt.parent.mkdir(parents=True)
    specialist_prompt.write_text("hardened developer prompt", encoding="utf-8")
    multiloop_prompt = tmp_path / "multiloop-agent-souls" / "developer-prompt.md"
    multiloop_prompt.parent.mkdir(parents=True)
    multiloop_prompt.write_text("wrong multiloop prompt", encoding="utf-8")

    assert read_specialist_prompt("developer", tmp_path) == "hardened developer prompt"


def test_registry_rejects_unknown_roles() -> None:
    with pytest.raises(KeyError, match="Unknown Sprint Engine specialist role"):
        get_specialist_role("coordinator")
